//! Usage: secrets-mask-run '<shell invocation>'   (as `CLAUDE_CODE_SHELL_PREFIX`)
//!
//! Runs the invocation with `/bin/sh -c` (on Windows with Git Bash's `bash -c`, in a job of its own:
//! `secrets::job`), or through `$SECRETS_ORIG_PREFIX` when set, passing its stdout and stderr through the relay
//! at `$SECRETS_RELAY`, which masks them (`secrets::filter`); this process holds no values. Exits with the command's
//! status, 128 + the signal when a signal ended it. Without a relay the command still runs; one line on stderr says its
//! output is unmasked. Refused by the relay, it runs only under another mask-run, which masks its output (found among
//! its parents, or on Windows told by the relay: 409); otherwise it exits 126 without running it.
//! A relay that goes away mid-call may have handed the call a value, so the rest of its output is withheld; the
//! command runs on.

use std::io::{ErrorKind, Read, Write};
#[cfg(unix)]
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Child, Command, ExitCode, ExitStatus, Stdio};

#[cfg(unix)]
use rustix::event::{PollFd, PollFlags, Timespec, poll};
#[cfg(unix)]
use rustix::process::{Pid, Signal, kill_process};
use secrets::filter::{self as frame, DATA, END, IDLE, STDERR, STDOUT};
#[cfg(unix)]
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
#[cfg(unix)]
use signal_hook::iterator::Signals;

#[cfg(unix)]
const IDLE_AFTER: Timespec = Timespec { tv_sec: 0, tv_nsec: 50_000_000 };
#[cfg(windows)]
const IDLE_AFTER: std::time::Duration = std::time::Duration::from_millis(50);
const CHUNK: usize = 65536;
const HEAD_MAX: usize = 4096;

fn note(message: &str) {
    let _ = writeln!(std::io::stderr(), "secrets-mask-run: {message}");
}

/// The relay's `/filter` stream for this call.
struct Filter {
    stream: secrets::local::BlockingStream,
}

enum Unfiltered {
    /// No relay answers: nothing was handed out through it.
    Unreachable(String),
    /// A relay answers and won't filter this process: it isn't the call Claude Code started.
    Refused(String),
    /// The relay won't filter this process, which runs inside one of its session's calls, so that call masks it.
    InsideCall,
}

impl Filter {
    /// Opens the stream; once this returns, the relay knows the call, so a value handed to it is masked.
    fn connect(path: &std::ffi::OsStr, body: &str) -> Result<Self, Unfiltered> {
        let mut stream = secrets::local::connect_blocking(std::path::Path::new(path)).map_err(|e| Unfiltered::Unreachable(format!("no secrets relay ({e})")))?;
        stream
            .write_all(format!("POST /filter HTTP/1.0\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
            .map_err(|e| Unfiltered::Unreachable(format!("the secrets relay can't be reached ({e})")))?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() > HEAD_MAX || stream.read_exact(&mut byte).is_err() {
                return Err(Unfiltered::Unreachable("the secrets relay sent no answer".to_owned()));
            }
            head.extend_from_slice(&byte);
        }
        let status = head.split(|b| *b == b' ').nth(1).unwrap_or_default();
        if status == b"409" {
            return Err(Unfiltered::InsideCall);
        }
        if status != b"200" {
            return Err(Unfiltered::Refused(format!("the secrets relay refused this process ({})", String::from_utf8_lossy(status))));
        }
        Ok(Self { stream })
    }

    /// Sends one piece; what to write now, and whether the relay holds a tail of that stream back.
    fn send(&mut self, kind: u8, which: u8, body: &[u8]) -> std::io::Result<(Vec<u8>, bool)> {
        self.stream.write_all(&frame::request(kind, which, body))?;
        let mut head = [0u8; 5];
        self.stream.read_exact(&mut head)?;
        let [holding, a, b, c, d] = head;
        let length = usize::try_from(u32::from_be_bytes([a, b, c, d])).map_err(|_| ErrorKind::InvalidData)?;
        let mut out = vec![0u8; length];
        self.stream.read_exact(&mut out)?;
        Ok((out, holding != 0))
    }
}

/// One of the command's output streams.
struct Output {
    which: u8,
    pipe: Option<Box<dyn Read + Send>>,
    #[cfg(unix)]
    fd: Option<std::os::fd::OwnedFd>,
    ended: bool,
    /// The relay holds a tail back that only more output or an idle pass lets out.
    holding: bool,
    /// The idle pass went since the last output.
    settled: bool,
    sink: Box<dyn Write>,
}

impl Output {
    #[cfg(unix)]
    fn new<P: Read + Send + Into<std::os::fd::OwnedFd> + std::os::fd::AsFd + 'static>(which: u8, pipe: Option<P>, sink: Box<dyn Write>) -> Self {
        let fd = pipe.as_ref().and_then(|p| p.as_fd().try_clone_to_owned().ok());
        let ended = pipe.is_none();
        Self { which, pipe: pipe.map(|p| Box::new(p) as Box<dyn Read + Send>), fd, ended, holding: false, settled: false, sink }
    }

