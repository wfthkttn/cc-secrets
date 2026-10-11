//! Usage: secrets-relay <socket-path>
//!
//! HTTP/1.0 on a unix socket (mode 0600); prints `{"ready": path}` to stdout once it listens.
//! - `POST /ask {prompt, pid}`: prints `{"ask": {id, prompt, pid, cmdline}}`, then holds the request until
//!   answered: 200 with the secret as the body, or 403 when cancelled. A client that hangs up first prints
//!   `{"gone": id}`.
//! - `POST /answer {id, secret}` or `{id, cancel: true}`: 204 taken, 410 no such ask.
//! - `GET /watch`: every answered value as a JSON string per line, then each new one, until the client hangs up;
//!   403 to any client but `secrets-mask-run` as Claude Code starts it.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use rustix::fs::Mode;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};

const HEAD_MAX: usize = 65536;

#[derive(Default)]
struct State {
    waiting: HashMap<String, oneshot::Sender<Option<String>>>,
    known: Vec<String>,
    watchers: Vec<mpsc::UnboundedSender<String>>,
}

type Shared = Arc<Mutex<State>>;

fn emit(event: &serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}").and_then(|()| out.flush());
}

fn note(message: &str) {
    let _ = writeln!(std::io::stderr(), "secrets-relay: {message}");
}

fn lock(state: &Shared) -> std::sync::MutexGuard<'_, State> {
    state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Records an answered value and sends it to every watcher still listening.
fn keep(state: &Shared, secret: &str) {
    if secret.is_empty() {
        return;
    }
    let mut state = lock(state);
    if state.known.iter().any(|k| k == secret) {
        return;
    }
    state.known.push(secret.to_owned());
    state.watchers.retain(|w| w.send(secret.to_owned()).is_ok());
}

fn random_id() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut bytes)?;
    Ok(bytes.iter().fold(String::new(), |mut id, b| {
        let _ = std::fmt::Write::write_fmt(&mut id, format_args!("{b:02x}"));
        id
    }))
}

fn cmdline_of(pid: i64) -> String {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|raw| String::from_utf8_lossy(&raw).replace('\0', " ").trim().to_owned())
        .unwrap_or_default()
}

/// The peer is `secrets-mask-run` started by Claude Code, the relay's own parent. A command's processes run
/// below it, so none has that parent: an orphan goes to init or a user subreaper, and Claude Code isn't one.
fn is_mask_run(stream: &UnixStream, mask_run: &Path) -> bool {
    let Some(pid) = stream.peer_cred().ok().and_then(|c| c.pid()) else { return false };
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
    let peer_parent = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1)).and_then(|p| p.parse::<i32>().ok());
    let own_parent = rustix::process::getppid().map(rustix::process::Pid::as_raw_pid);
    peer_parent.is_some() && peer_parent == own_parent && std::fs::canonicalize(format!("/proc/{pid}/exe")).is_ok_and(|exe| exe == mask_run)
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

async fn ask(stream: &mut UnixStream, state: &Shared, body: &[u8]) {
    let Ok(ask) = serde_json::from_slice::<Ask>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let Ok(id) = random_id() else { return respond(stream, "500 Internal Server Error", b"").await };
    let (tx, rx) = oneshot::channel();
    lock(state).waiting.insert(id.clone(), tx);
    let cmdline = if ask.pid > 0 { cmdline_of(ask.pid) } else { String::new() };
    emit(&json!({ "ask": { "id": id, "prompt": ask.prompt, "pid": ask.pid, "cmdline": cmdline } }));
    tokio::select! {
        answer = rx => match answer {
            Ok(Some(secret)) => respond(stream, "200 OK", secret.as_bytes()).await,
            _ => respond(stream, "403 Forbidden", b"").await,
        },
        () = hung_up(stream) => {
            lock(state).waiting.remove(&id);
            emit(&json!({ "gone": id }));
        }
    }
}

async fn answer(stream: &mut UnixStream, state: &Shared, body: &[u8]) {
    let Ok(answer) = serde_json::from_slice::<Answer>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let Some(tx) = lock(state).waiting.remove(&answer.id) else { return respond(stream, "410 Gone", b"").await };
    let secret = if answer.cancel { None } else { Some(answer.secret.unwrap_or_default()) };
    if let Some(secret) = &secret {
        keep(state, secret);
    }
    let _ = tx.send(secret);
    respond(stream, "204 No Content", b"").await;
}

async fn watch(stream: &mut UnixStream, state: &Shared, mask_run: &Path) {
    if !is_mask_run(stream, mask_run) {
        return respond(stream, "403 Forbidden", b"").await;
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let known = {
        let mut state = lock(state);
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

async fn serve(mut stream: UnixStream, state: Shared, mask_run: Arc<PathBuf>) {
    let Some(request) = read_request(&mut stream).await else { return };
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/ask") => ask(&mut stream, &state, &request.body).await,
        ("POST", "/answer") => answer(&mut stream, &state, &request.body).await,
        ("GET", "/watch") => watch(&mut stream, &state, &mask_run).await,
        _ => respond(&mut stream, "404 Not Found", b"").await,
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [path] = args.as_slice() else {
        note("usage: secrets-relay <socket-path>");
        return ExitCode::from(2);
    };
    let mask_run = match std::env::current_exe().and_then(|exe| std::fs::canonicalize(exe.with_file_name("secrets-mask-run"))) {
        Ok(path) => Arc::new(path),
        Err(error) => {
            note(&format!("can't find secrets-mask-run beside this binary: {error}"));
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            note(&format!("can't start: {error}"));
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async move {
        let _ = std::fs::remove_file(path);
        let old = rustix::process::umask(Mode::from_raw_mode(0o177));
        let listener = UnixListener::bind(path);
        rustix::process::umask(old);
        let listener = match listener {
            Ok(listener) => listener,
            Err(error) => {
                note(&format!("can't listen on {path}: {error}"));
                return ExitCode::FAILURE;
            }
        };
        let Ok(mut terminate) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) else {
            note("can't watch for SIGTERM");
            return ExitCode::FAILURE;
        };
        emit(&json!({ "ready": path }));
        let state = Shared::default();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        tokio::spawn(serve(stream, Arc::clone(&state), Arc::clone(&mask_run)));
                    }
                }
                _ = terminate.recv() => break,
            }
        }
        let _ = std::fs::remove_file(path);
        ExitCode::SUCCESS
    })
}
