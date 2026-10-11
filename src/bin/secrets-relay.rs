//! Usage: secrets-relay <socket-path>
//!
//! HTTP/1.0 on a unix socket (mode 0600); prints events to stdout as JSON lines, the first `{"ready": path,
//! "vault": "absent" | "locked"}` once it listens. The vault lives at `$XDG_DATA_HOME/secrets/vault`.
//!
//! For commands:
//! - `POST /ask {prompt, pid}`: prints `{"ask": {id, prompt, pid, cmdline, kind: "secret"}}`, then holds the request
//!   until answered: 200 with the secret as the body, or 403 when cancelled. A client that hangs up first prints
//!   `{"gone": id}`.
//! - `POST /get {tag, pid}`, `POST /list {pid}`: wait for the vault to be unlocked, then print `{"get": {id, tag, name,
//!   kind, use, allowed, pid, cmdline}}` or `{"list": {id, pid, cmdline}}` and wait for a decision: 200 with the
//!   value, or the entries as JSON (no values); 403 refused or not unlocked; 404 with a reason when there is nothing
//!   to hand out.
//! - `GET /watch`: every known value as a JSON string per line, then each new one, until the client hangs up; 403 to
//!   any client but `secrets-mask-run` as Claude Code starts it.
//!
//! For Claude Code only (the peer must be the relay's parent), 403 to anyone else:
//! - `POST /answer {id, secret}` or `{id, cancel: true}`: 204 taken, 410 no such ask. Unlocking asks the passphrase
//!   as an ask of `kind: "unlock"`; a wrong one asks again.
//! - `POST /unlock`: asks for the passphrase (or a new one twice, with no vault yet), unless already open or asking.
//! - `POST /decide {id, decision: "give" | "session" | "refuse"}`: 204, 410 no such request.
//! - `GET /vault`: `{state, entries, values}`; entries carry no values, `values` lists every one for masking.
//! - `POST /vault {op: "add" | "edit" | "delete" | "allow", …}`: 200 `{id}` after saving; 400 with a reason.
//!
//! `{"vault": "open"}` is printed when the vault opens and after each change; `{"trouble": text}` when the vault
//! can't be read or written.
//!
//! `<socket-path>.agent` is an ssh-agent offering the vault's ssh keys; each signature waits on a `get` decision as
//! `/get` does. With `$SECRETS_UPSTREAM_AGENT` set and forwarding switched on (`POST /vault {op: "forward", on}`),
//! it also offers that agent's keys and passes their signatures through.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use rustix::fs::Mode;
use secrets::agent;
use secrets::vault::{Costs, Entry, Kind, Use, Vault, random_hex};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use zeroize::Zeroizing;

const HEAD_MAX: usize = 65536;
const COSTS: Costs = Costs { memory_kib: 65536, time: 3, lanes: 1 };

/// What answers an ask.
enum Waiter {
    Ask { tx: oneshot::Sender<Option<String>>, prompt: String },
    Unlock,
    Create,
    CreateAgain(Zeroizing<String>),
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Decision {
    Give,
    Session,
    Refuse,
}

enum Locker {
    Absent,
    Locked,
    Open(Vault),
}

struct State {
    waiting: HashMap<String, Waiter>,
    deciding: HashMap<String, oneshot::Sender<Decision>>,
    known: Vec<String>,
    watchers: Vec<mpsc::UnboundedSender<String>>,
    vault: Locker,
    /// Entry ids allowed in this session.
    allowed: HashSet<String>,
    /// An unlock or create ask is out.
    unlocking: bool,
    unlock_waiters: Vec<oneshot::Sender<bool>>,
    /// Typed answers and their prompts, kept until the vault opens.
    typed: Vec<(String, Zeroizing<String>)>,
    /// The upstream agent's keys are offered too.
    forward: bool,
}

struct Context {
    state: Mutex<State>,
    mask_run: PathBuf,
    vault_path: PathBuf,
    upstream: Option<PathBuf>,
}

type Shared = Arc<Context>;

fn emit(event: &serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}").and_then(|()| out.flush());
}

fn note(message: &str) {
    let _ = writeln!(std::io::stderr(), "secrets-relay: {message}");
}

fn lock(ctx: &Context) -> std::sync::MutexGuard<'_, State> {
    ctx.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Records a value and sends it to every watcher still listening.
