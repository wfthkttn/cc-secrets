//! Usage: secrets ask [--tag TAG] PROMPT | secrets list
//!
//! `ask` asks the user for a secret and prints it and a newline: they type it, or pick a vault entry, the one
//! tagged TAG offered first; an entry allowed for this session comes without asking, one refused for it is refused.
//! `list` prints one line per vault entry: tag, kind, this session's access (ask, allowed or refused), and its
//! name, tab-separated; never a value. Both exit 1 with a line on stderr when refused, cancelled or the vault is
//! closed.

use std::io::Write as _;
use std::process::ExitCode;

use serde::Deserialize;

const USAGE: &str = "usage: secrets ask [--tag TAG] PROMPT | secrets list";

fn fail(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "secrets: {message}");
    ExitCode::FAILURE
}

#[derive(Deserialize)]
struct Listed {
    tag: String,
    kind: String,
    access: String,
    name: String,
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

fn list() -> ExitCode {
    let reply = match secrets::client::post("/list", &serde_json::json!({})) {
        Ok(reply) => reply,
        Err(error) => return fail(&error),
    };
    match reply.status.as_str() {
        "200" => {}
        "403" if reply.body.is_empty() => return fail("refused"),
        status if reply.body.is_empty() => return fail(&format!("the relay answered {status}")),
        _ => return fail(&String::from_utf8_lossy(&reply.body)),
    }
    let Ok(entries) = serde_json::from_slice::<Vec<Listed>>(&reply.body) else { return fail("the relay sent a list this version can't read") };
    let mut out = std::io::stdout().lock();
    for e in entries {
        if writeln!(out, "{}\t{}\t{}\t{}", e.tag, e.kind, e.access, e.name).is_err() {
            return fail("can't write the list to stdout");
        }
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((verb, rest)) if verb == "ask" => ask(rest),
        Some((verb, [])) if verb == "list" => list(),
        _ => fail(USAGE),
    }
}
