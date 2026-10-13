//! The askpass helpers: `secrets ask` with the prompt the program gives. sudo, ssh and git run their askpass
//! variable as a bare path, so each gets a binary of its own whose tag lets an entry allowed for the session answer.

use std::io::Write as _;
use std::process::ExitCode;

/// Prints the answer and a newline; exits 1 with a line on stderr, headed `name`, when the user cancels or the relay
/// can't be reached.
#[must_use]
pub fn run(name: &str, tag: Option<&str>) -> ExitCode {
    let words: Vec<String> = std::env::args().skip(1).collect();
    let prompt = if words.is_empty() { "Password:".to_owned() } else { words.join(" ") };
    let printed = crate::client::ask(&prompt, tag).and_then(|value| {
        let mut out = std::io::stdout().lock();
        out.write_all(&value).and_then(|()| out.write_all(b"\n")).map_err(|_| "can't write the answer to stdout".to_owned())
    });
    match printed {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "{name}: {error}");
            ExitCode::FAILURE
        }
    }
}
