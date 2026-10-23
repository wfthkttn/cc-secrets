//! Usage: secrets-relay daemon [--socket PATH] [--log PATH] | secrets-relay attach
//!
//! `daemon`: the vault and the requests of every Claude Code session, one per user. It listens on the socket systemd
//! or launchd passes it, else on PATH (default `$XDG_RUNTIME_DIR/secrets.sock`, on macOS `$TMPDIR/secrets.sock`, on
//! Windows `%LOCALAPPDATA%\secrets.sock`), where only `attach` is served (`session.rs`). The vault lives at
//! `$XDG_DATA_HOME/secrets/vault`, on Windows `%LOCALAPPDATA%\secrets\vault`. It ends on SIGTERM. On Windows it has
//! no console, so run by hand it shows nothing: `--log` (Windows only) appends its notes to PATH; it ends by being
//! killed.
//!
//! `attach`: run by the hooks. Attaches its parent, Claude Code, to the daemon at `$SECRETS_DAEMON` (default as
//! above), with `$SECRETS_UPSTREAM_AGENT` as the user's own ssh-agent, and prints the
//! session's events to stdout as JSON lines until the daemon hangs up; exits 1 with a line on stderr when it can't
//! attach. The first event is `{"ready": socket, "agent": path, "vault": "absent" | "locked" | "open", "bin": dir}`:
//! the session's socket, its ssh-agent, and the directory of the helpers the daemon pins (`pinned`), its
//! `secrets-mask-run` the only one it serves.
//!
//! On a session's socket (HTTP/1.0, mode 0600 on Unix), for commands; `pid` and `cmdline` in the events name the requester by
//! its peer credentials: the `secrets-mask-run` it runs under (`inside: true`; on Windows also by the call's job),
//! else the requesting process itself; `live` lists the command lines of the session's calls whose output runs
//! through the daemon then:
//! - `POST /ask {prompt, tag?}`: prints `{"ask": {id, prompt, tag, entry, pid, cmdline, inside, live}}`, `entry`
//!   being the open vault's entry tagged `tag` (no value) or null, then holds the request until answered: 200 with
//!   the value, 403 when cancelled. A client that hangs up first prints `{"gone": id}`.
//! - `POST /filter`, on Windows `{job}`, mask-run's handle to the job it joined (`secrets::job`): for
//!   `secrets-mask-run` as the session's Claude Code starts it, 409 on Windows to a process inside one of the
//!   session's calls (that call masks its output), 403 to anyone else; a call's output stream (`secrets::filter`),
//!   masked with what that call was handed and the open vault's values.
//!
//! For the session's Claude Code only (the peer must be the attach's parent), 403 to anyone else:
//! - `POST /answer {id, secret}`, `{id, entry, session}` or `{id, cancel: true}`.
//! - `POST /unlock {passphrase}`, `POST /create {passphrase}`: 204 open, 403 wrong passphrase.
//! - `POST /lock`: the vault closes for every session.
//! - `POST /passphrase {passphrase}`: the open vault sealed under a new passphrase (`locker::rekey`).
//! - `POST /session {id, projects?}`: whose grants and forwarding these are (`session_named`).
//! - `POST /decide {id, decision: "give" | "session" | "refuse"}`: 204, 410 no such request.
//! - `GET /vault`: `{state, entries, suggestions, forward, upstream}`; never a value. Each entry, like those in `ask`
//!   events and `sign` events with `forwarded: false`, carries the session's `access`: `"ask" | "allowed" |
//!   "refused"`. A `sign` event with `forwarded: true` is for a key of the user's own agent and names no entry.
//! - `POST /vault {op: "add" | "edit" | "delete" | "access" | "save" | "dismiss" | "forward", …}`: 200 `{id}`; 400
//!   with a reason.
//! - `POST /settings {maskMinLength}`: 204.
//! - `POST /mask {texts}`: `{texts}` with the open vault's values masked. `POST /check {texts}`: `{label}`, the
//!   entry one of the texts carries, or null.
//!
//! Every session is told `{"vault": state}` after each change to the vault or to a session's grants,
//! `{"masked": true}` the first time anything was masked in a session, `{"masking": bool}` when `/mask` starts or
//! stops having values to mask, and `{"trouble": text}` when the vault or the grants can't be written.

// A logon task starts the daemon, and a console program would open a window there; the attach reaches the hooks
// through the pipes they start it with all the same.
#![cfg_attr(windows, windows_subsystem = "windows")]

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

