//! Usage: secrets-askpass [prompt]
//!
//! The session's `SUDO_ASKPASS`, `SSH_ASKPASS` and `GIT_ASKPASS`: `secrets ask` with the prompt the program gives.
//! Prints the answer and a newline; exits 1 with a line on stderr when the user cancels or the relay can't be
//! reached.

use std::io::Write as _;
use std::process::ExitCode;

fn main() -> ExitCode {
    let words: Vec<String> = std::env::args().skip(1).collect();
    let prompt = if words.is_empty() { "Password:".to_owned() } else { words.join(" ") };
    let printed = secrets::client::ask(&prompt, None).and_then(|value| {
        let mut out = std::io::stdout().lock();
        out.write_all(&value).and_then(|()| out.write_all(b"\n")).map_err(|_| "can't write the answer to stdout".to_owned())
    });
    match printed {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "secrets-askpass: {error}");
            ExitCode::FAILURE
        }
    }
}
