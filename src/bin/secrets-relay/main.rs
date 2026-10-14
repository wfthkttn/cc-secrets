//! Usage: secrets-relay daemon [--socket PATH] | secrets-relay attach
//!
//! `daemon`: the vault and the requests of every Claude Code session, one per user. It listens on the socket systemd
//! passes it, else on PATH (default `$XDG_RUNTIME_DIR/secrets.sock`), where only `attach` is served (`session.rs`).
//! The vault lives at `$XDG_DATA_HOME/secrets/vault`. It ends on SIGTERM.
//!
//! `attach`: run by the hooks. Attaches its parent, Claude Code, to the daemon at `$SECRETS_DAEMON` (default
//! `$XDG_RUNTIME_DIR/secrets.sock`), with `$SECRETS_UPSTREAM_AGENT` as the user's own ssh-agent, and prints the
//! session's events to stdout as JSON lines until the daemon hangs up; exits 1 with a line on stderr when it can't
//! attach. The first event is `{"ready": socket, "agent": path, "vault": "absent" | "locked" | "open", "bin": dir}`:
//! the session's socket, its ssh-agent, and the directory of the helpers the daemon pins (`pinned`), its
//! `secrets-mask-run` the only one it serves.
//!
//! On a session's socket (HTTP/1.0, mode 0600), for commands; `pid` and `cmdline` in the events name the requester by
//! its peer credentials: the `secrets-mask-run` it runs under (`inside: true`), else the requesting process itself;
//! `live` lists the command lines of the session's calls whose output runs through the daemon then:
//! - `POST /ask {prompt, tag?}`: prints `{"ask": {id, prompt, tag, entry, pid, cmdline, inside, live}}`, `entry`
//!   being the open vault's entry tagged `tag` (no value) or null, then holds the request until answered: 200 with
//!   the value, 403 when cancelled. A client that hangs up first prints `{"gone": id}`.
//! - `POST /list`: 403 while the vault is closed; else prints `{"list": {id, pid, cmdline, inside, live}}` and waits
//!   for a decision: 200 with the entries as JSON (no values), 403 refused.
//! - `POST /filter`: for `secrets-mask-run` as the session's Claude Code starts it, 403 to anyone else; a call's
//!   output stream (`secrets::filter`), masked with what that call was handed and the open vault's values.
//!
//! For the session's Claude Code only (the peer must be the attach's parent), 403 to anyone else:
//! - `POST /answer {id, secret}`, `{id, entry, session}` or `{id, cancel: true}`.
//! - `POST /unlock {passphrase}`, `POST /create {passphrase}`: 204 open, 403 wrong passphrase.
//! - `POST /lock`: the vault closes for every session.
//! - `POST /passphrase {passphrase}`: the open vault sealed under a new passphrase (`locker::rekey`).
//! - `POST /session {id, projects?}`: whose grants and forwarding these are (`session_named`).
//! - `POST /decide {id, decision: "give" | "session" | "refuse"}`: 204, 410 no such request.
//! - `GET /vault`: `{state, entries, suggestions, forward, upstream}`; never a value. Each entry, like those in `ask`
//!   and `sign` events and `/list`, carries the session's `access`: `"ask" | "allowed" | "refused"`.
//! - `POST /vault {op: "add" | "edit" | "delete" | "access" | "save" | "dismiss" | "forward", …}`: 200 `{id}`; 400
//!   with a reason.
//! - `POST /settings {maskMinLength}`: 204.
//! - `POST /mask {texts}`: `{texts}` with the open vault's values masked. `POST /check {texts}`: `{label}`, the
//!   entry one of the texts carries, or null.
//!
//! Every session is told `{"vault": state}` after each change to the vault or to a session's grants,
//! `{"masked": true}` the first time anything was masked in a session, `{"masking": bool}` when `/mask` starts or
//! stops having values to mask, and `{"trouble": text}` when the vault or the grants can't be written.

mod access;
mod filter;
mod locker;
mod pass;
mod peer;
mod session;
mod ssh;

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use rustix::fs::Mode;
use secrets::vault::{Costs, random_hex};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::session::{Deciding, Id};

