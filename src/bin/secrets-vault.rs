//! Usage: secrets-vault list | secrets-vault get TAG
//!
//! `list` prints one line per vault entry this session can ask for: tag, kind, use, whether it is allowed in this
//! session, and its name, tab-separated; never a value. `get` prints the entry's value and a newline. Both wait while
//! the user unlocks the vault or decides; they exit 1 with a line on stderr when refused or when there is no such
//! entry.

use std::io::Write as _;
use std::process::ExitCode;

use serde::Deserialize;

fn fail(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "secrets-vault: {message}");
    ExitCode::FAILURE
}

#[derive(Deserialize)]
struct Listed {
    tag: String,
    kind: String,
    #[serde(rename = "use")]
    use_: String,
    allowed: bool,
    name: String,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pid = std::os::unix::process::parent_id();
    let (path, body, tag) = match args.as_slice() {
        [verb] if verb == "list" => ("/list", serde_json::json!({ "pid": pid }), None),
        [verb, tag] if verb == "get" => ("/get", serde_json::json!({ "tag": tag, "pid": pid }), Some(tag.as_str())),
        _ => return fail("usage: secrets-vault list | secrets-vault get TAG"),
    };
    let reply = match secrets::client::post(path, &body) {
        Ok(reply) => reply,
        Err(error) => return fail(&error),
    };
    let reason = String::from_utf8_lossy(&reply.body).into_owned();
    match (reply.status.as_str(), tag) {
        ("200", Some(_)) => {
            let mut out = std::io::stdout().lock();
            if out.write_all(&reply.body).and_then(|()| out.write_all(b"\n")).is_err() {
                return fail("can't write the value to stdout");
            }
            ExitCode::SUCCESS
        }
        ("200", None) => {
            let Ok(entries) = serde_json::from_slice::<Vec<Listed>>(&reply.body) else { return fail("the relay sent a list this version can't read") };
            let mut out = std::io::stdout().lock();
            for e in entries {
                let allowed = if e.allowed { "allowed" } else { "ask" };
                if writeln!(out, "{}\t{}\t{}\t{allowed}\t{}", e.tag, e.kind, e.use_, e.name).is_err() {
                    return fail("can't write the list to stdout");
                }
            }
            ExitCode::SUCCESS
        }
        ("403", Some(tag)) if reason.is_empty() => fail(&format!("refused: {tag}")),
        ("403", None) if reason.is_empty() => fail("refused"),
        (status, _) if reason.is_empty() => fail(&format!("the relay answered {status}")),
        (_, _) => fail(&reason),
    }
}