fn keep(state: &mut State, secret: &str) {
    if secret.is_empty() || state.known.iter().any(|k| k == secret) {
        return;
    }
    state.known.push(secret.to_owned());
    state.watchers.retain(|w| w.send(secret.to_owned()).is_ok());
}

fn cmdline_of(pid: i64) -> String {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|raw| String::from_utf8_lossy(&raw).replace('\0', " ").trim().to_owned())
        .unwrap_or_default()
}

fn parent_of(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

fn own_parent() -> Option<i32> {
    rustix::process::getppid().map(rustix::process::Pid::as_raw_pid)
}

/// The process right below Claude Code that `pid` descends from (the shell prefix, whose argv holds the command),
/// else `pid` itself.
fn below_claude_code(pid: i32) -> i32 {
    let Some(top) = own_parent() else { return pid };
    let mut at = pid;
    for _ in 0..64 {
        match parent_of(at) {
            Some(parent) if parent == top => return at,
            Some(parent) if parent > 1 => at = parent,
            _ => return pid,
        }
    }
    pid
}

fn peer_pid(stream: &UnixStream) -> Option<i32> {
    stream.peer_cred().ok()?.pid()
}

/// The peer is Claude Code, the relay's parent.
fn is_claude_code(stream: &UnixStream) -> bool {
    peer_pid(stream).is_some_and(|pid| Some(pid) == own_parent())
}

/// The peer is `secrets-mask-run` started by Claude Code, the relay's own parent. A command's processes run
/// below it, so none has that parent: an orphan goes to init or a user subreaper, and Claude Code isn't one.
fn is_mask_run(stream: &UnixStream, mask_run: &Path) -> bool {
    let Some(pid) = peer_pid(stream) else { return false };
    let parent = parent_of(pid);
    parent.is_some() && parent == own_parent() && std::fs::canonicalize(format!("/proc/{pid}/exe")).is_ok_and(|exe| exe == mask_run)
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

async fn read_request(stream: &mut UnixStream) -> Option<Request> {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = memchr::memmem::find(&raw, b"\r\n\r\n") {
            break end;
        }
        if raw.len() > HEAD_MAX {
            return None;
        }
        let n = stream.read(&mut buf).await.ok().filter(|n| *n > 0)?;
        raw.extend_from_slice(buf.get(..n)?);
    };
    let head = String::from_utf8_lossy(raw.get(..head_end)?).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, path) = (first.next()?.to_owned(), first.next()?.to_owned());
    let length = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = raw.get(head_end + 4..)?.to_vec();
    while body.len() < length {
        let n = stream.read(&mut buf).await.ok().filter(|n| *n > 0)?;
        body.extend_from_slice(buf.get(..n)?);
    }
    body.truncate(length);
    Some(Request { method, path, body })
}

