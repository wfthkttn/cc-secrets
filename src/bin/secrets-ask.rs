//! Usage: secrets-ask [prompt]
//!
//! The session's askpass: asks the relay at `$SECRETS_RELAY` and prints the answer and a newline. Exits 1 with a
//! line on stderr when the user cancels or the relay can't be reached.

use std::io::Write as _;
use std::process::ExitCode;

fn fail(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "secrets-ask: {message}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let words: Vec<String> = std::env::args().skip(1).collect();
    let prompt = if words.is_empty() { "Password:".to_owned() } else { words.join(" ") };
    let reply = match secrets::client::post("/ask", &serde_json::json!({ "prompt": prompt, "pid": std::os::unix::process::parent_id() })) {
        Ok(reply) => reply,
        Err(error) => return fail(&error),
    };
    match reply.status.as_str() {
        "200" => {
            let mut out = std::io::stdout().lock();
            if out.write_all(&reply.body).and_then(|()| out.write_all(b"\n")).is_err() {
                return fail("can't write the answer to stdout");
            }
            ExitCode::SUCCESS
        }
        "403" => fail(&format!("the user cancelled: {prompt}")),
        status => fail(&format!("the relay answered {status}")),
    }
}
