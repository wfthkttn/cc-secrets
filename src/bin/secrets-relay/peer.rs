//! Who is on the other end of a connection, by the kernel's peer credentials: a client can't name another process.

use std::path::Path;

use tokio::net::UnixStream;

pub fn cmdline_of(pid: i64) -> String {
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

pub fn requester(peer: Option<i32>, mask_run: &Path) -> Requester {
    let Some(pid) = peer else { return Requester { pid: 0, cmdline: String::new(), inside: false } };
    let outside = || Requester { pid, cmdline: cmdline_of(i64::from(pid)), inside: false };
    let Some(top) = own_parent() else { return outside() };
    let mut at = pid;
    for _ in 0..64 {
        match parent_of(at) {
            Some(parent) if parent == top => {
                let is_mask_run = std::fs::canonicalize(format!("/proc/{at}/exe")).is_ok_and(|exe| exe == mask_run);
                return if is_mask_run { Requester { pid: at, cmdline: cmdline_of(i64::from(at)), inside: true } } else { outside() };
            }
            Some(parent) if parent > 1 => at = parent,
            _ => return outside(),
        }
    }
    outside()
}

/// The peer is Claude Code, the relay's parent.
pub fn is_claude_code(stream: &UnixStream) -> bool {
    peer_pid(stream).is_some_and(|pid| Some(pid) == own_parent())
}

/// The peer is `secrets-mask-run` started by Claude Code, the relay's own parent: its pid. A command's processes run
/// below it, so none has that parent: an orphan goes to init or a user subreaper, and Claude Code isn't one.
pub fn mask_run_pid(stream: &UnixStream, mask_run: &Path) -> Option<i32> {
    let pid = peer_pid(stream)?;
    let parent = parent_of(pid);
    let is_ours = parent.is_some() && parent == own_parent() && std::fs::canonicalize(format!("/proc/{pid}/exe")).is_ok_and(|exe| exe == mask_run);
    is_ours.then_some(pid)
}