async fn respond(stream: &mut UnixStream, status: &str, body: &[u8]) {
    let head = format!("HTTP/1.0 {status}\r\nContent-Length: {}\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

/// Resolves once the client hangs up (or sends anything, which none of ours does while waiting).
async fn hung_up(stream: &mut UnixStream) {
    let mut byte = [0u8; 1];
    let _ = stream.read(&mut byte).await;
}

/// Puts out a passphrase ask: unlocking, or the first or second entry of a new one.
fn ask_passphrase(state: &mut State, waiter: Waiter, prompt: &str) {
    let Ok(id) = random_hex::<16>() else {
        note("can't read /dev/urandom for an ask id");
        return fail_unlock(state);
    };
    state.waiting.insert(id.clone(), waiter);
    state.unlocking = true;
    emit(&json!({ "ask": { "id": id, "prompt": prompt, "pid": 0, "cmdline": "", "kind": "unlock" } }));
}

fn fail_unlock(state: &mut State) {
    state.unlocking = false;
    for waiter in state.unlock_waiters.drain(..) {
        let _ = waiter.send(false);
    }
}

fn start_unlock(state: &mut State) {
    if state.unlocking {
        return;
    }
    match state.vault {
        Locker::Open(_) => {}
        Locker::Locked => ask_passphrase(state, Waiter::Unlock, "Vault passphrase"),
        Locker::Absent => ask_passphrase(state, Waiter::Create, "New vault passphrase"),
    }
}

/// Adds a typed value as a `typed` entry unless some entry holds it already; false when nothing was added.
fn add_typed(vault: &mut Vault, prompt: String, value: &str) -> bool {
    if value.is_empty() || vault.entries.iter().any(|e| e.value == value) {
        return false;
    }
    let (Ok(id), Ok(tag)) = (random_hex::<8>(), random_hex::<3>()) else {
        emit(&json!({ "trouble": "vault: can't read /dev/urandom, so a typed value was not kept" }));
        return false;
    };
    vault.entries.push(Entry { id, name: prompt, tag: format!("typed-{tag}"), kind: Kind::Typed, use_: Use::Each, value: value.to_owned(), created: now() });
    true
}

fn save(ctx: &Context, vault: &Vault) -> Result<(), String> {
    vault.save(&ctx.vault_path).map_err(|error| {
        let text = format!("vault: can't save {}: {error}", ctx.vault_path.display());
        emit(&json!({ "trouble": text }));
        text
    })
}

fn opened(ctx: &Context, state: &mut State, mut vault: Vault) {
    let mut added = false;
    for (prompt, value) in std::mem::take(&mut state.typed) {
        added |= add_typed(&mut vault, prompt, &value);
    }
    for entry in &vault.entries {
        let value = entry.value.clone();
        keep(state, &value);
    }
    if added {
        let _ = save(ctx, &vault);
    }
    state.vault = Locker::Open(vault);
    state.unlocking = false;
    for waiter in state.unlock_waiters.drain(..) {
        let _ = waiter.send(true);
    }
    emit(&json!({ "vault": "open" }));
}

async fn try_open(ctx: Shared, passphrase: Zeroizing<String>, create: bool) {
    let path = ctx.vault_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        if create {
            let vault = Vault::create(passphrase.as_bytes(), COSTS)?;
            vault.save(&path).map(|()| vault)
        } else {
            Vault::open(&path, passphrase.as_bytes())
        }
    })
    .await;
    let mut state = lock(&ctx);
    match result {
        Ok(Ok(vault)) => opened(&ctx, &mut state, vault),
        Ok(Err(secrets::vault::Error::Refused)) => ask_passphrase(&mut state, Waiter::Unlock, "Vault passphrase: wrong, again"),
        Ok(Err(error)) => {
            emit(&json!({ "trouble": format!("vault: {}: {error}", ctx.vault_path.display()) }));
            fail_unlock(&mut state);
        }
        Err(error) => {
            emit(&json!({ "trouble": format!("vault: unlocking stopped: {error}") }));
            fail_unlock(&mut state);
        }
    }
}

#[derive(Deserialize)]
struct Ask {
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    pid: i64,
}

#[derive(Deserialize)]
struct Answer {
    id: String,
    secret: Option<String>,
    #[serde(default)]
    cancel: bool,
}

async fn ask(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let Ok(ask) = serde_json::from_slice::<Ask>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let Ok(id) = random_hex::<16>() else { return respond(stream, "500 Internal Server Error", b"").await };
    let (tx, rx) = oneshot::channel();
    lock(ctx).waiting.insert(id.clone(), Waiter::Ask { tx, prompt: ask.prompt.clone() });
    let cmdline = if ask.pid > 0 { cmdline_of(ask.pid) } else { String::new() };
    emit(&json!({ "ask": { "id": id, "prompt": ask.prompt, "pid": ask.pid, "cmdline": cmdline, "kind": "secret" } }));
    tokio::select! {
        answer = rx => match answer {
            Ok(Some(secret)) => respond(stream, "200 OK", secret.as_bytes()).await,
            _ => respond(stream, "403 Forbidden", b"").await,
        },
        () = hung_up(stream) => {
            lock(ctx).waiting.remove(&id);
            emit(&json!({ "gone": id }));
        }
    }
}

async fn answer(stream: &mut UnixStream, ctx: &Shared, body: &[u8]) {
    let Ok(answer) = serde_json::from_slice::<Answer>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let secret = if answer.cancel { None } else { Some(Zeroizing::new(answer.secret.unwrap_or_default())) };
    let is_taken = take_answer(ctx, &answer.id, secret);
    respond(stream, if is_taken { "204 No Content" } else { "410 Gone" }, b"").await;
}

