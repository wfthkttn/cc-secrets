//! Usage: secrets-relay <socket-path>
//!
//! HTTP/1.0 on a unix socket (mode 0600); prints events to stdout as JSON lines, the first `{"ready": path,
//! "vault": "absent" | "locked", "bin": dir}` once it listens, `bin` being the resolved directory of its helpers, the
//! only `secrets-mask-run` it serves. The vault lives at `$XDG_DATA_HOME/secrets/vault`. It ends on SIGTERM and when
//! its parent goes.
//!
//! For commands; `pid` and `cmdline` in the events name the requester by its peer credentials: the
//! `secrets-mask-run` it runs under (`inside: true`), else the requesting process itself:
//! - `POST /ask {prompt, tag?}`: prints `{"ask": {id, prompt, tag, entry, pid, cmdline, inside}}`, `entry` being
//!   the open vault's entry tagged `tag` (no value) or null, then holds the request until answered: 200 with the
//!   value, 403 when cancelled. A client that hangs up first prints `{"gone": id}`.
//! - `POST /list`: 403 while the vault is closed; else prints `{"list": {id, pid, cmdline, inside}}` and waits for
//!   a decision: 200 with the entries as JSON (no values), 403 refused.
//! - `POST /filter`: for `secrets-mask-run` as Claude Code starts it, 403 to anyone else; a call's output stream
//!   (`secrets::filter`), masked with what that call was handed and the open vault's values.
//!
//! For Claude Code only (the peer must be the relay's parent), 403 to anyone else:
//! - `POST /answer {id, secret}`, `{id, entry, session}` or `{id, cancel: true}`.
//! - `POST /unlock {passphrase}`, `POST /create {passphrase}`: 204 open, 403 wrong passphrase.
//! - `POST /decide {id, decision: "give" | "session" | "refuse"}`: 204, 410 no such request.
//! - `GET /vault`: `{state, entries, suggestions, forward, upstream}`; never a value.
//! - `POST /vault {op: "add" | "edit" | "delete" | "allow" | "save" | "dismiss" | "forward", …}`: 200 `{id}`; 400
//!   with a reason.
//! - `POST /settings {maskMinLength}`: 204.
//! - `POST /mask {texts}`: `{texts}` with the open vault's values masked. `POST /check {texts}`: `{label}`, the
//!   entry one of the texts carries, or null.
//!
//! `{"vault": state}` is printed after each change to the vault; `{"masked": true}` the first time anything was
//! masked; `{"trouble": text}` when the vault can't be written.
//!
//! `<socket-path>.agent` is an ssh-agent offering the open vault's ssh keys (`ssh.rs`).

mod filter;
mod locker;
mod pass;
mod peer;
mod ssh;

use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
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

const HEAD_MAX: usize = 65536;
/// The largest request body: `/mask` carries whole tool results.
const BODY_MAX: usize = 32 << 20;
/// A request's head, and then its body, must arrive within this.
const REQUEST_WITHIN: std::time::Duration = std::time::Duration::from_secs(30);
/// How often the relay checks that Claude Code, its parent, is still there.
const PARENT_CHECK: std::time::Duration = std::time::Duration::from_secs(2);
const COSTS: Costs = Costs { memory_kib: 65536, time: 3, lanes: 1 };
/// Masking's shortest value until the hooks send theirs.
const MASK_MIN: usize = 6;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Decision {
    Give,
    Session,
    Refuse,
}