const HEAD_MAX: usize = 65536;
/// The largest request body: `/mask` carries whole tool results.
const BODY_MAX: usize = 32 << 20;
/// A request's head, and then its body, must arrive within this.
const REQUEST_WITHIN: std::time::Duration = std::time::Duration::from_secs(30);
/// How often the daemon looks for sessions whose Claude Code process is gone.
const SESSION_CHECK: std::time::Duration = std::time::Duration::from_secs(2);
const COSTS: Costs = Costs { memory_kib: 65536, time: 3, lanes: 1 };
/// Masking's shortest value until the hooks send theirs.
const MASK_MIN: usize = 6;
/// What runs from `bin`: the shell prefix, the CLI on PATH, the askpass helpers.
const HELPERS: [&str; 6] =
    ["secrets-mask-run", "secrets", "secrets-askpass", "secrets-askpass-sudo", "secrets-askpass-ssh", "secrets-askpass-git"];

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Decision {
    Give,
    Session,
    Refuse,
}

struct State {
    vault: locker::Locker,
    filter: filter::Filter,
    sessions: HashMap<Id, session::Session>,
    next_session: Id,
    /// Numbers each attach, so one that ended knows whether a later one took its session's events over.
    next_attach: u64,
}

struct Context {
    state: Mutex<State>,
    /// This daemon's own executable: an attach must run it.
    exe: PathBuf,
    mask_run: PathBuf,
    /// The directory of the helpers it serves, for the hooks.
    bin: Option<String>,
    /// The daemon's socket; each session's sockets are named after it.
    socket: PathBuf,
    vault_path: PathBuf,
    /// Each session's grants (`access`), beside the vault.
    sessions_dir: PathBuf,
}

type Shared = Arc<Context>;

