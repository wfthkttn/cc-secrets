//! The Claude Code sessions the daemon serves, each known by its Claude Code process. The hooks spawn
//! `secrets-relay attach`, whose parent that process is. The first attach makes the session two sockets of its own:
//! `SECRETS_RELAY` for its commands and its hooks' calls, and an ssh-agent. Each attach streams the session's events;
//! a later one (the hooks reloaded) takes the stream over and gets the waiting requests again. The session ends with
//! its Claude Code process.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use secrets::vault::random_hex;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::access::Access;
use crate::pass::Pass;
use crate::{Decision, Shared, State, lock, note, peer, respond};

pub type Id = u64;

/// A decision the hooks owe, and the event that asked for it, sent again to a later attach.
pub struct Deciding {
    pub tx: oneshot::Sender<Decision>,
    pub event: serde_json::Value,
}

pub struct Session {
    id: Id,
    /// The Claude Code process, and when it started: a later process with the same pid is another session.
    pub claude_code: i32,
    started: u64,
    pub socket: PathBuf,
    pub agent: PathBuf,
    pub pass: Pass,
    pub deciding: HashMap<String, Deciding>,
    /// The Claude Code session id its grants are kept under, once the hooks named it.
    pub named: Option<String>,
    pub access: Access,
    /// The upstream agent's keys are offered too.
    pub forward: bool,
    /// The user's own ssh-agent, as the hooks found it.
    pub upstream: Option<PathBuf>,
    serving: Vec<JoinHandle<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        for task in &self.serving {
            task.abort();
        }
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_file(&self.agent);
        sinks().remove(&self.id);
    }
}

/// Where an attach's events go, and the attach's number.
type Sink = (u64, mpsc::UnboundedSender<String>);

/// Each session's attach stream. Apart from the state, so events go out from wherever the state is locked.
static SINKS: LazyLock<Mutex<HashMap<Id, Sink>>> = LazyLock::new(Mutex::default);

fn sinks() -> MutexGuard<'static, HashMap<Id, Sink>> {
    SINKS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Sends the event to the session's hooks; while none is attached it is dropped (a later attach gets what is still
/// waiting).
pub fn tell(session: Id, event: &serde_json::Value) {
    if let Some((_, sink)) = sinks().get(&session) {
        let _ = sink.send(event.to_string());
    }
}

/// Sends the event to every session's hooks.
pub fn tell_all(event: &serde_json::Value) {
    let line = event.to_string();
    for (_, sink) in sinks().values() {
        let _ = sink.send(line.clone());
    }
}

#[derive(Deserialize)]
struct Attach {
    #[serde(default)]
    upstream: String,
}

/// Binds the session's two sockets beside the daemon's, mode 0600, and serves them.
fn open(ctx: &Shared, state: &mut State, claude_code: i32, started: u64) -> Result<Id, String> {
    let hex = random_hex::<8>().map_err(|e| e.to_string())?;
    let socket = PathBuf::from(format!("{}-{hex}", ctx.socket.display()));
    let agent = PathBuf::from(format!("{}-{hex}.agent", ctx.socket.display()));
    let old = rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o177));
    let bound = [&socket, &agent].map(|p| UnixListener::bind(p).map_err(|error| format!("can't listen on {}: {error}", p.display())));
    rustix::process::umask(old);
    let (listener, agent_listener) = match bound {
        [Ok(listener), Ok(agent_listener)] => (listener, agent_listener),
        [Err(error), other] | [other, Err(error)] => {
            drop(other);
            let _ = std::fs::remove_file(&socket);
            let _ = std::fs::remove_file(&agent);
            return Err(error);
        }
    };
    state.next_session += 1;
    let id = state.next_session;
    let serving = vec![tokio::spawn(crate::accept(listener, ctx.clone(), id)), tokio::spawn(crate::ssh::accept(agent_listener, ctx.clone(), id))];
    let session = Session {
        id,
        claude_code,
        started,
        socket,
        agent,
        pass: Pass::default(),
        deciding: HashMap::new(),
        named: None,
        access: Access::default(),
        forward: false,
        upstream: None,
        serving,
    };
    state.sessions.insert(id, session);
    Ok(id)
}

