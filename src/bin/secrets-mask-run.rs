//! Usage: secrets-mask-run '<shell invocation>'   (as `CLAUDE_CODE_SHELL_PREFIX`)
//!
//! Runs the invocation with `/bin/sh -c`, or through `$SECRETS_ORIG_PREFIX` when set, passing its stdout and
//! stderr through the relay at `$SECRETS_RELAY`, which masks them (`secrets::filter`); this process holds no values.
//! Exits with the command's status, 128 + the signal when a signal ended it. Without a relay, or refused by it, the
//! command still runs; one line on stderr says its output is unmasked.

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

impl Filter {
    /// Opens the stream; once this returns, the relay knows the call, so a value handed to it is masked.
    fn connect(path: &std::ffi::OsStr) -> Result<Self, String> {
        let mut stream = UnixStream::connect(path).map_err(|e| format!("no secrets relay ({e})"))?;
        stream.write_all(b"POST /filter HTTP/1.0\r\nContent-Length: 0\r\n\r\n").map_err(|e| format!("the secrets relay can't be reached ({e})"))?;
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if head.len() > HEAD_MAX || stream.read_exact(&mut byte).is_err() {
                return Err("the secrets relay sent no answer".to_owned());
            }
            head.extend_from_slice(&byte);
        }
        let status = head.split(|b| *b == b' ').nth(1).unwrap_or_default();
        if status != b"200" {
            return Err(format!("the secrets relay refused this process ({})", String::from_utf8_lossy(status)));
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

    /// Passes a piece through the relay; once the relay is gone, the rest goes out unmasked, after one line saying so.
    fn pass(&mut self, filter: &mut Option<Filter>, kind: u8, body: &[u8]) {
        let Some(open) = filter.as_mut() else { return self.write(body) };
        match open.send(kind, self.which, body) {
            Ok((out, holding)) => {
                self.write(&out);
                self.holding = holding;
            }
            Err(error) => {
                *filter = None;
                self.holding = false;
                note(&format!("the secrets relay stopped ({error}); what it held back is dropped and the rest is not masked"));
                self.write(body);
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
        Some(Err(reason)) => {
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