fn emit(event: &serde_json::Value) {
    session::tell_all(event);
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

/// A request's head, and the body bytes that came with it.
struct Head {
    method: String,
    path: String,
    length: usize,
    started: Zeroizing<Vec<u8>>,
}

async fn read_head(stream: &mut UnixStream) -> Option<Head> {
    let mut buf = Zeroizing::new([0u8; 4096]);
    // Sized for the largest head up front: a growing Vec would leave unwiped copies behind.
    let mut raw = Zeroizing::new(Vec::with_capacity(HEAD_MAX + buf.len()));
    let head_end = loop {
        if let Some(end) = memchr::memmem::find(&raw, b"\r\n\r\n") {
            break end;
        }
        if raw.len() > HEAD_MAX {
            return None;
        }
        let n = stream.read(buf.as_mut()).await.ok().filter(|n| *n > 0)?;
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
    let started = Zeroizing::new(raw.get(head_end + 4..)?.to_vec());
    Some(Head { method, path, length, started })
}

async fn read_body(stream: &mut UnixStream, head: Head) -> Option<Zeroizing<Vec<u8>>> {
    let mut body = Zeroizing::new(Vec::with_capacity(head.length.max(head.started.len())));
    body.extend_from_slice(&head.started);
    let mut buf = Zeroizing::new([0u8; 4096]);
    while body.len() < head.length {
        let wanted = buf.len().min(head.length - body.len());
        let n = stream.read(buf.get_mut(..wanted)?).await.ok().filter(|n| *n > 0)?;
        body.extend_from_slice(buf.get(..n)?);
    }
    body.truncate(head.length);
    Some(body)
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

/// Tells the session `event` under a new decision id and waits for its hooks' decision; None when the client hung up.
/// Refused when the session ends first.
async fn decide(stream: &mut UnixStream, ctx: &Context, session: Id, name: &str, mut event: serde_json::Value) -> Option<Decision> {
    let Ok(id) = random_hex::<16>() else { return Some(Decision::Refuse) };
    let (tx, rx) = oneshot::channel();
    if let Some(fields) = event.as_object_mut() {
        fields.insert("id".to_owned(), json!(id));
    }
    let event = serde_json::Value::Object(serde_json::Map::from_iter([(name.to_owned(), event)]));
    {
        let mut state = lock(ctx);
        let Some(open) = state.sessions.get_mut(&session) else { return Some(Decision::Refuse) };
        session::tell(session, &event);
        open.deciding.insert(id.clone(), Deciding { tx, event });
    }
    tokio::select! {
        decision = rx => Some(decision.unwrap_or(Decision::Refuse)),
        () = hung_up(stream) => {
            if let Some(open) = lock(ctx).sessions.get_mut(&session) {
                open.deciding.remove(&id);
            }
            session::tell(session, &json!({ "gone": id }));
            None
        }
    }
}

#[derive(Deserialize)]
struct Decide {
    id: String,
    decision: Decision,
}

async fn decided(stream: &mut UnixStream, ctx: &Context, session: Id, body: &[u8]) {
    let Ok(request) = serde_json::from_slice::<Decide>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let waiting = lock(ctx).sessions.get_mut(&session).and_then(|s| s.deciding.remove(&request.id));
    let Some(Deciding { tx, .. }) = waiting else { return respond(stream, "410 Gone", b"").await };
    let _ = tx.send(request.decision);
    respond(stream, "204 No Content", b"").await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    mask_min_length: usize,
}

#[derive(Deserialize)]
struct Named {
    id: String,
    /// Claude Code's transcripts folder; given, the grants of sessions that can't be resumed are removed.
    projects: Option<PathBuf>,
}

/// `POST /session {id, projects?}`: the session's grants are now Claude Code session `id`'s, as kept in its file;
/// 204, 400 with the reason.
async fn session_named(stream: &mut UnixStream, ctx: &Shared, session: Id, body: &[u8]) {
    let Ok(Named { id, projects }) = serde_json::from_slice::<Named>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let access = match access::Access::load(&ctx.sessions_dir, &id) {
        Ok(access) => access,
        Err(reason) => return respond(stream, "400 Bad Request", reason.as_bytes()).await,
    };
    let named = {
        let mut state = lock(ctx);
        if let Some(open) = state.sessions.get_mut(&session) {
            open.access = access;
            open.named = Some(id);
        }
        locker::prune(&mut state);
        emit(&json!({ "vault": state.vault.shown() }));
        state.sessions.contains_key(&session).then(|| state.sessions.values().filter_map(|s| s.named.clone()).collect::<Vec<_>>())
    };
    let Some(named) = named else { return respond(stream, "410 Gone", b"the session ended").await };
    respond(stream, "204 No Content", b"").await;
    if let Some(projects) = projects {
        let dir = ctx.sessions_dir.clone();
        let swept = tokio::task::spawn_blocking(move || access::sweep(&dir, &projects, &named)).await;
        match swept {
            Ok(Ok(removed)) if !removed.is_empty() => note(&format!("removed the grants of ended sessions: {}", removed.join(", "))),
            Ok(Ok(_)) => {}
            Ok(Err(error)) => note(&format!("can't remove the grants of ended sessions: {error}")),
            Err(error) => note(&format!("removing the grants of ended sessions stopped: {error}")),
        }
    }
}

async fn json_reply(stream: &mut UnixStream, reply: Option<serde_json::Value>) {
    match reply {
        Some(reply) => respond(stream, "200 OK", reply.to_string().as_bytes()).await,
        None => respond(stream, "400 Bad Request", b"").await,
    }
}

/// Serves the session's socket until the session ends.
async fn accept(listener: UnixListener, ctx: Shared, session: Id) {
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(serve(stream, ctx.clone(), session));
    }
}

async fn serve(mut stream: UnixStream, ctx: Shared, session: Id) {
    let Ok(Some(head)) = tokio::time::timeout(REQUEST_WITHIN, read_head(&mut stream)).await else { return };
    let (method, path) = (head.method.clone(), head.path.clone());
    let route = (method.as_str(), path.as_str());
    let Some(claude_code) = lock(&ctx).sessions.get(&session).map(|s| s.claude_code) else {
        return respond(&mut stream, "410 Gone", b"the session ended").await;
    };
    let for_claude_code = !matches!(route, ("POST", "/ask" | "/list" | "/filter"));
    if for_claude_code && !peer::is_claude_code(&stream, claude_code) {
        return respond(&mut stream, "403 Forbidden", b"").await;
    }
    if head.length > BODY_MAX {
        return respond(&mut stream, "413 Content Too Large", b"").await;
    }
    let Ok(Some(body)) = tokio::time::timeout(REQUEST_WITHIN, read_body(&mut stream, head)).await else { return };
    let body = body.as_slice();
    match route {
        ("POST", "/ask") => pass::ask(&mut stream, &ctx, session, body).await,
        ("POST", "/list") => locker::list(&mut stream, &ctx, session).await,
        ("POST", "/filter") => filter::serve(&mut stream, &ctx, session).await,
        ("POST", "/answer") => pass::answer(&mut stream, &ctx, session, body).await,
        ("POST", "/unlock") => locker::open(&mut stream, &ctx, body, false).await,
        ("POST", "/create") => locker::open(&mut stream, &ctx, body, true).await,
        ("POST", "/lock") => locker::close(&mut stream, &ctx).await,
        ("POST", "/passphrase") => locker::rekey(&mut stream, &ctx, body).await,
        ("POST", "/session") => session_named(&mut stream, &ctx, session, body).await,
        ("POST", "/decide") => decided(&mut stream, &ctx, session, body).await,
        ("GET", "/vault") => {
            let shown = locker::show(&lock(&ctx), session);
            respond(&mut stream, "200 OK", shown.to_string().as_bytes()).await;
        }
        ("POST", "/vault") => locker::change_vault(&mut stream, &ctx, session, body).await,
        ("POST", "/settings") => match serde_json::from_slice::<Settings>(body) {
            Ok(settings) if settings.mask_min_length > 0 => {
                lock(&ctx).filter.set_min_length(settings.mask_min_length);
                respond(&mut stream, "204 No Content", b"").await;
            }
            _ => respond(&mut stream, "400 Bad Request", b"").await,
        },
        ("POST", "/mask") => {
            let reply = filter::mask_texts(&ctx, claude_code, body);
            json_reply(&mut stream, reply).await;
        }
        ("POST", "/check") => {
            let reply = {
                let state = lock(&ctx);
                filter::check_texts(state.vault.entries(), state.filter.min_length(), body)
            };
            json_reply(&mut stream, reply).await;
        }
        _ => respond(&mut stream, "404 Not Found", b"").await,
    }
}

/// The daemon's own socket serves only `attach`.
async fn serve_daemon(mut stream: UnixStream, ctx: Shared) {
    let Ok(Some(head)) = tokio::time::timeout(REQUEST_WITHIN, read_head(&mut stream)).await else { return };
    if (head.method.as_str(), head.path.as_str()) != ("POST", "/attach") {
        return respond(&mut stream, "404 Not Found", b"").await;
    }
    if head.length > HEAD_MAX {
        return respond(&mut stream, "413 Content Too Large", b"").await;
    }
    let Ok(Some(body)) = tokio::time::timeout(REQUEST_WITHIN, read_body(&mut stream, head)).await else { return };
    session::attach(stream, ctx, &body).await;
}

fn vault_path() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|home| PathBuf::from(home).join(".local/share")))?;
    Some(data.join("secrets").join("vault"))
}

