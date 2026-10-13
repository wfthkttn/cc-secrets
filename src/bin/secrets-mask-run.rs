//! Usage: secrets-mask-run '<shell invocation>'   (as `CLAUDE_CODE_SHELL_PREFIX`)
//!
//! Runs the invocation with `/bin/sh -c`, or through `$SECRETS_ORIG_PREFIX` when set, passing its stdout and
//! stderr through the relay at `$SECRETS_RELAY`, which masks them (`secrets::filter`); this process holds no values.
//! Exits with the command's status, 128 + the signal when a signal ended it. Without a relay the command still runs;
//! one line on stderr says its output is unmasked. Refused by the relay, it runs only under another mask-run, which
//! masks its output; otherwise it exits 126 without running it. A relay that goes away mid-call may have handed the
//! call a value, so the rest of its output is withheld; the command runs on.

use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Child, Command, ExitCode, Stdio};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::{Pid, Signal, kill_process};
use secrets::filter::{self as frame, DATA, END, IDLE, STDERR, STDOUT};
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

const IDLE_AFTER: Timespec = Timespec { tv_sec: 0, tv_nsec: 50_000_000 };
const CHUNK: usize = 65536;
const HEAD_MAX: usize = 4096;

fn note(message: &str) {
    let _ = writeln!(std::io::stderr(), "secrets-mask-run: {message}");
}

/// The relay's `/filter` stream for this call.
struct Filter {
    stream: UnixStream,
}

enum Unfiltered {
    /// No relay answers: nothing was handed out through it.
    Unreachable(String),
    /// A relay answers and won't filter this process: it isn't the call Claude Code started.
    Refused(String),
}

impl Filter {
    /// Opens the stream; once this returns, the relay knows the call, so a value handed to it is masked.
    fn connect(path: &std::ffi::OsStr) -> Result<Self, Unfiltered> {
        let mut stream = UnixStream::connect(path).map_err(|e| Unfiltered::Unreachable(format!("no secrets relay ({e})")))?;
        stream
            .write_all(b"POST /filter HTTP/1.0\r\nContent-Length: 0\r\n\r\n")
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
    pipe: Option<Box<dyn Read>>,
    fd: Option<std::os::fd::OwnedFd>,
    /// The relay holds a tail back that only more output or an idle pass lets out.
    holding: bool,
    /// The idle pass went since the last output.
    settled: bool,
    sink: Box<dyn Write>,
}

impl Output {
    fn new<P: Read + Into<std::os::fd::OwnedFd> + std::os::fd::AsFd + 'static>(which: u8, pipe: Option<P>, sink: Box<dyn Write>) -> Self {
        let fd = pipe.as_ref().and_then(|p| p.as_fd().try_clone_to_owned().ok());
        Self { which, pipe: pipe.map(|p| Box::new(p) as Box<dyn Read>), fd, holding: false, settled: false, sink }
    }

    fn is_open(&self) -> bool {
        self.pipe.is_some()
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

    fn read(&mut self, filter: &mut Option<Filter>, buf: &mut [u8]) {
        let Some(pipe) = self.pipe.as_mut() else { return };
        match pipe.read(buf) {
            Ok(n) if n > 0 => {
                self.settled = false;
                self.pass(filter, DATA, buf.get(..n).unwrap_or_default());
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            _ => {
                self.pass(filter, END, &[]);
                self.pipe = None;
                self.fd = None;
            }
        }
    }
}

fn command(invocation: &std::ffi::OsStr) -> Command {
    if let Some(prefix) = std::env::var_os("SECRETS_ORIG_PREFIX").filter(|p| !p.is_empty()) {
        let mut command = Command::new(prefix);
        command.arg(invocation);
        command
    } else {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(invocation);
        command
    }
}

/// Passes TERM, INT and HUP on to the command.
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

fn is_readable(fd: Option<&PollFd<'_>>) -> bool {
    fd.is_some_and(|fd| fd.revents().intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR))
}

/// Copies the command's output through the relay until both streams end.
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

/// Another `secrets-mask-run` is among this process's ancestors.
fn under_mask_run() -> bool {
    let parent_of = |pid: i32| -> Option<i32> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
    };
    let mut at = rustix::process::getppid().map_or(0, Pid::as_raw_pid);
    for _ in 0..64 {
        if at <= 1 {
            return false;
        }
        let exe = std::fs::read_link(format!("/proc/{at}/exe"));
        if exe.is_ok_and(|exe| exe.file_name().is_some_and(|name| name == "secrets-mask-run")) {
            return true;
        }
        let Some(parent) = parent_of(at) else { return false };
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
    let mut command = command(invocation);
    let relay = std::env::var_os("SECRETS_RELAY").filter(|p| !p.is_empty());
    let filter = match relay.as_deref().map(Filter::connect) {
        Some(Ok(filter)) => filter,
        // A command a masked call started (a nested Claude Code session): its output goes through that call's.
        Some(Err(Unfiltered::Refused(_))) if under_mask_run() => {
            let error = command.exec();
            note(&format!("can't run the command: {error}"));
            return ExitCode::from(127);
        }
        Some(Err(Unfiltered::Refused(reason))) => {
            note(&format!("{reason}, and nothing else masks its output, so the command did not run"));
            return ExitCode::from(126);
        }
        Some(Err(Unfiltered::Unreachable(reason))) => {
            note(&format!("{reason}; this output is not masked"));
            let error = command.exec();
            note(&format!("can't run the command: {error}"));
            return ExitCode::from(127);
        }
        None => {
            note("no secrets relay; this output is not masked");
            let error = command.exec();
            note(&format!("can't run the command: {error}"));
            return ExitCode::from(127);
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
        Ok(status) => match (status.code(), status.signal()) {
            (Some(code), _) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            (None, Some(signal)) => ExitCode::from(u8::try_from(128 + signal).unwrap_or(128)),
            (None, None) => ExitCode::FAILURE,
        },
        Err(error) => {
            note(&format!("can't wait for the command: {error}"));
            ExitCode::FAILURE
        }
    }
}