struct State {
    pass: pass::Pass,
    /// Decisions the hooks owe: signatures and lists.
    deciding: HashMap<String, oneshot::Sender<Decision>>,
    vault: locker::Locker,
    filter: filter::Filter,
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

/// A request's head, and the body bytes that came with it.
struct Head {
    method: String,
    path: String,
    length: usize,
    started: Zeroizing<Vec<u8>>,
}

async fn read_head(stream: &mut UnixStream) -> Option<Head> {
    let mut raw = Zeroizing::new(Vec::new());
    let mut buf = Zeroizing::new([0u8; 4096]);
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
    let mut body = head.started;
    let mut buf = Zeroizing::new([0u8; 4096]);
    while body.len() < head.length {
        let n = stream.read(buf.as_mut()).await.ok().filter(|n| *n > 0)?;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    mask_min_length: usize,
}

async fn json_reply(stream: &mut UnixStream, reply: Option<serde_json::Value>) {
    match reply {
        Some(reply) => respond(stream, "200 OK", reply.to_string().as_bytes()).await,
        None => respond(stream, "400 Bad Request", b"").await,
    }
}

async fn serve(mut stream: UnixStream, ctx: Shared) {
    let Ok(Some(head)) = tokio::time::timeout(REQUEST_WITHIN, read_head(&mut stream)).await else { return };
    let (method, path) = (head.method.clone(), head.path.clone());
    let route = (method.as_str(), path.as_str());
    let for_claude_code = !matches!(route, ("POST", "/ask" | "/list" | "/filter"));
    if for_claude_code && !peer::is_claude_code(&stream) {
        return respond(&mut stream, "403 Forbidden", b"").await;
    }
    if head.length > BODY_MAX {
        return respond(&mut stream, "413 Content Too Large", b"").await;
    }
    let Ok(Some(body)) = tokio::time::timeout(REQUEST_WITHIN, read_body(&mut stream, head)).await else { return };
    locker::fresh(&ctx, &mut lock(&ctx));
    let body = body.as_slice();
    match route {
        ("POST", "/ask") => pass::ask(&mut stream, &ctx, body).await,
        ("POST", "/list") => locker::list(&mut stream, &ctx).await,
        ("POST", "/filter") => filter::serve(&mut stream, &ctx).await,
        ("POST", "/answer") => pass::answer(&mut stream, &ctx, body).await,
        ("POST", "/unlock") => locker::open(&mut stream, &ctx, body, false).await,
        ("POST", "/create") => locker::open(&mut stream, &ctx, body, true).await,
        ("POST", "/decide") => decided(&mut stream, &ctx, body).await,
        ("GET", "/vault") => {
            let shown = locker::show(&lock(&ctx), ctx.upstream.is_some());
            respond(&mut stream, "200 OK", shown.to_string().as_bytes()).await;
        }
        ("POST", "/vault") => locker::change_vault(&mut stream, &ctx, body).await,
        ("POST", "/settings") => match serde_json::from_slice::<Settings>(body) {
            Ok(settings) if settings.mask_min_length > 0 => {
                lock(&ctx).filter.set_min_length(settings.mask_min_length);
                respond(&mut stream, "204 No Content", b"").await;
            }
            _ => respond(&mut stream, "400 Bad Request", b"").await,
        },
        ("POST", "/mask") => {
            let reply = filter::mask_texts(&ctx, body);
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

fn vault_path() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|home| PathBuf::from(home).join(".local/share")))?;
    Some(data.join("secrets").join("vault"))
}

fn main() -> ExitCode {
    let parent = rustix::process::getppid();
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
    let vault = if vault_path.exists() { locker::Locker::Locked } else { locker::Locker::Absent };
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
        let bin = mask_run.parent().map(|dir| dir.display().to_string());
        emit(&json!({ "ready": path, "vault": vault.shown(), "bin": bin }));
        let state = State { pass: pass::Pass::default(), deciding: HashMap::new(), vault, filter: filter::Filter::new(MASK_MIN), forward: false };
        let ctx = Arc::new(Context { state: Mutex::new(state), mask_run, vault_path, upstream });
        let mut parent_check = tokio::time::interval(PARENT_CHECK);
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        tokio::spawn(serve(stream, Arc::clone(&ctx)));
                    }
                }
                accepted = agent_listener.accept() => {
                    if let Ok((stream, _)) = accepted {
                        tokio::spawn(ssh::serve(stream, Arc::clone(&ctx)));
                    }
                }
                _ = terminate.recv() => break,
                // Claude Code killed outright never ends the relay; reparented, it would keep the vault open.
                _ = parent_check.tick() => {
                    if rustix::process::getppid() != parent {
                        break;
                    }
                }
            }
        }
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(&agent_path);
        ExitCode::SUCCESS
    })
}