    #[cfg(windows)]
    fn new<P: Read + Send + 'static>(which: u8, pipe: Option<P>, sink: Box<dyn Write>) -> Self {
        let ended = pipe.is_none();
        Self { which, pipe: pipe.map(|p| Box::new(p) as Box<dyn Read + Send>), ended, holding: false, settled: false, sink }
    }

    fn is_open(&self) -> bool {
        !self.ended
    }

    fn waiting(&self) -> bool {
        self.is_open() && self.holding && !self.settled
    }

    fn write(&mut self, bytes: &[u8]) {
        let _ = self.sink.write_all(bytes).and_then(|()| self.sink.flush());
    }

    /// Passes a piece through the relay. Once the relay is gone the rest is withheld, after one line saying so: it may
    /// have handed this call a value that only it could mask.
    fn pass(&mut self, filter: &mut Option<Filter>, kind: u8, body: &[u8]) {
        let Some(open) = filter.as_mut() else { return };
        match open.send(kind, self.which, body) {
            Ok((out, holding)) => {
                self.write(&out);
                self.holding = holding;
            }
            Err(error) => {
                *filter = None;
                self.holding = false;
                note(&format!("the secrets relay stopped ({error}); the rest of this output is withheld"));
            }
        }
    }

    /// Passes a piece of output through, None once the stream ended.
    fn got(&mut self, filter: &mut Option<Filter>, piece: Option<&[u8]>) {
        if let Some(bytes) = piece {
            self.settled = false;
            self.pass(filter, DATA, bytes);
            return;
        }
        self.pass(filter, END, &[]);
        self.pipe = None;
        #[cfg(unix)]
        {
            self.fd = None;
        }
        self.ended = true;
    }

    #[cfg(unix)]
    fn read(&mut self, filter: &mut Option<Filter>, buf: &mut [u8]) {
        let Some(pipe) = self.pipe.as_mut() else { return };
        match pipe.read(buf) {
            Ok(n) if n > 0 => self.got(filter, Some(buf.get(..n).unwrap_or_default())),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            _ => self.got(filter, None),
        }
    }
}

#[cfg(unix)]
#[allow(clippy::unnecessary_wraps, reason = "the same signature as on Windows")]
fn command(invocation: &std::ffi::OsStr) -> Result<Command, String> {
    if let Some(prefix) = std::env::var_os("SECRETS_ORIG_PREFIX").filter(|p| !p.is_empty()) {
        let mut command = Command::new(prefix);
        command.arg(invocation);
        Ok(command)
    } else {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(invocation);
        Ok(command)
    }
}

