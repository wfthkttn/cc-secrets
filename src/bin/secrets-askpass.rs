//! Usage: secrets-askpass [prompt]
//!
//! `secrets ask` with the prompt the program gives, untagged. Prints the answer and a newline; exits 1 with a line on
//! stderr when the user cancels or the relay can't be reached.

fn main() -> std::process::ExitCode {
    secrets::askpass::run("secrets-askpass", None)
}