/// Hands an answer to what waits on it; false when nothing does.
fn take_answer(ctx: &Shared, id: &str, secret: Option<Zeroizing<String>>) -> bool {
    let mut state = lock(ctx);
    let Some(waiter) = state.waiting.remove(id) else { return false };
    if let Some(secret) = &secret {
        keep(&mut state, secret);
    }
    match (waiter, secret) {
        (Waiter::Ask { tx, prompt }, Some(secret)) => {
            if let Locker::Open(vault) = &mut state.vault {
                if add_typed(vault, prompt, &secret) {
                    let _ = save(ctx, vault);
                }
            } else if !secret.is_empty() {
                state.typed.push((prompt, secret.clone()));
            }
            let _ = tx.send(Some(secret.to_string()));
        }
        (Waiter::Ask { tx, .. }, None) => {
            let _ = tx.send(None);
        }
        (_, None) => fail_unlock(&mut state),
        (Waiter::Unlock, Some(secret)) => {
            tokio::spawn(try_open(Arc::clone(ctx), secret, false));
        }
        (Waiter::Create, Some(secret)) => ask_passphrase(&mut state, Waiter::CreateAgain(secret), "New vault passphrase, again"),
        (Waiter::CreateAgain(first), Some(secret)) => {
            if *first == *secret {
                tokio::spawn(try_open(Arc::clone(ctx), secret, true));
            } else {
                ask_passphrase(&mut state, Waiter::Create, "Passphrases differed; new vault passphrase");
            }
        }
    }
    true
}

/// Waits for the vault to be open, asking to unlock it; the reason when it won't be.
async fn open_vault(ctx: &Context) -> Result<(), &'static str> {
    let rx = {
        let mut state = lock(ctx);
        match state.vault {
            Locker::Open(_) => return Ok(()),
            Locker::Absent => return Err("there is no vault yet"),
            Locker::Locked => {}
        }
        let (tx, rx) = oneshot::channel();
        state.unlock_waiters.push(tx);
        start_unlock(&mut state);
        rx
    };
    if rx.await == Ok(true) { Ok(()) } else { Err("the vault was not unlocked") }
}

/// Puts out `event` under a new decision id and waits for the hooks' decision; None when the client hung up.
async fn decide(stream: &mut UnixStream, ctx: &Context, name: &str, mut event: serde_json::Value) -> Option<Decision> {
    let Ok(id) = random_hex::<16>() else { return Some(Decision::Refuse) };
    let (tx, rx) = oneshot::channel();
    lock(ctx).deciding.insert(id.clone(), tx);
    if let Some(fields) = event.as_object_mut() {
        fields.insert("id".to_owned(), json!(id));
    }
    emit(&serde_json::Value::Object(serde_json::Map::from_iter([(name.to_owned(), event)])));
    tokio::select! {
        decision = rx => Some(decision.unwrap_or(Decision::Refuse)),
        () = hung_up(stream) => {
            lock(ctx).deciding.remove(&id);
            emit(&json!({ "gone": id }));
            None
        }
    }
}

#[derive(Deserialize)]
struct Get {
    #[serde(default)]
    tag: String,
    #[serde(default)]
    pid: i64,
}

async fn get(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let Ok(request) = serde_json::from_slice::<Get>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let opened = tokio::select! {
        opened = open_vault(ctx) => opened,
        () = hung_up(stream) => return,
    };
    if let Err(reason) = opened {
        return respond(stream, "403 Forbidden", reason.as_bytes()).await;
    }
    let found = {
        let state = lock(ctx);
        let Locker::Open(vault) = &state.vault else { return };
        vault.entries.iter().find(|e| e.tag == request.tag && e.kind != Kind::Typed).map(|e| (e.clone(), state.allowed.contains(&e.id)))
    };
    let Some((entry, allowed)) = found else {
        return respond(stream, "404 Not Found", format!("no entry tagged {}", request.tag).as_bytes()).await;
    };
    if entry.kind == Kind::SshKey {
        return respond(stream, "404 Not Found", format!("{} is an ssh key: ssh uses it through SSH_AUTH_SOCK", entry.tag).as_bytes()).await;
    }
    let cmdline = if request.pid > 0 { cmdline_of(request.pid) } else { String::new() };
    let event = json!({ "tag": entry.tag, "name": entry.name, "kind": entry.kind, "use": entry.use_, "allowed": allowed, "pid": request.pid, "cmdline": cmdline });
    match decide(stream, ctx, "get", event).await {
        None => {}
        Some(Decision::Refuse) => respond(stream, "403 Forbidden", b"").await,
        Some(decision) => {
            if decision == Decision::Session {
                lock(ctx).allowed.insert(entry.id.clone());
            }
            respond(stream, "200 OK", entry.value.as_bytes()).await;
        }
    }
}

