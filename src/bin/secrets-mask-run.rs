//! Usage: secrets-mask-run '<shell invocation>'   (as `CLAUDE_CODE_SHELL_PREFIX`)
//!
//! Runs the invocation with `/bin/sh -c`, or through `$SECRETS_ORIG_PREFIX` when set, copying its stdout and
//! stderr with every value the relay at `$SECRETS_RELAY` knows masked (`secrets::mask`). Values shorter than
//! `$SECRETS_MASK_MIN` characters are skipped. Exits with the command's status, 128 + the signal when a signal
//! ended it. Without a relay the command still runs; one line on stderr says its output is unmasked.

use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Child, Command, ExitCode, Stdio};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::process::{Pid, Signal, kill_process};
use secrets::mask::Masker;
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

const IDLE: Timespec = Timespec { tv_sec: 0, tv_nsec: 50_000_000 };
const CHUNK: usize = 65536;

fn note(message: &str) {
    let _ = writeln!(std::io::stderr(), "secrets-mask-run: {message}");
}

/// The relay's `GET /watch` stream: an HTTP head, then one JSON string per line.
struct Watch {
    stream: UnixStream,
    raw: Vec<u8>,
    in_body: bool,
}

impl Watch {
    fn connect(path: &std::ffi::OsStr) -> Option<Self> {
        let mut stream = UnixStream::connect(path).ok()?;
        stream.write_all(b"GET /watch HTTP/1.0\r\n\r\n").ok()?;
        stream.set_nonblocking(true).ok()?;
        Some(Self { stream, raw: Vec::new(), in_body: false })
    }

    /// Takes in what arrived; false once the stream is over or the relay refused this process.
    fn drain(&mut self, masker: &mut Masker, buf: &mut [u8]) -> bool {
        let is_open = loop {
            match self.stream.read(buf) {
                Ok(0) => break false,
                Ok(n) => self.raw.extend_from_slice(buf.get(..n).unwrap_or_default()),
                Err(e) if e.kind() == ErrorKind::WouldBlock => break true,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(_) => break false,
            }
        };
        self.take_in(masker) && is_open
    }

    fn take_in(&mut self, masker: &mut Masker) -> bool {
        if !self.in_body {
            let Some(end) = memchr::memmem::find(&self.raw, b"\r\n\r\n") else { return true };
            let status = self.raw.split(|b| *b == b' ').nth(1).unwrap_or_default().to_vec();
            if status != b"200" {
                let status = String::from_utf8_lossy(&status);
                note(&format!("the secrets relay refused this process ({status}); this output is not masked"));
                return false;
            }
            self.raw.drain(..end + 4);
            self.in_body = true;
        }
        while let Some(newline) = memchr::memchr(b'\n', &self.raw) {
            let line: Vec<u8> = self.raw.drain(..=newline).collect();
            if let Ok(value) = serde_json::from_slice::<String>(&line) {
                masker.add(&value);
            }
        }
        true
    }
}

/// One of the command's output streams, with what it holds back.
struct Output {
    pipe: Option<Box<dyn Read>>,
    fd: Option<std::os::fd::OwnedFd>,
    held: Vec<u8>,
    /// What an idle flush kept back: only more output can change it.
    settled: bool,
    sink: Box<dyn Write>,
}

impl Output {
    fn new<P: Read + Into<std::os::fd::OwnedFd> + std::os::fd::AsFd + 'static>(pipe: Option<P>, sink: Box<dyn Write>) -> Self {
        let fd = pipe.as_ref().and_then(|p| p.as_fd().try_clone_to_owned().ok());
        Self { pipe: pipe.map(|p| Box::new(p) as Box<dyn Read>), fd, held: Vec::new(), settled: false, sink }
    }

    fn is_open(&self) -> bool {
        self.pipe.is_some()
    }

    fn waiting(&self) -> bool {
        self.is_open() && !self.held.is_empty() && !self.settled
    }

    fn write(&mut self, bytes: &[u8]) {
        let _ = self.sink.write_all(bytes).and_then(|()| self.sink.flush());
    }

    /// Masks and writes what can go out now; `idle` lets everything go but a tail that could become a value.
    fn flush(&mut self, masker: &Masker, idle: bool) {
        let data = std::mem::take(&mut self.held);
        let cut = masker.cut(&data, idle);
        self.write(&masker.mask(data.get(..cut).unwrap_or_default()));
        self.held = data.get(cut..).unwrap_or_default().to_vec();
        self.settled = idle;
    }

    fn read(&mut self, masker: &Masker, buf: &mut [u8]) {
        let Some(pipe) = self.pipe.as_mut() else { return };
        match pipe.read(buf) {
            Ok(n) if n > 0 => {
                self.held.extend_from_slice(buf.get(..n).unwrap_or_default());
                self.flush(masker, false);
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            _ => {
                let rest = masker.mask(&std::mem::take(&mut self.held));
                self.write(&rest);
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

/// Copies the command's output, masked, until both streams end.
fn copy(outputs: &mut [Output; 2], mut watch: Option<Watch>, masker: &mut Masker) {
    let mut buf = vec![0u8; CHUNK];
    while outputs.iter().any(Output::is_open) {
        let waiting = outputs.iter().any(Output::waiting);
        let (ready, polled) = {
            let mut fds: Vec<PollFd<'_>> = outputs.iter().filter_map(|o| o.fd.as_ref()).map(|fd| PollFd::new(fd, PollFlags::IN)).collect();
            if let Some(watch) = &watch {
                fds.push(PollFd::new(&watch.stream, PollFlags::IN));
            }
            let polled = poll(&mut fds, waiting.then_some(&IDLE));
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
            Ok(_) => {}
        }
        if let Some(stream) = watch.as_mut()
            && !stream.drain(masker, &mut buf)
        {
            watch = None;
        }
        if polled == Ok(0) {
            for output in outputs.iter_mut().filter(|o| o.waiting()) {
                output.flush(masker, true);
            }
            continue;
        }
        for (output, ready) in outputs.iter_mut().zip(ready) {
            if ready {
                output.read(masker, &mut buf);
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
    let Some(watch) = std::env::var_os("SECRETS_RELAY").filter(|p| !p.is_empty()).and_then(|p| Watch::connect(&p)) else {
        note("no secrets relay; this output is not masked");
        let error = command.exec();
        note(&format!("can't run the command: {error}"));
        return ExitCode::from(127);
    };
    let min_length = std::env::var("SECRETS_MASK_MIN").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or_else(|| {
        note("SECRETS_MASK_MIN is not a number; masking values of any length");
        1
    });

    let mut child = match command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(error) => {
            note(&format!("can't run the command: {error}"));
            return ExitCode::from(127);
        }
    };
    forward_signals(&child);
    let mut outputs = [
        Output::new(child.stdout.take(), Box::new(std::io::stdout())),
        Output::new(child.stderr.take(), Box::new(std::io::stderr())),
    ];
    copy(&mut outputs, Some(watch), &mut Masker::new(min_length));

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
