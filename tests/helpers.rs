//! Runs secrets-relay, secrets-mask-run and secrets-ask together, without Claude Code.
// clippy.toml's test allowances reach #[test] functions, not this file's helpers.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Output, Stdio};
use std::time::{Duration, Instant};

const RELAY: &str = env!("CARGO_BIN_EXE_secrets-relay");
const MASK_RUN: &str = env!("CARGO_BIN_EXE_secrets-mask-run");
const ASK: &str = env!("CARGO_BIN_EXE_secrets-ask");

struct Relay {
    child: Child,
    events: BufReader<ChildStdout>,
    socket: PathBuf,
}

impl Relay {
    fn start(name: &str) -> Self {
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map_or_else(std::env::temp_dir, PathBuf::from);
        let socket = dir.join(format!("secrets-test-{name}-{}.sock", std::process::id()));
        let mut child = Command::new(RELAY).arg(&socket).stdout(Stdio::piped()).spawn().unwrap();
        let mut events = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        events.read_line(&mut ready).unwrap();
        assert!(ready.contains("\"ready\""), "{ready}");
        Self { child, events, socket }
    }

    fn mask_run(&self, command: &str, env: &[(&str, &str)]) -> Command {
        let mut run = Command::new(MASK_RUN);
        run.arg(command)
            .env("SECRETS_RELAY", &self.socket)
            .env("ASK_SECRET", ASK)
            .env("SECRETS_MASK_MIN", "6")
            .env_remove("SECRETS_ORIG_PREFIX")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            run.env(key, value);
        }
        run
    }

    /// Waits for the relay's next ask and answers it with `secret`; the relay's status.
    fn answer_next(&mut self, secret: &str) -> String {
        let mut line = String::new();
        self.events.read_line(&mut line).unwrap();
        let event: serde_json::Value = serde_json::from_str(&line).unwrap();
        let id = event["ask"]["id"].as_str().unwrap().to_owned();
        post(&self.socket, "/answer", &serde_json::json!({ "id": id, "secret": secret }))
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn post(socket: &Path, path: &str, body: &serde_json::Value) -> String {
    let body = body.to_string();
    let mut stream = UnixStream::connect(socket).unwrap();
    write!(stream, "POST {path} HTTP/1.0\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    reply.split(' ').nth(1).unwrap().to_owned()
}

fn run(mut command: Command) -> Output {
    command.output().unwrap()
}

#[test]
fn a_value_typed_mid_command_is_masked_on_both_streams_and_the_status_passes_through() {
    let mut relay = Relay::start("typed");
    let child = relay.mask_run(r#"x=$($ASK_SECRET "t1"); printf "got %s\n" "$x"; printf "%s" "$x" >&2; exit 3"#, &[]).spawn().unwrap();
    assert_eq!(relay.answer_next("hunter2"), "204");
    let out = child.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "got [secret]\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "[secret]");
    assert_eq!(out.status.code(), Some(3));
}

#[test]
fn a_value_under_the_minimum_stays_and_without_a_minimum_every_value_is_masked() {
    let mut relay = Relay::start("short");
    let child = relay.mask_run(r#"x=$($ASK_SECRET "t2"); printf "%s and hunter2\n" "$x""#, &[]).spawn().unwrap();
    assert_eq!(relay.answer_next("abc"), "204");
    let child_out = child.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&child_out.stdout), "abc and hunter2\n");
    let first = relay.mask_run(r#"x=$($ASK_SECRET "t3"); echo "$x""#, &[]).spawn().unwrap();
    assert_eq!(relay.answer_next("hunter2"), "204");
    first.wait_with_output().unwrap();
    let out = run(relay.mask_run(r#"printf "abc""#, &[("SECRETS_MASK_MIN", "")]));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "[secret]");
    assert!(String::from_utf8_lossy(&out.stderr).contains("SECRETS_MASK_MIN"));
}

#[test]
fn split_values_encoded_forms_and_glued_tokens_are_masked() {
    let mut relay = Relay::start("forms");
    let child = relay.mask_run(r#"x=$($ASK_SECRET "t4"); echo "$x" > /dev/null"#, &[]).spawn().unwrap();
    assert_eq!(relay.answer_next("hunter2"), "204");
    child.wait_with_output().unwrap();
    let cases = [
        (r#"printf "hun"; sleep 0.3; printf "ter2 and hunt"; sleep 0.3; printf "er2\n""#, "[secret] and [secret]\n"),
        (r#"printf "hunt""#, "hunt"),
        (r#"printf "auth: %s\n" "$(printf "alex:%s" hunter2 | base64)""#, "auth: [secret]\n"),
        (r#"printf "pw=hunter2;rest more\n""#, "[secret] more\n"),
    ];
    for (command, want) in cases {
        let out = run(relay.mask_run(command, &[]));
        assert_eq!(String::from_utf8_lossy(&out.stdout), want, "{command}");
    }
    let out = run(relay.mask_run(r#"printf "\000\377binary""#, &[]));
    assert_eq!(out.stdout, b"\x00\xffbinary");
}

#[test]
fn output_flows_while_the_command_runs() {
    let relay = Relay::start("flow");
    let mut child = relay.mask_run("printf 'Enter: '; sleep 2; echo done", &[]).spawn().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let started = Instant::now();
    let mut first = [0u8; 7];
    stdout.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"Enter: ");
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    child.wait().unwrap();

    let mut echo = relay.mask_run(r#"while read -r line; do printf "%s\n" "$line"; done"#, &[]).stdin(Stdio::piped()).spawn().unwrap();
    let mut stdin = echo.stdin.take().unwrap();
    stdin.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1}\n").unwrap();
    let mut line = String::new();
    BufReader::new(echo.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line, "{\"jsonrpc\":\"2.0\",\"id\":1}\n");
    drop(stdin);
    echo.wait().unwrap();
}

#[test]
fn a_signal_ends_it_as_128_plus_the_signal() {
    let relay = Relay::start("signal");
    let out = run(relay.mask_run("kill -TERM $$", &[]));
    assert_eq!(out.status.code(), Some(128 + 15));
}

#[test]
fn without_a_relay_the_command_still_runs_and_says_so() {
    let out = Command::new(MASK_RUN).arg("echo hunter2").env("SECRETS_RELAY", "/nonexistent/relay.sock").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "hunter2\n");
    assert!(String::from_utf8_lossy(&out.stderr).contains("not masked"));
}

#[test]
fn only_mask_run_started_by_the_relays_parent_gets_the_values() {
    let mut relay = Relay::start("peer");
    let child = relay.mask_run(r#"x=$($ASK_SECRET "t5"); echo "$x" > /dev/null"#, &[]).spawn().unwrap();
    assert_eq!(relay.answer_next("hunter2"), "204");
    child.wait_with_output().unwrap();
    let nested = format!("'{MASK_RUN}' 'echo hunter2'");
    let out = run(relay.mask_run(&nested, &[]));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "[secret]\n");
    assert!(String::from_utf8_lossy(&out.stderr).contains("refused"), "{}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_cancelled_ask_exits_1_with_a_line() {
    let mut relay = Relay::start("cancel");
    let child = Command::new(ASK).arg("deploy token").env("SECRETS_RELAY", &relay.socket).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    relay.events.read_line(&mut line).unwrap();
    let event: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(event["ask"]["prompt"], "deploy token");
    let id = event["ask"]["id"].as_str().unwrap();
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": id, "cancel": true })), "204");
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&out.stderr), "secrets-ask: the user cancelled: deploy token\n");
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": id, "secret": "late" })), "410");
}
