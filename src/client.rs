//! One HTTP/1.0 request to the relay at `$SECRETS_RELAY`, for the helpers commands run.

use std::io::{Read as _, Write as _};
use std::os::unix::net::UnixStream;

pub struct Reply {
    pub status: String,
    pub body: Vec<u8>,
}

/// Asks the user for a secret, `tag` naming the vault entry they may pick; the value, or the reason there is none.
pub fn ask(prompt: &str, tag: Option<&str>) -> Result<Vec<u8>, String> {
    let reply = post("/ask", &serde_json::json!({ "prompt": prompt, "tag": tag }))?;
    match reply.status.as_str() {
        "200" => Ok(reply.body),
        "403" => Err(format!("the user cancelled: {prompt}")),
        status => Err(format!("the relay answered {status}")),
    }
}

/// Posts `body` (JSON) to `path` and waits for the whole reply; the error names the relay and what failed.
pub fn post(path: &str, body: &serde_json::Value) -> Result<Reply, String> {
    let Some(relay) = std::env::var_os("SECRETS_RELAY").filter(|v| !v.is_empty()) else {
        return Err("SECRETS_RELAY is not set; run it inside a Claude Code session with the secrets plugin".to_owned());
    };
    let shown = relay.to_string_lossy().into_owned();
    let body = body.to_string();
    let request = format!("POST {path} HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let mut reply = Vec::new();
    UnixStream::connect(&relay)
        .and_then(|mut stream| {
            stream.write_all(request.as_bytes())?;
            stream.read_to_end(&mut reply)
        })
        .map_err(|error| format!("relay {shown}: {error}"))?;
    let head_end = memchr::memmem::find(&reply, b"\r\n\r\n").ok_or_else(|| format!("relay {shown} sent no complete reply"))?;
    let status = reply.split(|b| *b == b' ').nth(1).map(String::from_utf8_lossy).unwrap_or_default().into_owned();
    Ok(Reply { status, body: reply.get(head_end + 4..).unwrap_or_default().to_vec() })
}
