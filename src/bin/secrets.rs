//! Usage: secrets ask [--tag TAG] PROMPT
//!
//! Asks the user for a secret and prints it and a newline: they type it, or pick a vault entry, the one tagged TAG
//! offered first; an entry allowed for this session comes without asking, one refused for it is refused. Exits 1
//! with a line on stderr when refused or cancelled.

use std::io::Write as _;
use std::process::ExitCode;

const USAGE: &str = "usage: secrets ask [--tag TAG] PROMPT";

fn fail(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "secrets: {message}");
    ExitCode::FAILURE
}

fn ask(args: &[String]) -> ExitCode {
    let (tag, words) = match args {
        [flag, tag, words @ ..] if flag == "--tag" => (Some(tag.as_str()), words),
        words => (None, words),
    };
    if words.is_empty() {
        return fail(USAGE);
    }
    let value = match secrets::client::ask(&words.join(" "), tag) {
        Ok(value) => value,
        Err(error) => return fail(&error),
    };
    let mut out = std::io::stdout().lock();
    if out.write_all(&value).and_then(|()| out.write_all(b"\n")).is_err() {
        return fail("can't write the value to stdout");
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((verb, rest)) if verb == "ask" => ask(rest),
        _ => fail(USAGE),
    }
}