async fn list(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let Ok(request) = serde_json::from_slice::<Get>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let opened = tokio::select! {
        opened = open_vault(ctx) => opened,
        () = hung_up(stream) => return,
    };
    if let Err(reason) = opened {
        return respond(stream, "403 Forbidden", reason.as_bytes()).await;
    }
    let cmdline = if request.pid > 0 { cmdline_of(request.pid) } else { String::new() };
    match decide(stream, ctx, "list", json!({ "pid": request.pid, "cmdline": cmdline })).await {
        None => {}
        Some(Decision::Refuse) => respond(stream, "403 Forbidden", b"").await,
        Some(_) => {
            let listed = {
                let state = lock(ctx);
                let Locker::Open(vault) = &state.vault else { return };
                vault
                    .entries
                    .iter()
                    .filter(|e| e.kind != Kind::Typed)
                    .map(|e| json!({ "tag": e.tag, "name": e.name, "kind": e.kind, "use": e.use_, "allowed": state.allowed.contains(&e.id) }))
                    .collect::<Vec<_>>()
            };
            respond(stream, "200 OK", json!(listed).to_string().as_bytes()).await;
        }
    }
}

async fn read_frame(stream: &mut UnixStream) -> Option<Vec<u8>> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.ok()?;
    let length = usize::try_from(u32::from_be_bytes(length)).ok().filter(|n| (1..=agent::FRAME_MAX).contains(n))?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await.ok()?;
    Some(body)
}

/// One request to the user's own agent; its reply's body, or None when it can't be reached.
async fn ask_upstream(path: &Path, body: &[u8]) -> Option<Vec<u8>> {
    let mut stream = UnixStream::connect(path).await.ok()?;
    stream.write_all(&agent::frame(body)).await.ok()?;
    read_frame(&mut stream).await
}

/// The open vault's ssh keys with their blobs; none while it is locked.
fn vault_keys(ctx: &Context) -> Vec<(Entry, ssh_key::PrivateKey, Vec<u8>)> {
    let state = lock(ctx);
    let Locker::Open(vault) = &state.vault else { return Vec::new() };
    let mut keys = Vec::new();
    for entry in vault.entries.iter().filter(|e| e.kind == Kind::SshKey) {
        match agent::parse_key(&entry.value).and_then(|key| Ok((agent::blob(&key)?, key))) {
            Ok((blob, key)) => keys.push((entry.clone(), key, blob)),
            Err(error) => note(&format!("ssh key {} is not offered: {error}", entry.tag)),
        }
    }
    keys
}

async fn serve_agent(mut stream: UnixStream, ctx: Shared) {
    let peer = peer_pid(&stream);
    while let Some(body) = read_frame(&mut stream).await {
        let reply = agent_reply(&mut stream, &ctx, peer, &body).await;
        if stream.write_all(&agent::frame(&reply)).await.is_err() {
            return;
        }
    }
}

async fn agent_reply(stream: &mut UnixStream, ctx: &Context, peer: Option<i32>, body: &[u8]) -> Vec<u8> {
    let upstream = if lock(ctx).forward { ctx.upstream.clone() } else { None };
    match agent::parse_request(body) {
        agent::Request::Identities => {
            let mut identities: Vec<(Vec<u8>, String)> = vault_keys(ctx).into_iter().map(|(entry, _, blob)| (blob, entry.name.clone())).collect();
            if let Some(path) = &upstream {
                let theirs = ask_upstream(path, body).await.and_then(|reply| agent::parse_identities_answer(&reply)).unwrap_or_default();
                for identity in theirs {
                    if !identities.iter().any(|(blob, _)| *blob == identity.0) {
                        identities.push(identity);
                    }
                }
            }
            agent::identities_answer(&identities)
        }
        agent::Request::Sign { blob, data, flags } => match vault_keys(ctx).into_iter().find(|(_, _, b)| *b == blob) {
            Some((entry, key, _)) => sign_with(stream, ctx, peer, &entry, &key, &data, flags).await,
            None => match &upstream {
                Some(path) => ask_upstream(path, body).await.unwrap_or_else(|| vec![agent::FAILURE]),
                None => vec![agent::FAILURE],
            },
        },
        agent::Request::Other => vec![agent::FAILURE],
    }
}