/// `$SECRETS_DAEMON`, else `$XDG_RUNTIME_DIR/secrets.sock`.
fn daemon_socket() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("SECRETS_DAEMON").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()).ok_or("neither SECRETS_DAEMON nor XDG_RUNTIME_DIR is set")?;
    Ok(PathBuf::from(runtime).join("secrets.sock"))
}

/// A directory removed, with what it holds, when the daemon ends.
struct Removed(PathBuf);

impl Drop for Removed {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The helpers the sessions' commands run: those beside the daemon where nothing can change them (a read-only
/// filesystem, the Nix store), else copies in `copies`, so a rebuild in a working copy doesn't swap them under it.
/// The `secrets-mask-run` among them.
fn pinned(mask_run: &Path, copies: &Path) -> std::io::Result<PathBuf> {
    let Some(dir) = mask_run.parent() else { return Ok(mask_run.to_owned()) };
    if rustix::fs::statvfs(dir).is_ok_and(|fs| fs.f_flag.contains(rustix::fs::StatVfsMountFlags::RDONLY)) {
        return Ok(mask_run.to_owned());
    }
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(copies)?;
    for helper in HELPERS {
        std::fs::copy(dir.join(helper), copies.join(helper))?;
    }
    std::fs::canonicalize(copies.join("secrets-mask-run"))
}

/// The socket systemd passed, else a fresh bind of `path` (mode 0600); true when bound here, so the file is ours to
/// remove.
fn listener(path: &Path) -> Result<(UnixListener, bool), String> {
    let mut passed = listenfd::ListenFd::from_env();
    if let Some(listener) = passed.take_unix_listener(0).map_err(|e| format!("can't take the socket systemd passed: {e}"))? {
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        return UnixListener::from_std(listener).map(|l| (l, false)).map_err(|e| e.to_string());
    }
    if std::os::unix::net::UnixStream::connect(path).is_ok() {
        return Err(format!("another daemon answers on {}", path.display()));
    }
    let _ = std::fs::remove_file(path);
    let old = rustix::process::umask(Mode::from_raw_mode(0o177));
    let bound = UnixListener::bind(path).map_err(|error| format!("can't listen on {}: {error}", path.display()));
    rustix::process::umask(old);
    bound.map(|l| (l, true))
}

fn daemon(socket: Option<PathBuf>) -> ExitCode {
    if let Err(error) = rustix::process::set_dumpable_behavior(rustix::process::DumpableBehavior::NotDumpable) {
        note(&format!("can't make this process non-dumpable: {error}"));
        return ExitCode::FAILURE;
    }
    let exe = match std::env::current_exe().and_then(std::fs::canonicalize) {
        Ok(path) => path,
        Err(error) => {
            note(&format!("can't find this binary: {error}"));
            return ExitCode::FAILURE;
        }
    };
    let socket = match socket.map_or_else(daemon_socket, Ok) {
        Ok(path) => path,
        Err(error) => {
            note(error);
            return ExitCode::FAILURE;
        }
    };
    let copies = Removed(PathBuf::from(format!("{}.bin", socket.display())));
    let mask_run = match std::fs::canonicalize(exe.with_file_name("secrets-mask-run")).and_then(|found| pinned(&found, &copies.0)) {
        Ok(path) => path,
        Err(error) => {
            note(&format!("can't pin the helpers beside this binary in {}: {error}", copies.0.display()));
            return ExitCode::FAILURE;
        }
    };
    let Some(vault_path) = vault_path() else {
        note("neither XDG_DATA_HOME nor HOME is set, so the vault has nowhere to live");
        return ExitCode::FAILURE;
    };
    let vault = if vault_path.exists() { locker::Locker::Locked } else { locker::Locker::Absent };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            note(&format!("can't start: {error}"));
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async move {
        let (listener, is_ours) = match listener(&socket) {
            Ok(bound) => bound,
            Err(error) => {
                note(&error);
                return ExitCode::FAILURE;
            }
        };
        let Ok(mut terminate) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) else {
            note("can't watch for SIGTERM");
            return ExitCode::FAILURE;
        };
        let bin = mask_run.parent().map(|dir| dir.display().to_string());
        let state = State { vault, filter: filter::Filter::new(MASK_MIN), sessions: HashMap::new(), next_session: 0, next_attach: 0 };
        let sessions_dir = vault_path.with_file_name("sessions");
        let ctx = Arc::new(Context { state: Mutex::new(state), exe, mask_run, bin, socket: socket.clone(), vault_path, sessions_dir });
        let mut checks = tokio::time::interval(SESSION_CHECK);
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        tokio::spawn(serve_daemon(stream, Arc::clone(&ctx)));
                    }
                }
                _ = terminate.recv() => break,
                _ = checks.tick() => session::end_gone(&mut lock(&ctx)),
            }
        }
        lock(&ctx).sessions.clear();
        if is_ours {
            let _ = std::fs::remove_file(&socket);
        }
        ExitCode::SUCCESS
    })
}