/// `POST /attach {upstream}` on the daemon's socket: the session of the peer's parent, Claude Code, made at its first
/// attach; 200, then its events as JSON lines until either side hangs up, the first `{"ready": socket, "agent",
/// "vault", "bin"}`, then whether `/mask` has values and the requests still waiting.
pub async fn attach(mut stream: UnixStream, ctx: Shared, body: &[u8]) {
    let Some(peer) = peer::peer_pid(&stream) else { return respond(&mut stream, "403 Forbidden", b"").await };
    // Only the hooks' attach reads the events: any other child of Claude Code (an MCP server, a settings hook) would
    // take the session's requests over.
    if !peer::runs(peer, &ctx.exe) {
        return respond(&mut stream, "403 Forbidden", b"not this daemon's secrets-relay; a daemon from another build runs").await;
    }
    let Some((claude_code, started)) = peer::parent_of(peer).and_then(|parent| Some((parent, peer::start_time(parent)?))) else {
        return respond(&mut stream, "403 Forbidden", b"").await;
    };
    let Ok(Attach { upstream }) = serde_json::from_slice::<Attach>(body) else { return respond(&mut stream, "400 Bad Request", b"").await };
    let (sink, mut events) = mpsc::unbounded_channel();
    let attached = {
        let mut state = lock(&ctx);
        let found = state.sessions.iter().find(|(_, s)| s.claude_code == claude_code && s.started == started).map(|(id, _)| *id);
        match found.map_or_else(|| open(&ctx, &mut state, claude_code, started), Ok) {
            Ok(id) => {
                state.next_attach += 1;
                let number = state.next_attach;
                let vault = state.vault.shown();
                let masking = state.filter.masking();
                if let Some(session) = state.sessions.get_mut(&id) {
                    session.upstream = (!upstream.is_empty()).then(|| PathBuf::from(upstream));
                    let ready = json!({ "ready": session.socket, "agent": session.agent, "vault": vault, "bin": ctx.bin });
                    let waiting = session.pass.events().chain(session.deciding.values().map(|d| d.event.clone()));
                    for event in [ready, json!({ "masking": masking })].into_iter().chain(waiting) {
                        let _ = sink.send(event.to_string());
                    }
                }
                sinks().insert(id, (number, sink));
                Ok((id, number))
            }
            Err(reason) => Err(reason),
        }
    };
    let (id, number) = match attached {
        Ok(attached) => attached,
        Err(reason) => return respond(&mut stream, "500 Internal Server Error", reason.as_bytes()).await,
    };
    let (mut reader, mut writer) = stream.split();
    if writer.write_all(b"HTTP/1.0 200 OK\r\n\r\n").await.is_ok() {
        let mut byte = [0u8; 1];
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Some(line) if writer.write_all(format!("{line}\n").as_bytes()).await.is_ok() => {}
                    _ => break,
                },
                _ = reader.read(&mut byte) => break,
            }
        }
    }
    let mut sinks = sinks();
    // A later attach has the session's events now.
    if sinks.get(&id).is_some_and(|(n, _)| *n == number) {
        sinks.remove(&id);
    }
}

/// Ends the sessions whose Claude Code process is gone: their sockets go, what they wait for is refused.
pub fn end_gone(state: &mut State) {
    let gone: Vec<Id> = state.sessions.iter().filter(|(_, s)| peer::start_time(s.claude_code) != Some(s.started)).map(|(id, _)| *id).collect();
    for id in gone {
        if let Some(session) = state.sessions.remove(&id) {
            note(&format!("the session of Claude Code {} ended", session.claude_code));
        }
    }
}
