//! Who is on the other end of a connection, by the kernel's peer credentials: a client can't name another process.

use std::path::Path;

use secrets::local::Stream;
pub use secrets::local::peer_pid;

use crate::filter::Filter;
pub use secrets::process::{parent_of, start_time};

pub fn cmdline_of(pid: i64) -> String {
    i32::try_from(pid).ok().and_then(secrets::process::cmdline).unwrap_or_default()
}

/// The process runs the executable at `exe` (canonical).
pub fn runs(pid: i32, exe: &Path) -> bool {
    secrets::process::executable(pid).is_some_and(|path| path == exe)
}

pub struct Requester {
    pub pid: i32,
    pub cmdline: String,
    /// It runs under `secrets-mask-run` as Claude Code started it: `pid` and `cmdline` are that mask-run's, the
    /// call's, and its argv holds the command.
    pub inside: bool,
}

/// Claude Code started the process as a command's shell prefix: it is Claude Code's child.
#[cfg(unix)]
fn started_by(pid: i32, claude_code: i32) -> bool {
    parent_of(pid) == Some(claude_code)
}

/// Claude Code started the process as a command's shell prefix: on Windows Git Bash runs the prefix of a Bash call, so
/// Git Bash shells stand between them. Two are Git's launcher and the shell it starts; a third is room for one more
/// wrapper, since with too few every command is refused. What Claude Code starts through the prefix itself (stdio MCP
/// servers) is its child.
#[cfg(windows)]
fn started_by(pid: i32, claude_code: i32) -> bool {
    let is_bash = |pid| secrets::process::executable(pid).is_some_and(|exe| secrets::process::is_git_bash(&exe));
    let mut at = pid;
    for _ in 0..4 {
        match parent_of(at) {
            Some(parent) if parent == claude_code => return true,
            Some(parent) if is_bash(parent) => at = parent,
            _ => return false,
        }
    }
    false
}

/// The requester as the session whose Claude Code process is `claude_code` sees it.
pub fn requester(peer: Option<i32>, mask_run: &Path, claude_code: i32, filter: &Filter) -> Requester {
    let Some(pid) = peer else { return Requester { pid: 0, cmdline: String::new(), inside: false } };
    match call_above(pid, mask_run, claude_code).or_else(|| filter.call_holding(claude_code, pid)) {
        Some(call) => Requester { pid: call, cmdline: cmdline_of(i64::from(call)), inside: true },
        None => Requester { pid, cmdline: cmdline_of(i64::from(pid)), inside: false },
    }
}

/// The `secrets-mask-run` Claude Code started that `pid` runs under, by the line of parents.
fn call_above(pid: i32, mask_run: &Path, claude_code: i32) -> Option<i32> {
    let mut at = pid;
    for _ in 0..64 {
        if runs(at, mask_run) && started_by(at, claude_code) {
            return Some(at);
        }
        match parent_of(at) {
            Some(parent) if parent != claude_code && parent > 1 => at = parent,
            _ => return None,
        }
    }
    None
}

/// The peer is the session's Claude Code process.
pub fn is_claude_code(stream: &Stream, claude_code: i32) -> bool {
    peer_pid(stream) == Some(claude_code)
}

/// The peer is `secrets-mask-run` started by the session's Claude Code process: its pid. A command's processes run
/// below it, so none has that parent: an orphan goes to init or a user subreaper, and Claude Code isn't one. On
/// Windows a process can name any parent its user may open, so there this keeps out mistakes, not a command that
/// means to pass for the prefix.
pub fn mask_run_pid(stream: &Stream, mask_run: &Path, claude_code: i32) -> Option<i32> {
    let pid = peer_pid(stream)?;
    (started_by(pid, claude_code) && runs(pid, mask_run)).then_some(pid)
}