#[cfg(unix)]
use rustix::fs::Mode;
use secrets::vault::{Costs, random_hex};
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use secrets::local::{Listener, Stream};
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
/// The `Sockets` entry of the launchd job that holds the daemon's socket.
#[cfg(target_os = "macos")]
const LAUNCHD_SOCKET: &std::ffi::CStr = c"secrets";

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

async fn read_head(stream: &mut Stream) -> Option<Head> {
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

async fn read_body(stream: &mut Stream, head: Head) -> Option<Zeroizing<Vec<u8>>> {
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

async fn respond(stream: &mut Stream, status: &str, body: &[u8]) {
    let head = format!("HTTP/1.0 {status}\r\nContent-Length: {}\r\n\r\n", body.len());
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
}

/// Resolves once the client hangs up (or sends anything, which none of ours does while waiting).
async fn hung_up(stream: &mut Stream) {
    let mut byte = [0u8; 1];
    let _ = stream.read(&mut byte).await;
}

/// Tells the session `event` under a new decision id and waits for its hooks' decision; None when the client hung up.
/// Refused when the session ends first.
async fn decide(stream: &mut Stream, ctx: &Context, session: Id, name: &str, mut event: serde_json::Value) -> Option<Decision> {
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

async fn decided(stream: &mut Stream, ctx: &Context, session: Id, body: &[u8]) {
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
async fn session_named(stream: &mut Stream, ctx: &Shared, session: Id, body: &[u8]) {
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

async fn json_reply(stream: &mut Stream, reply: Option<serde_json::Value>) {
    match reply {
        Some(reply) => respond(stream, "200 OK", reply.to_string().as_bytes()).await,
        None => respond(stream, "400 Bad Request", b"").await,
    }
}

/// The session a vault change came from, as the daemon's log names it.
fn requester(ctx: &Context, session: Id, claude_code: i32) -> String {
    let named = lock(ctx).sessions.get(&session).and_then(|s| s.named.clone());
    format!("Claude Code pid {claude_code}, session {}", named.as_deref().unwrap_or("not named yet"))
}

/// Serves the session's socket until the session ends.
async fn accept(mut listener: Listener, ctx: Shared, session: Id) {
    while let Ok(stream) = listener.accept().await {
        tokio::spawn(serve(stream, ctx.clone(), session));
    }
}

async fn serve(mut stream: Stream, ctx: Shared, session: Id) {
    let Ok(Some(head)) = tokio::time::timeout(REQUEST_WITHIN, read_head(&mut stream)).await else { return };
    let (method, path) = (head.method.clone(), head.path.clone());
    let route = (method.as_str(), path.as_str());
    let Some(claude_code) = lock(&ctx).sessions.get(&session).map(|s| s.claude_code) else {
        return respond(&mut stream, "410 Gone", b"the session ended").await;
    };
    let for_claude_code = !matches!(route, ("POST", "/ask" | "/filter"));
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
        ("POST", "/filter") => filter::serve(&mut stream, &ctx, session, body).await,
        ("POST", "/answer") => pass::answer(&mut stream, &ctx, session, body).await,
        ("POST", "/unlock") => locker::open(&mut stream, &ctx, body, false, &requester(&ctx, session, claude_code)).await,
        ("POST", "/create") => locker::open(&mut stream, &ctx, body, true, &requester(&ctx, session, claude_code)).await,
        ("POST", "/lock") => locker::close(&mut stream, &ctx, &requester(&ctx, session, claude_code)).await,
        ("POST", "/passphrase") => locker::rekey(&mut stream, &ctx, body, &requester(&ctx, session, claude_code)).await,
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
async fn serve_daemon(mut stream: Stream, ctx: Shared) {
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

#[cfg(unix)]
fn vault_path() -> Result<PathBuf, &'static str> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or("neither XDG_DATA_HOME nor HOME is set, so the vault has nowhere to live")?;
    Ok(data.join("secrets").join("vault"))
}

#[cfg(windows)]
fn vault_path() -> Result<PathBuf, &'static str> {
    let data = local_app_data().ok_or("LOCALAPPDATA is not set, so the vault has nowhere to live")?;
    Ok(data.join("secrets").join("vault"))
}

#[cfg(windows)]
fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `$SECRETS_DAEMON`, else `$XDG_RUNTIME_DIR/secrets.sock`.
#[cfg(target_os = "linux")]
fn daemon_socket() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("SECRETS_DAEMON").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()).ok_or("neither SECRETS_DAEMON nor XDG_RUNTIME_DIR is set")?;
    Ok(PathBuf::from(runtime).join("secrets.sock"))
}

/// `$SECRETS_DAEMON`, else `$TMPDIR/secrets.sock`: macOS's per-user private directory.
#[cfg(target_os = "macos")]
fn daemon_socket() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("SECRETS_DAEMON").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let runtime = std::env::var_os("TMPDIR").filter(|v| !v.is_empty()).ok_or("neither SECRETS_DAEMON nor TMPDIR is set")?;
    Ok(PathBuf::from(runtime).join("secrets.sock"))
}

/// `$SECRETS_DAEMON`, else `%LOCALAPPDATA%\secrets.sock`, not in `%TEMP%`, which disk cleanup empties.
#[cfg(windows)]
fn daemon_socket() -> Result<PathBuf, &'static str> {
    if let Some(path) = std::env::var_os("SECRETS_DAEMON").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(local_app_data().ok_or("neither SECRETS_DAEMON nor LOCALAPPDATA is set")?.join("secrets.sock"))
}

/// A directory removed, with what it holds, when the daemon ends.
#[cfg(unix)]
struct Removed(PathBuf);

#[cfg(unix)]
impl Drop for Removed {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A helper's file name: with `.exe` on Windows.
fn executable_name(helper: &str) -> String {
    format!("{helper}{}", std::env::consts::EXE_SUFFIX)
}

/// The helpers the sessions' commands run: those beside the daemon where nothing can change them (a read-only
/// filesystem, the Nix store), else copies in `copies`, so a rebuild in a working copy doesn't swap them under it.
/// The `secrets-mask-run` among them.
fn pinned(mask_run: &Path, copies: &Path) -> std::io::Result<PathBuf> {
    let Some(dir) = mask_run.parent() else { return Ok(mask_run.to_owned()) };
    #[cfg(unix)]
    if rustix::fs::statvfs(dir).is_ok_and(|fs| fs.f_flag.contains(rustix::fs::StatVfsMountFlags::RDONLY)) {
        return Ok(mask_run.to_owned());
    }
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700).create(copies)?;
    #[cfg(windows)]
    std::fs::create_dir_all(copies)?;
    // Left when this build was once superseded: kept, the next build's daemon would remove the folder at once, not
    // `LEFTOVER_AGE` later.
    #[cfg(windows)]
    match std::fs::remove_file(copies.join("superseded")) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    for helper in HELPERS.map(executable_name) {
        #[cfg(unix)]
        std::fs::copy(dir.join(&helper), copies.join(&helper))?;
        // The folder is these helpers' (`copies_dir`): one there is the same file, maybe running now. Copied under
        // another name first, so a copy cut short is never taken for one.
        #[cfg(windows)]
        if !copies.join(&helper).exists() {
            let part = copies.join(format!("{helper}.part"));
            std::fs::copy(dir.join(&helper), &part)?;
            std::fs::rename(&part, copies.join(&helper))?;
        }
    }
    std::fs::canonicalize(copies.join(executable_name("secrets-mask-run")))
}

/// A socket file this daemon bound, removed when it ends.
struct Bound(Option<PathBuf>);

impl Drop for Bound {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Where this daemon copies its helpers.
#[cfg(unix)]
#[allow(clippy::unnecessary_wraps, reason = "the same signature as on Windows")]
fn copies_dir(socket: &Path, _exe: &Path) -> std::io::Result<PathBuf> {
    Ok(PathBuf::from(format!("{}.bin", socket.display())))
}

/// Where this daemon copies its helpers: a folder named for this daemon's and its helpers' files (name, size, time
/// written), as Windows won't replace a running executable. A later start with the same files takes it as it is
/// (`pinned`); a folder of other files goes in `sweep_leftovers`.
#[cfg(windows)]
fn copies_dir(socket: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    use sha2::Digest as _;
    let dir = exe.parent().ok_or_else(|| std::io::Error::other(format!("{} has no folder", exe.display())))?;
    let mut files = sha2::Sha256::new();
    for path in std::iter::once(exe.to_owned()).chain(HELPERS.map(|helper| dir.join(executable_name(helper)))) {
        let file = std::fs::metadata(&path)?;
        let at = file.modified()?.duration_since(std::time::UNIX_EPOCH).map_err(std::io::Error::other)?;
        files.update(format!("{}\0{}\0{}\0", path.display(), file.len(), at.as_nanos()));
    }
    let digest = files.finalize();
    let id = digest.first_chunk::<8>().map(|first| u64::from_be_bytes(*first)).ok_or_else(|| std::io::Error::other("a SHA-256 shorter than 8 bytes"))?;
    Ok(PathBuf::from(format!("{}.bin-{id:016x}", socket.display())))
}

/// How long an earlier build's helpers stay once a later build's daemon first finds them: a session that hasn't
/// attached to that daemon yet still runs its commands through them, unmasked, while they are there.
#[cfg(windows)]
const LEFTOVER_AGE: std::time::Duration = std::time::Duration::from_hours(24);

/// Removes what earlier daemons left beside the socket, which a killed one doesn't remove and Windows keeps across
/// logons: their sessions' sockets, and earlier builds' helpers `LEFTOVER_AGE` after a later build's daemon first
/// found them, which a `superseded` file in their folder records. Only once this daemon holds the socket, so none of
/// it is a running daemon's. A folder a command still runs a helper from stays until a later start: Windows won't
/// move a folder while a file in it is open, so it is moved aside first and removed only then.
#[cfg(windows)]
fn sweep_leftovers(socket: &Path, copies: &Path) {
    let Some(name) = socket.file_name().map(|name| name.to_string_lossy().into_owned()) else { return };
    let Some(Ok(entries)) = socket.parent().map(std::fs::read_dir) else { return };
    let is_hex = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit());
    for entry in entries.flatten() {
        let (found, path) = (entry.file_name().to_string_lossy().into_owned(), entry.path());
        let Some(rest) = found.strip_prefix(name.as_str()) else { continue };
        if let Some(build) = rest.strip_prefix(".bin-") {
            let (id, gone) = build.strip_suffix(".gone").map_or((build, false), |id| (id, true));
            if id.len() != 16 || !is_hex(id) || path == copies {
                continue;
            }
            if gone {
                let _ = std::fs::remove_dir_all(&path);
                continue;
            }
            let superseded = path.join("superseded");
            let Ok(since) = std::fs::metadata(&superseded).and_then(|m| m.modified()) else {
                let _ = std::fs::File::create(&superseded);
                continue;
            };
            if since.elapsed().is_ok_and(|age| age > LEFTOVER_AGE) {
                let aside = path.with_file_name(format!("{found}.gone"));
                if std::fs::rename(&path, &aside).is_ok() {
                    let _ = std::fs::remove_dir_all(&aside);
                }
            }
        } else if let Some(session) = rest.strip_prefix('-') {
            let id = session.strip_suffix(".agent").unwrap_or(session);
            if id.len() == 16 && is_hex(id) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// A path as other programs take it. Canonical paths on Windows are verbatim (`\\?\C:\…`), which Git Bash can't run
/// from.
fn shown(path: &Path) -> String {
    let shown = path.display().to_string();
    #[cfg(windows)]
    if let Some(rest) = shown.strip_prefix(r"\\?\").filter(|rest| rest.get(1..2) == Some(":")) {
        return rest.to_owned();
    }
    shown
}

/// The socket systemd passed, if any.
#[cfg(target_os = "linux")]
fn passed_listener() -> Result<Option<std::os::unix::net::UnixListener>, String> {
    let mut passed = listenfd::ListenFd::from_env();
    passed.take_unix_listener(0).map_err(|e| format!("can't take the socket systemd passed: {e}"))
}

/// The socket launchd holds for this job, if launchd started it: its plist's `Sockets` entry `LAUNCHD_SOCKET`.
#[cfg(target_os = "macos")]
fn passed_listener() -> Result<Option<std::os::unix::net::UnixListener>, String> {
    use std::os::fd::FromRawFd as _;

    unsafe extern "C" {
        fn launch_activate_socket(name: *const std::ffi::c_char, fds: *mut *mut std::ffi::c_int, cnt: *mut usize) -> std::ffi::c_int;
    }
    let mut fds: *mut std::ffi::c_int = std::ptr::null_mut();
    let mut count = 0usize;
    // SAFETY: the name is NUL-terminated; on success launchd points `fds` at `count` descriptors it allocated.
    let error = unsafe { launch_activate_socket(LAUNCHD_SOCKET.as_ptr(), &raw mut fds, &raw mut count) };
    if error == libc::ESRCH {
        return Ok(None);
    }
    if error != 0 {
        return Err(format!("can't take the socket launchd holds: {}", std::io::Error::from_raw_os_error(error)));
    }
    // SAFETY: launchd handed over `count` open descriptors at `fds`, which this process now owns.
    let owned: Vec<std::os::fd::OwnedFd> = (0..count).map(|i| unsafe { std::os::fd::OwnedFd::from_raw_fd(*fds.add(i)) }).collect();
    // SAFETY: `fds` came from launchd's malloc and is read no more.
    unsafe { libc::free(fds.cast()) };
    let mut owned = owned.into_iter();
    match (owned.next(), owned.next()) {
        (Some(fd), None) => Ok(Some(std::os::unix::net::UnixListener::from(fd))),
        _ => Err(format!("launchd passed {count} sockets for {LAUNCHD_SOCKET:?}, not one")),
    }
}

/// The socket the service manager passed, else a fresh bind of `path` (mode 0600 on Unix). Inside the tokio runtime.
fn listener(path: &Path) -> Result<(Listener, Bound), String> {
    #[cfg(unix)]
    if let Some(listener) = passed_listener()? {
        return Listener::from_std(listener).map(|l| (l, Bound(None))).map_err(|e| e.to_string());
    }
    if secrets::local::connect_blocking(path).is_ok() {
        return Err(format!("another daemon answers on {}", path.display()));
    }
    let _ = std::fs::remove_file(path);
    #[cfg(unix)]
    let old = rustix::process::umask(Mode::from_raw_mode(0o177));
    let bound = Listener::bind(path).map_err(|error| format!("can't listen on {}: {error}", path.display()));
    #[cfg(unix)]
    rustix::process::umask(old);
    bound.map(|l| (l, Bound(Some(path.to_owned()))))
}

/// No other process of the user, nor a core dump, can read this one's memory.
#[cfg(target_os = "linux")]
fn harden() -> Result<(), String> {
    rustix::process::set_dumpable_behavior(rustix::process::DumpableBehavior::NotDumpable)
        .map_err(|error| format!("can't make this process non-dumpable: {error}"))
}

/// No other process of the user, nor a core dump, can read this one's memory: the binary must be signed with the
/// hardened runtime and without get-task-allow (`codesign -s - -o runtime`), which keeps debuggers out, root's too.
#[cfg(target_os = "macos")]
fn harden() -> Result<(), String> {
    const CS_OPS_STATUS: std::ffi::c_uint = 0;
    const CS_GET_TASK_ALLOW: u32 = 0x4;
    const CS_RUNTIME: u32 = 0x1_0000;
    unsafe extern "C" {
        fn csops(pid: libc::pid_t, ops: std::ffi::c_uint, useraddr: *mut std::ffi::c_void, usersize: usize) -> std::ffi::c_int;
    }
    let no_core = rustix::process::Rlimit { current: Some(0), maximum: Some(0) };
    rustix::process::setrlimit(rustix::process::Resource::Core, no_core).map_err(|error| format!("can't turn core dumps off: {error}"))?;
    let mut flags = 0u32;
    // SAFETY: CS_OPS_STATUS writes one u32 to the buffer, which holds one.
    let failed = unsafe { csops(rustix::process::getpid().as_raw_pid(), CS_OPS_STATUS, (&raw mut flags).cast(), size_of::<u32>()) };
    if failed != 0 {
        return Err(format!("can't read this binary's code signature: {}", std::io::Error::last_os_error()));
    }
    if flags & CS_RUNTIME == 0 || flags & CS_GET_TASK_ALLOW != 0 {
        return Err("this binary isn't signed with the hardened runtime, so a debugger could read its memory: sign it with `codesign -f -s - -o runtime`".to_owned());
    }
    Ok(())
}

/// Windows has nothing to keep the user's other processes out of this one's memory at the same integrity level: see
/// the README's Windows section.
#[cfg(windows)]
#[allow(clippy::unnecessary_wraps, reason = "the same signature as on the other systems")]
fn harden() -> Result<(), String> {
    Ok(())
}

type Ending = std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>;

/// Resolves once the daemon is asked to end: SIGTERM. Inside the tokio runtime.
#[cfg(unix)]
fn asked_to_end() -> Result<Ending, String> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| format!("can't watch for SIGTERM: {e}"))?;
    Ok(Box::pin(async move {
        terminate.recv().await;
    }))
}

/// Never: the daemon has no console to be told on (`windows_subsystem`), and logoff and shutdown events reach only
/// services. It is killed; the next start sweeps what it left (`sweep_leftovers`).
#[cfg(windows)]
#[allow(clippy::unnecessary_wraps, reason = "the same signature as on the other systems")]
fn asked_to_end() -> Result<Ending, String> {
    Ok(Box::pin(std::future::pending()))
}

fn daemon(socket: Option<PathBuf>) -> ExitCode {
    if let Err(error) = harden() {
        note(&error);
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
    if let Err(error) = secrets::local::usable(&session::longest_socket(&socket)) {
        note(&format!("can't serve sessions beside {}: {error}", socket.display()));
        return ExitCode::FAILURE;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            note(&format!("can't start: {error}"));
            return ExitCode::FAILURE;
        }
    };
    // first: until this daemon holds the socket, the helpers beside it may be a running daemon's
    let bound = {
        let _entered = runtime.enter();
        listener(&socket)
    };
    let (mut listener, _bound) = match bound {
        Ok(bound) => bound,
        Err(error) => {
            note(&error);
            return ExitCode::FAILURE;
        }
    };
    let copies = match copies_dir(&socket, &exe) {
        Ok(dir) => dir,
        Err(error) => {
            note(&format!("can't name a folder for the helpers' copies: {error}"));
            return ExitCode::FAILURE;
        }
    };
    // On Windows the copies outlive the daemon, which is killed, never ended in order, and one that fails to start
    // shares its build's folder with the running daemon: `sweep_leftovers` removes them there.
    #[cfg(unix)]
    let _removed = Removed(copies.clone());
    let mask_run = match std::fs::canonicalize(exe.with_file_name(executable_name("secrets-mask-run"))).and_then(|found| pinned(&found, &copies)) {
        Ok(path) => path,
        Err(error) => {
            note(&format!("can't pin the helpers beside this binary in {}: {error}", copies.display()));
            return ExitCode::FAILURE;
        }
    };
    let vault_path = match vault_path() {
        Ok(path) => path,
        Err(error) => {
            note(error);
            return ExitCode::FAILURE;
        }
    };
    let vault = if vault_path.exists() { locker::Locker::Locked } else { locker::Locker::Absent };
    runtime.block_on(async move {
        #[cfg(windows)]
        sweep_leftovers(&socket, &copies);
        let mut ending = match asked_to_end() {
            Ok(ending) => ending,
            Err(error) => {
                note(&error);
                return ExitCode::FAILURE;
            }
        };
        let bin = mask_run.parent().map(shown);
        let state = State { vault, filter: filter::Filter::new(MASK_MIN), sessions: HashMap::new(), next_session: 0, next_attach: 0 };
        let sessions_dir = vault_path.with_file_name("sessions");
        let ctx = Arc::new(Context { state: Mutex::new(state), exe, mask_run, bin, socket: socket.clone(), vault_path, sessions_dir });
        let mut checks = tokio::time::interval(SESSION_CHECK);
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok(stream) = accepted {
                        tokio::spawn(serve_daemon(stream, Arc::clone(&ctx)));
                    }
                }
                () = &mut ending => break,
                _ = checks.tick() => session::end_gone(&mut lock(&ctx)),
            }
        }
        lock(&ctx).sessions.clear();
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
    let mut stream = match secrets::local::connect_blocking(&path) {
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
        #[cfg(windows)]
        ["daemon", "--log", log] => logged(Path::new(log), None),
        #[cfg(windows)]
        ["daemon", "--socket", path, "--log", log] | ["daemon", "--log", log, "--socket", path] => logged(Path::new(log), Some(PathBuf::from(path))),
        ["attach"] => attach(),
        _ => {
            #[cfg(unix)]
            note("usage: secrets-relay daemon [--socket PATH] | secrets-relay attach");
            #[cfg(windows)]
            note("usage: secrets-relay daemon [--socket PATH] [--log PATH] | secrets-relay attach");
            ExitCode::from(2)
        }
    }
}

/// The daemon, its notes appended to `log`: this process's stderr becomes that file.
#[cfg(windows)]
fn logged(log: &Path, socket: Option<PathBuf>) -> ExitCode {
    use std::os::windows::io::IntoRawHandle as _;
    use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};

    // its folder is the vault's too, which a fresh start may have removed
    let opened = log.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::OpenOptions::new().create(true).append(true).open(log));
    let file = match opened {
        Ok(file) => file,
        Err(error) => {
            note(&format!("can't open the log {}: {error}", log.display()));
            return ExitCode::FAILURE;
        }
    };
    // SAFETY: the handle is an open file, given to the process for its life; std looks the handle up at each write.
    if unsafe { SetStdHandle(STD_ERROR_HANDLE, file.into_raw_handle()) } == 0 {
        note(&format!("can't send the notes to {}: {}", log.display(), std::io::Error::last_os_error()));
        return ExitCode::FAILURE;
    }
    daemon(socket)
}
