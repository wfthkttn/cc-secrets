//! Usage: secrets-askpass-git [prompt]
//!
//! The session's `GIT_ASKPASS`: asks with tag `git`.

fn main() -> std::process::ExitCode {
    secrets::askpass::run("secrets-askpass-git", Some("git"))
}