/// Signs with a vault key once the hooks give it, as for `/get`.
async fn sign_with(stream: &mut UnixStream, ctx: &Context, peer: Option<i32>, entry: &Entry, key: &ssh_key::PrivateKey, data: &[u8], flags: u32) -> Vec<u8> {
    let pid = peer.map_or(0, below_claude_code);
    let cmdline = if pid > 0 { cmdline_of(i64::from(pid)) } else { String::new() };
    let allowed = lock(ctx).allowed.contains(&entry.id);
    let event = json!({ "tag": entry.tag, "name": entry.name, "kind": entry.kind, "use": entry.use_, "allowed": allowed, "pid": pid, "cmdline": cmdline });
    let decision = decide(stream, ctx, "get", event).await;
    if decision == Some(Decision::Session) {
        lock(ctx).allowed.insert(entry.id.clone());
    }
    if !matches!(decision, Some(Decision::Give | Decision::Session)) {
        return vec![agent::FAILURE];
    }
    agent::sign(key, data, flags).map_or_else(
        |error| {
            note(&format!("can't sign with {}: {error}", entry.tag));
            vec![agent::FAILURE]
        },
        |signature| agent::sign_response(&signature),
    )
}

#[derive(Deserialize)]
struct Decide {
    id: String,
    decision: Decision,
}

async fn decided(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let Ok(request) = serde_json::from_slice::<Decide>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let Some(tx) = lock(ctx).deciding.remove(&request.id) else { return respond(stream, "410 Gone", b"").await };
    let _ = tx.send(request.decision);
    respond(stream, "204 No Content", b"").await;
}

