//! Usage: secrets-askpass-sudo [prompt]
//!
//! The session's `SUDO_ASKPASS`: asks with tag `sudo`.

fn main() -> std::process::ExitCode {
    secrets::askpass::run("secrets-askpass-sudo", Some("sudo"))
}
