//! Usage: secrets-askpass-ssh [prompt]
//!
//! The session's `SSH_ASKPASS`: asks with tag `ssh`.

fn main() -> std::process::ExitCode {
    secrets::askpass::run("secrets-askpass-ssh", Some("ssh"))
}