/// Git Bash: the one that started this process (a Bash call), else, for what Claude Code starts through the prefix
/// itself (stdio MCP servers), `$CLAUDE_CODE_GIT_BASH_PATH` or the Git for Windows whose `git.exe` is on PATH. Never a
/// `bash` found on PATH, which may be WSL's.
#[cfg(windows)]
fn shell() -> Result<std::path::PathBuf, String> {
    let parent = i32::try_from(std::process::id()).ok().and_then(secrets::process::parent_of);
    if let Some(exe) = parent.and_then(secrets::process::executable).filter(|exe| secrets::process::is_git_bash(exe)) {
        // canonical, so verbatim (`\\?\C:\…`), which bash would take as its own name
        let shown = exe.to_string_lossy();
        return Ok(shown.strip_prefix(r"\\?\").filter(|rest| rest.get(1..2) == Some(":")).map_or_else(|| exe.clone(), std::path::PathBuf::from));
    }
    if let Some(set) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").filter(|p| !p.is_empty()) {
        return Ok(set.into());
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .filter(|dir| dir.join("git.exe").is_file())
        .find_map(|dir| dir.ancestors().take(3).map(|root| root.join(r"bin\bash.exe")).find(|bash| bash.is_file()))
        .ok_or_else(|| "no Git Bash: not started by one, CLAUDE_CODE_GIT_BASH_PATH unset, and no Git for Windows on PATH".to_owned())
}

/// The invocation reaches bash in a variable, not on its command line: Git Bash reads a command line by its own
/// rules, which halve doubled backslashes. A bash of its own runs it, as `sh -c` does on Unix, so the variable it
/// came in isn't left in the command's shell; the original prefix runs as one program, as on Unix.
#[cfg(windows)]
fn command(invocation: &std::ffi::OsStr) -> Result<Command, String> {
    let take = "__secrets_invocation=$SECRETS_INVOCATION; unset SECRETS_INVOCATION; ";
    let run = if std::env::var_os("SECRETS_ORIG_PREFIX").is_some_and(|p| !p.is_empty()) {
        r#"exec "$SECRETS_ORIG_PREFIX" "$__secrets_invocation""#
    } else {
        r#"exec "$BASH" -c "$__secrets_invocation""#
    };
    let mut command = Command::new(shell()?);
    command.arg("-c").arg(format!("{take}{run}")).env("SECRETS_INVOCATION", invocation);
    Ok(command)
}

#[cfg(unix)]
fn exit_code(status: ExitStatus) -> ExitCode {
    match (status.code(), status.signal()) {
        (Some(code), _) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        (None, Some(signal)) => ExitCode::from(u8::try_from(128 + signal).unwrap_or(128)),
        (None, None) => ExitCode::FAILURE,
    }
}

/// As Git Bash reports them: an MSYS program a signal ended exits with the signal in the second byte (SIGTERM
/// `0xF00`), which is 128 + the signal; any other code is its low byte, as an NTSTATUS such as `0xC0000005` doesn't
/// fit.
#[cfg(windows)]
fn exit_code(status: ExitStatus) -> ExitCode {
    status.code().map_or(ExitCode::FAILURE, |code| match code.to_le_bytes() {
        [0, signal @ 1..=0x7f, 0, 0] => ExitCode::from(128 + signal),
        [low, ..] => ExitCode::from(low),
    })
}

/// Runs the command in this process's place, its output unmasked.
#[cfg(unix)]
fn run_unfiltered(mut command: Command) -> ExitCode {
    let error = command.exec();
    note(&format!("can't run the command: {error}"));
    ExitCode::from(127)
}

/// Runs the command on this process's output, unmasked. Windows has no exec, so this process waits for it.
#[cfg(windows)]
fn run_unfiltered(mut command: Command) -> ExitCode {
    match command.status() {
        Ok(status) => exit_code(status),
        Err(error) => {
            note(&format!("can't run the command: {error}"));
            ExitCode::from(127)
        }
    }
}

/// Passes TERM, INT and HUP on to the command.
#[cfg(unix)]
fn forward_signals(child: &Child) {
    let Some(pid) = i32::try_from(child.id()).ok().and_then(Pid::from_raw) else { return };
    let Ok(mut signals) = Signals::new([SIGTERM, SIGINT, SIGHUP]) else {
        note("can't pass signals on to the command");
        return;
    };
    std::thread::spawn(move || {
        for raw in signals.forever() {
            let signal = match raw {
                SIGINT => Signal::INT,
                SIGHUP => Signal::HUP,
                _ => Signal::TERM,
            };
            let _ = kill_process(pid, signal);
        }
    });
}

/// A console's Ctrl+C reaches the command itself.
#[cfg(windows)]
fn forward_signals(_child: &Child) {}

#[cfg(unix)]
fn is_readable(fd: Option<&PollFd<'_>>) -> bool {
    fd.is_some_and(|fd| fd.revents().intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR))
}

/// Copies the command's output through the relay until both streams end.
#[cfg(unix)]
fn copy(outputs: &mut [Output; 2], mut filter: Option<Filter>) {
    let mut buf = vec![0u8; CHUNK];
    while outputs.iter().any(Output::is_open) {
        let waiting = outputs.iter().any(Output::waiting);
        let (ready, polled) = {
            let mut fds: Vec<PollFd<'_>> = outputs.iter().filter_map(|o| o.fd.as_ref()).map(|fd| PollFd::new(fd, PollFlags::IN)).collect();
            let polled = poll(&mut fds, waiting.then_some(&IDLE_AFTER));
            let mut at = fds.iter();
            let ready: Vec<bool> = outputs.iter().map(|o| o.fd.is_some() && is_readable(at.next())).collect();
            (ready, polled)
        };
        match polled {
            Err(rustix::io::Errno::INTR) => continue,
            Err(error) => {
                note(&format!("poll failed: {error}; the rest of the output is not shown"));
                return;
            }
            Ok(0) => {
                for output in outputs.iter_mut().filter(|o| o.waiting()) {
                    output.pass(&mut filter, IDLE, &[]);
                    output.settled = true;
                }
                continue;
            }
            Ok(_) => {}
        }
        for (output, ready) in outputs.iter_mut().zip(ready) {
            if ready {
                output.read(&mut filter, &mut buf);
            }
        }
    }
}

/// Copies the command's output through the relay until both streams end. Windows can't poll pipes: a thread reads
/// each one.
#[cfg(windows)]
fn copy(outputs: &mut [Output; 2], mut filter: Option<Filter>) {
    use std::sync::mpsc::{RecvTimeoutError, sync_channel};

    // bounded, so a command that writes faster than the relay masks waits on its pipe instead of filling memory
    let (tx, rx) = sync_channel::<(usize, Option<Vec<u8>>)>(4);
    for (at, output) in outputs.iter_mut().enumerate() {
        let Some(mut pipe) = output.pipe.take() else { continue };
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; CHUNK];
            loop {
                let piece = match pipe.read(&mut buf) {
                    Ok(n) if n > 0 => Some(buf.get(..n).unwrap_or_default().to_vec()),
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    _ => None,
                };
                let ended = piece.is_none();
                if tx.send((at, piece)).is_err() || ended {
                    return;
                }
            }
        });
    }
    drop(tx);
    while outputs.iter().any(Output::is_open) {
        let received = if outputs.iter().any(Output::waiting) { rx.recv_timeout(IDLE_AFTER) } else { rx.recv().map_err(|_| RecvTimeoutError::Disconnected) };
        match received {
            Ok((at, piece)) => {
                if let Some(output) = outputs.get_mut(at) {
                    output.got(&mut filter, piece.as_deref());
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                for output in outputs.iter_mut().filter(|o| o.waiting()) {
                    output.pass(&mut filter, IDLE, &[]);
                    output.settled = true;
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Another `secrets-mask-run` is among this process's ancestors.
fn under_mask_run() -> bool {
    let name = format!("secrets-mask-run{}", std::env::consts::EXE_SUFFIX);
    let mut at = i32::try_from(std::process::id()).ok().and_then(secrets::process::parent_of).unwrap_or(0);
    for _ in 0..64 {
        if at <= 1 {
            return false;
        }
        let exe = secrets::process::executable(at);
        if exe.is_some_and(|exe| exe.file_name().is_some_and(|found| found == name.as_str())) {
            return true;
        }
        let Some(parent) = secrets::process::parent_of(at) else { return false };
        at = parent;
    }
    false
}

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let [invocation] = args.as_slice() else {
        note("usage: secrets-mask-run <shell invocation>");
        return ExitCode::from(2);
    };
    let mut command = match command(invocation) {
        Ok(command) => command,
        Err(reason) => {
            note(&format!("{reason}; the command did not run"));
            return ExitCode::from(127);
        }
    };
    let relay = std::env::var_os("SECRETS_RELAY").filter(|p| !p.is_empty());
    #[cfg(unix)]
    let body = String::new();
    // held until this process exits: the relay finds the command's processes by it
    #[cfg(windows)]
    let (_job, body) = match secrets::job::Job::join_new() {
        Ok(job) => {
            let body = serde_json::json!({ "job": job.value() }).to_string();
            (Some(job), body)
        }
        Err(error) => {
            note(&format!("can't hold the command's processes in a job ({error}): what a program under another Git Bash program asks for counts as outside this session"));
            (None, String::new())
        }
    };
    let filter = match relay.as_deref().map(|relay| Filter::connect(relay, &body)) {
        Some(Ok(filter)) => filter,
        // A command a masked call started (a nested Claude Code session): its output goes through that call's.
        Some(Err(Unfiltered::InsideCall)) => return run_unfiltered(command),
        Some(Err(Unfiltered::Refused(_))) if under_mask_run() => return run_unfiltered(command),
        Some(Err(Unfiltered::Refused(reason))) => {
            note(&format!("{reason}, and nothing else masks its output, so the command did not run"));
            return ExitCode::from(126);
        }
        Some(Err(Unfiltered::Unreachable(reason))) => {
            note(&format!("{reason}; this output is not masked"));
            return run_unfiltered(command);
        }
        None => {
            note("no secrets relay; this output is not masked");
            return run_unfiltered(command);
        }
    };

    let mut child = match command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(error) => {
            note(&format!("can't run the command: {error}"));
            return ExitCode::from(127);
        }
    };
    forward_signals(&child);
    let mut outputs = [
        Output::new(STDOUT, child.stdout.take(), Box::new(std::io::stdout())),
        Output::new(STDERR, child.stderr.take(), Box::new(std::io::stderr())),
    ];
    copy(&mut outputs, Some(filter));

    match child.wait() {
        Ok(status) => exit_code(status),
        Err(error) => {
            note(&format!("can't wait for the command: {error}"));
            ExitCode::FAILURE
        }
    }
}