async fn show_vault(stream: &mut UnixStream, ctx: &Context) {
    let mut shown = {
        let state = lock(ctx);
        match &state.vault {
            Locker::Absent => json!({ "state": "absent", "entries": [], "values": [] }),
            Locker::Locked => json!({ "state": "locked", "entries": [], "values": [] }),
            Locker::Open(vault) => {
                let entries: Vec<_> = vault
                    .entries
                    .iter()
                    .map(|e| json!({ "id": e.id, "name": e.name, "tag": e.tag, "kind": e.kind, "use": e.use_, "created": e.created, "allowed": state.allowed.contains(&e.id) }))
                    .collect();
                let values: Vec<_> = vault.entries.iter().map(|e| e.value.as_str()).collect();
                json!({ "state": "open", "entries": entries, "values": values })
            }
        }
    };
    if let Some(fields) = shown.as_object_mut() {
        fields.insert("forward".to_owned(), json!(lock(ctx).forward));
        fields.insert("upstream".to_owned(), json!(ctx.upstream.is_some()));
    }
    respond(stream, "200 OK", shown.to_string().as_bytes()).await;
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Change {
    Add { name: String, #[serde(default)] tag: String, kind: Kind, #[serde(rename = "use")] use_: Use, value: String },
    Edit { id: String, name: Option<String>, tag: Option<String>, kind: Option<Kind>, #[serde(rename = "use")] use_: Option<Use>, value: Option<String> },
    Delete { id: String },
    Allow { id: String, allowed: bool },
    Forward { on: bool },
}

/// An ssh key entry's value: the text of the unencrypted OpenSSH key file at `path` (`~/` is the home dir).
fn key_text(path: &str) -> Result<String, String> {
    let path = path.trim();
    let file = match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set, so ~/ can't be read")?).join(rest),
        None => PathBuf::from(path),
    };
    let text = std::fs::read_to_string(&file).map_err(|e| format!("can't read {}: {e}", file.display()))?;
    agent::parse_key(&text)?;
    Ok(text)
}

fn is_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

/// Applies a change to the open vault; the changed entry's id, or why not.
fn change(state: &mut State, change: Change) -> Result<String, String> {
    let State { vault: Locker::Open(vault), allowed, .. } = state else { return Err("the vault is not open".to_owned()) };
    let taken = |tag: &str, except: &str| vault.entries.iter().any(|e| e.tag == tag && e.id != except);
    let id = match change {
        Change::Add { name, tag, kind, use_, value } => {
            let tag = if tag.is_empty() { format!("{}-{}", json!(kind).as_str().unwrap_or("entry"), random_hex::<3>().map_err(|e| e.to_string())?) } else { tag };
            if !is_tag(&tag) || taken(&tag, "") {
                return Err(format!("tag {tag} is taken or not made of letters, digits, - _ ."));
            }
            let value = if kind == Kind::SshKey { key_text(&value)? } else { value };
            let id = random_hex::<8>().map_err(|e| e.to_string())?;
            vault.entries.push(Entry { id: id.clone(), name, tag, kind, use_, value, created: now() });
            id
        }
        Change::Edit { id, name, tag, kind, use_, value } => {
            if let Some(tag) = &tag
                && (!is_tag(tag) || taken(tag, &id))
            {
                return Err(format!("tag {tag} is taken or not made of letters, digits, - _ ."));
            }
            let entry = vault.entries.iter_mut().find(|e| e.id == id).ok_or("no such entry")?;
            let is_key = kind.unwrap_or(entry.kind) == Kind::SshKey;
            let value = match value {
                Some(path) if is_key => Some(key_text(&path)?),
                Some(value) => Some(value),
                None if is_key => Some(key_text_kept(&entry.value)?),
                None => None,
            };
            if let Some(name) = name {
                entry.name = name;
            }
            if let Some(tag) = tag {
                entry.tag = tag;
            }
            entry.kind = kind.unwrap_or(entry.kind);
            entry.use_ = use_.unwrap_or(entry.use_);
            if let Some(value) = value {
                entry.value = value;
            }
            id
        }
        Change::Delete { id } => {
            let at = vault.entries.iter().position(|e| e.id == id).ok_or("no such entry")?;
            vault.entries.remove(at);
            allowed.remove(&id);
            id
        }
        Change::Allow { id, allowed: on } => {
            if !vault.entries.iter().any(|e| e.id == id) {
                return Err("no such entry".to_owned());
            }
            if on { allowed.insert(id.clone()) } else { allowed.remove(&id) };
            id
        }
        Change::Forward { .. } => return Err("forwarding is not an entry change".to_owned()),
    };
    Ok(id)
}

/// An entry's value kept as an ssh key: it must already be one.
fn key_text_kept(value: &str) -> Result<String, String> {
    agent::parse_key(value).map(|_| value.to_owned()).map_err(|e| format!("the kept value is no ssh key ({e}); give a key file"))
}

async fn change_vault(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let parsed = serde_json::from_slice::<Change>(body);
    let result = parsed.map_err(|e| format!("not a change: {e}")).and_then(|parsed| {
        let mut state = lock(ctx);
        if let Change::Forward { on } = parsed {
            if on && ctx.upstream.is_none() {
                return Err("there is no ssh-agent of yours to forward to".to_owned());
            }
            state.forward = on;
            return Ok("forward".to_owned());
        }
        let id = change(&mut state, parsed)?;
        let Locker::Open(vault) = &state.vault else { return Err("the vault is not open".to_owned()) };
        save(ctx, vault)?;
        let values: Vec<String> = vault.entries.iter().map(|e| e.value.clone()).collect();
        for value in values {
            keep(&mut state, &value);
        }
        Ok(id)
    });
    match result {
        Ok(id) => {
            emit(&json!({ "vault": "open" }));
            respond(stream, "200 OK", json!({ "id": id }).to_string().as_bytes()).await;
        }
        Err(reason) => respond(stream, "400 Bad Request", reason.as_bytes()).await,
    }
}

async fn watch(stream: &mut UnixStream, ctx: &Context) {
    if !is_mask_run(stream, &ctx.mask_run) {
        return respond(stream, "403 Forbidden", b"").await;
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let known = {
        let mut state = lock(ctx);
        state.watchers.push(tx);
        state.known.clone()
    };
    if stream.write_all(b"HTTP/1.0 200 OK\r\n\r\n").await.is_err() {
        return;
    }
    for secret in known {
        if stream.write_all(format!("{}\n", json!(secret)).as_bytes()).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            secret = rx.recv() => {
                let Some(secret) = secret else { return };
                if stream.write_all(format!("{}\n", json!(secret)).as_bytes()).await.is_err() {
                    return;
                }
            }
            () = hung_up(stream) => return,
        }
    }
}

async fn serve(mut stream: UnixStream, ctx: Shared) {
    let Some(request) = read_request(&mut stream).await else { return };
    let route = (request.method.as_str(), request.path.as_str());
    let for_claude_code = matches!(route, ("POST", "/answer" | "/unlock" | "/decide" | "/vault") | ("GET", "/vault"));
    if for_claude_code && !is_claude_code(&stream) {
        return respond(&mut stream, "403 Forbidden", b"").await;
    }
    match route {
        ("POST", "/ask") => ask(&mut stream, &ctx, &request.body).await,
        ("POST", "/get") => get(&mut stream, &ctx, &request.body).await,
        ("POST", "/list") => list(&mut stream, &ctx, &request.body).await,
        ("GET", "/watch") => watch(&mut stream, &ctx).await,
        ("POST", "/answer") => answer(&mut stream, &ctx, &request.body).await,
        ("POST", "/unlock") => {
            start_unlock(&mut lock(&ctx));
            respond(&mut stream, "204 No Content", b"").await;
        }
        ("POST", "/decide") => decided(&mut stream, &ctx, &request.body).await,
        ("GET", "/vault") => show_vault(&mut stream, &ctx).await,
        ("POST", "/vault") => change_vault(&mut stream, &ctx, &request.body).await,
        _ => respond(&mut stream, "404 Not Found", b"").await,
    }
}

fn vault_path() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|home| PathBuf::from(home).join(".local/share")))?;
    Some(data.join("secrets").join("vault"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [path] = args.as_slice() else {
        note("usage: secrets-relay <socket-path>");
        return ExitCode::from(2);
    };
    if let Err(error) = rustix::process::set_dumpable_behavior(rustix::process::DumpableBehavior::NotDumpable) {
        note(&format!("can't make this process non-dumpable: {error}"));
        return ExitCode::FAILURE;
    }
    let mask_run = match std::env::current_exe().and_then(|exe| std::fs::canonicalize(exe.with_file_name("secrets-mask-run"))) {
        Ok(path) => path,
        Err(error) => {
            note(&format!("can't find secrets-mask-run beside this binary: {error}"));
            return ExitCode::FAILURE;
        }
    };
    let Some(vault_path) = vault_path() else {
        note("neither XDG_DATA_HOME nor HOME is set, so the vault has nowhere to live");
        return ExitCode::FAILURE;
    };
    let vault = if vault_path.exists() { Locker::Locked } else { Locker::Absent };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            note(&format!("can't start: {error}"));
            return ExitCode::FAILURE;
        }
    };
    let agent_path = format!("{path}.agent");
    let upstream = std::env::var_os("SECRETS_UPSTREAM_AGENT").filter(|p| !p.is_empty()).map(PathBuf::from);
    runtime.block_on(async move {
        let old = rustix::process::umask(Mode::from_raw_mode(0o177));
        let bound = [path.as_str(), agent_path.as_str()].map(|p| {
            let _ = std::fs::remove_file(p);
            UnixListener::bind(p).map_err(|error| format!("can't listen on {p}: {error}"))
        });
        rustix::process::umask(old);
        let (listener, agent_listener) = match bound {
            [Ok(listener), Ok(agent_listener)] => (listener, agent_listener),
            [Err(error), _] | [_, Err(error)] => {
                note(&error);
                return ExitCode::FAILURE;
            }
        };
        let Ok(mut terminate) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) else {
            note("can't watch for SIGTERM");
            return ExitCode::FAILURE;
        };
        let shown = if matches!(vault, Locker::Absent) { "absent" } else { "locked" };
        emit(&json!({ "ready": path, "vault": shown }));
        let state = State {
            waiting: HashMap::new(),
            deciding: HashMap::new(),
            known: Vec::new(),
            watchers: Vec::new(),
            vault,
            allowed: HashSet::new(),
            unlocking: false,
            unlock_waiters: Vec::new(),
            typed: Vec::new(),
            forward: false,
        };
        let ctx = Arc::new(Context { state: Mutex::new(state), mask_run, vault_path, upstream });
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        tokio::spawn(serve(stream, Arc::clone(&ctx)));
                    }
                }
                accepted = agent_listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        tokio::spawn(serve_agent(stream, Arc::clone(&ctx)));
                    }
                }
                _ = terminate.recv() => break,
            }
        }
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(&agent_path);
        ExitCode::SUCCESS
    })
}
