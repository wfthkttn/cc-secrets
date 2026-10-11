//! Usage: secrets-ask [prompt]
//!
//! The session's askpass: asks the relay at `$SECRETS_RELAY` and prints the answer and a newline. Exits 1 with a
//! line on stderr when the user cancels or the relay can't be reached.

use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;

fn fail(message: &str) -> ExitCode {
    let _ = writeln!(std::io::stderr(), "secrets-ask: {message}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let Some(relay) = std::env::var_os("SECRETS_RELAY").filter(|v| !v.is_empty()) else {
        return fail("SECRETS_RELAY is not set; run it inside a Claude Code session with the secrets plugin");
    };
    let relay_shown = relay.to_string_lossy().into_owned();
    let words: Vec<String> = std::env::args().skip(1).collect();
    let prompt = if words.is_empty() { "Password:".to_owned() } else { words.join(" ") };
    let body = serde_json::json!({ "prompt": prompt, "pid": std::os::unix::process::parent_id() }).to_string();
    let request = format!("POST /ask HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());

    let mut reply = Vec::new();
    let sent = UnixStream::connect(&relay).and_then(|mut stream| {
        stream.write_all(request.as_bytes())?;
        stream.read_to_end(&mut reply)
    });
    if let Err(error) = sent {
        return fail(&format!("relay {relay_shown}: {error}"));
    }
    let Some(head_end) = memchr::memmem::find(&reply, b"\r\n\r\n") else {
        return fail(&format!("relay {relay_shown} sent no complete reply"));
    };
    let status = reply.split(|b| *b == b' ').nth(1).map(String::from_utf8_lossy).unwrap_or_default().into_owned();
    match status.as_str() {
        "200" => {
            let mut out = std::io::stdout().lock();
            let written = out.write_all(reply.get(head_end + 4..).unwrap_or_default()).and_then(|()| out.write_all(b"\n"));
            if written.is_err() {
                return fail("can't write the answer to stdout");
            }
            ExitCode::SUCCESS
        }
        "403" => fail(&format!("the user cancelled: {prompt}")),
        _ => fail(&format!("relay {relay_shown} answered {status}")),
    }
}