fn attach() -> ExitCode {
    let fail = |message: &str| {
        let _ = writeln!(std::io::stderr(), "secrets-relay attach: {message}");
        ExitCode::FAILURE
    };
    let path = match daemon_socket() {
        Ok(path) => path,
        Err(error) => return fail(error),
    };
    let upstream = std::env::var("SECRETS_UPSTREAM_AGENT").unwrap_or_default();
    let body = json!({ "upstream": upstream }).to_string();
    let mut stream = match std::os::unix::net::UnixStream::connect(&path) {
        Ok(stream) => stream,
        Err(error) => return fail(&format!("no secrets daemon on {} ({error})", path.display())),
    };
    if let Err(error) = write!(stream, "POST /attach HTTP/1.0\r\nContent-Length: {}\r\n\r\n{body}", body.len()) {
        return fail(&format!("the daemon on {} can't be reached ({error})", path.display()));
    }
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > HEAD_MAX || stream.read_exact(&mut byte).is_err() {
            return fail("the daemon sent no answer");
        }
        head.extend_from_slice(&byte);
    }
    let status = String::from_utf8_lossy(head.split(|b| *b == b' ').nth(1).unwrap_or_default()).into_owned();
    if status != "200" {
        let mut reason = String::new();
        let _ = stream.read_to_string(&mut reason);
        return fail(&format!("the daemon refused ({status}): {reason}"));
    }
    let mut out = std::io::stdout().lock();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => return ExitCode::SUCCESS,
            Ok(n) => {
                if out.write_all(buf.get(..n).unwrap_or_default()).and_then(|()| out.flush()).is_err() {
                    return ExitCode::SUCCESS;
                }
            }
            Err(error) => return fail(&format!("reading the daemon's events stopped: {error}")),
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["daemon"] => daemon(None),
        ["daemon", "--socket", path] => daemon(Some(PathBuf::from(path))),
        ["attach"] => attach(),
        _ => {
            note("usage: secrets-relay daemon [--socket PATH] | secrets-relay attach");
            ExitCode::from(2)
        }
    }
}
