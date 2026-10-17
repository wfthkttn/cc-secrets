//! Who is on the other end of a connection, by the kernel's peer credentials: a client can't name another process.

use std::path::Path;

pub use secrets::process::{parent_of, start_time};
use tokio::net::UnixStream;

pub fn cmdline_of(pid: i64) -> String {
    i32::try_from(pid).ok().and_then(secrets::process::cmdline).unwrap_or_default()
}

/// The process runs the executable at `exe` (canonical).
pub fn runs(pid: i32, exe: &Path) -> bool {
    secrets::process::executable(pid).is_some_and(|path| path == exe)
}

pub fn peer_pid(stream: &UnixStream) -> Option<i32> {
    stream.peer_cred().ok()?.pid()
}

pub struct Requester {
    pub pid: i32,
    pub cmdline: String,
    /// It runs under `secrets-mask-run` as Claude Code started it: `pid` and `cmdline` are that mask-run's, the
    /// call's, and its argv holds the command.
    pub inside: bool,
}

/// The requester as the session whose Claude Code process is `claude_code` sees it.
pub fn requester(peer: Option<i32>, mask_run: &Path, claude_code: i32) -> Requester {
    let Some(pid) = peer else { return Requester { pid: 0, cmdline: String::new(), inside: false } };
    let outside = || Requester { pid, cmdline: cmdline_of(i64::from(pid)), inside: false };
    let mut at = pid;
    for _ in 0..64 {
        match parent_of(at) {
            Some(parent) if parent == claude_code => {
                return if runs(at, mask_run) { Requester { pid: at, cmdline: cmdline_of(i64::from(at)), inside: true } } else { outside() };
            }
            Some(parent) if parent > 1 => at = parent,
            _ => return outside(),
        }
    }
    outside()
}

/// The peer is the session's Claude Code process.
pub fn is_claude_code(stream: &UnixStream, claude_code: i32) -> bool {
    peer_pid(stream) == Some(claude_code)
}

/// The peer is `secrets-mask-run` started by the session's Claude Code process: its pid. A command's processes run
/// below it, so none has that parent: an orphan goes to init or a user subreaper, and Claude Code isn't one.
pub fn mask_run_pid(stream: &UnixStream, mask_run: &Path, claude_code: i32) -> Option<i32> {
    let pid = peer_pid(stream)?;
    (parent_of(pid) == Some(claude_code) && runs(pid, mask_run)).then_some(pid)
}
