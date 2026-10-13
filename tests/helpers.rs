//! Runs secrets-relay, secrets-mask-run, secrets and secrets-askpass together, without Claude Code.
// clippy.toml's test allowances reach #[test] functions, not this file's helpers.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Output, Stdio};
use std::time::{Duration, Instant};

use secrets::vault::{Costs, Entry, Kind, Use, Vault};

const RELAY: &str = env!("CARGO_BIN_EXE_secrets-relay");
const MASK_RUN: &str = env!("CARGO_BIN_EXE_secrets-mask-run");
const SECRETS: &str = env!("CARGO_BIN_EXE_secrets");
const ASKPASS: &str = env!("CARGO_BIN_EXE_secrets-askpass");

struct Relay {
    child: Child,
    events: BufReader<ChildStdout>,
    socket: PathBuf,
    /// The vault state the relay started with.
    vault: String,
    /// The helpers it pinned, as the hooks run them.
    bin: PathBuf,
}

/// A data dir of the test's own, so no test touches the user's vault.
fn data_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("secrets-test-data-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

impl Relay {
    fn start(name: &str) -> Self {
        Self::start_in(name, &data_dir(name))
    }

    fn start_in(name: &str, data: &Path) -> Self {
        Self::start_with(name, data, &[])
    }

    fn start_with(name: &str, data: &Path, env: &[(&str, &Path)]) -> Self {
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map_or_else(std::env::temp_dir, PathBuf::from);
        let socket = dir.join(format!("secrets-test-{name}-{}.sock", std::process::id()));
        let mut relay = Command::new(RELAY);
        relay.arg(&socket).env("XDG_DATA_HOME", data).env_remove("SECRETS_UPSTREAM_AGENT").stdout(Stdio::piped());
        for (key, value) in env {
            relay.env(key, value);
        }
        let mut child = relay.spawn().unwrap();
        let mut events = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        events.read_line(&mut ready).unwrap();
        let ready: serde_json::Value = serde_json::from_str(&ready).unwrap();
        assert!(ready["ready"].is_string(), "{ready}");
        let vault = ready["vault"].as_str().unwrap().to_owned();
        let bin = PathBuf::from(ready["bin"].as_str().unwrap());
        Self { child, events, socket, vault, bin }
    }

    fn raw_event(&mut self) -> serde_json::Value {
        let mut line = String::new();
        self.events.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    /// The next event but `{"masked": true}`, which comes whenever masking first finds something, and `{"masking":
    /// …}`, which comes whenever values to mask come or go.
    fn next_event(&mut self) -> serde_json::Value {
        loop {
            let event = self.raw_event();
            if event != serde_json::json!({ "masked": true }) && event.get("masking").is_none() {
                return event;
            }
        }
    }

    /// The next event, which must be an ask.
    fn next_ask(&mut self) -> serde_json::Value {
        let event = self.next_event();
        assert!(event["ask"]["id"].is_string(), "{event}");
        event["ask"].clone()
    }

    /// Waits for the relay's next ask and answers it with `secret`; the relay's status.
    fn answer_next(&mut self, secret: &str) -> String {
        let ask = self.next_ask();
        post(&self.socket, "/answer", &serde_json::json!({ "id": ask["id"], "secret": secret }))
    }

    /// Waits for the next decision event, `name`, and decides it; the event.
    fn decide_next(&mut self, name: &str, decision: &str) -> serde_json::Value {
        let event = self.next_event();
        assert!(event[name]["id"].is_string(), "{event}");
        let id = event[name]["id"].as_str().unwrap().to_owned();
        assert_eq!(post(&self.socket, "/decide", &serde_json::json!({ "id": id, "decision": decision })), "204");
        event[name].clone()
    }

    fn agent(&self) -> PathBuf {
        PathBuf::from(format!("{}.agent", self.socket.display()))
    }

    /// Adds an entry; its id.
    fn add(&mut self, name: &str, tag: &str, kind: &str, use_: &str, value: &str) -> String {
        let added = serde_json::json!({ "op": "add", "name": name, "tag": tag, "kind": kind, "use": use_, "value": value });
        let (status, body) = post_reply(&self.socket, "/vault", &added);
        assert_eq!(status, "200", "{body}");
        assert_eq!(self.next_event(), serde_json::json!({ "vault": "open" }));
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["id"].as_str().unwrap().to_owned()
    }

    /// Adds an ssh key entry from a key file; the relay's status and reason.
    fn add_key(&mut self, tag: &str, file: &Path) -> (String, String) {
        let added = serde_json::json!({ "op": "add", "name": format!("{tag} key"), "tag": tag, "kind": "ssh-key", "use": "session", "value": file });
        let reply = post_reply(&self.socket, "/vault", &added);
        if reply.0 == "200" {
            assert_eq!(self.next_event(), serde_json::json!({ "vault": "open" }));
        }
        reply
    }

    /// `secrets` with `args`, run straight from the relay's parent: outside any call.
    fn secrets(&self, args: &[&str]) -> Command {
        let mut command = Command::new(self.bin.join("secrets"));
        command.args(args).env("SECRETS_RELAY", &self.socket).stdout(Stdio::piped()).stderr(Stdio::piped());
        command
    }

    fn get(&self, path: &str) -> (String, serde_json::Value) {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        write!(stream, "GET {path} HTTP/1.0\r\n\r\n").unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        let (head, body) = reply.split_once("\r\n\r\n").unwrap();
        (head.split(' ').nth(1).unwrap().to_owned(), serde_json::from_str(body).unwrap_or(serde_json::Value::Null))
    }

    /// A call as Claude Code runs it: `$SECRETS` is the `secrets` command.
    fn mask_run(&self, command: &str) -> Command {
        let mut run = Command::new(self.bin.join("secrets-mask-run"));
        run.arg(command)
            .env("SECRETS_RELAY", &self.socket)
            .env("SECRETS", self.bin.join("secrets"))
            .env_remove("SECRETS_ORIG_PREFIX")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        run
    }

    fn create_vault(&mut self, passphrase: &str) {
        assert_eq!(self.vault, "absent");
        assert_eq!(post(&self.socket, "/create", &serde_json::json!({ "passphrase": passphrase })), "204");
        assert_eq!(self.next_event(), serde_json::json!({ "vault": "open" }));
    }
}

impl Relay {
    /// Ends it as Claude Code does, with SIGTERM, so it removes what it made; killed if it doesn't end soon.
    fn stop(&mut self) {
        let pid = rustix::process::Pid::from_raw(i32::try_from(self.child.id()).unwrap()).unwrap();
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.stop();
        let _ = std::fs::remove_file(&self.socket);
    }
}

fn post(socket: &Path, path: &str, body: &serde_json::Value) -> String {
    post_reply(socket, path, body).0
}

fn post_reply(socket: &Path, path: &str, body: &serde_json::Value) -> (String, String) {
    let body = body.to_string();
    let mut stream = UnixStream::connect(socket).unwrap();
    write!(stream, "POST {path} HTTP/1.0\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    let (head, body) = reply.split_once("\r\n\r\n").unwrap();
    (head.split(' ').nth(1).unwrap().to_owned(), body.to_owned())
}

fn run(mut command: Command) -> Output {
    command.output().unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn a_value_typed_mid_command_is_masked_on_both_streams_and_the_status_passes_through() {
    let mut relay = Relay::start("typed");
    let child = relay.mask_run(r#"x=$("$SECRETS" ask t1); printf "got %s\n" "$x"; printf "%s" "$x" >&2; exit 3"#).spawn().unwrap();
    let ask = relay.next_ask();
    assert_eq!((ask["prompt"].as_str(), ask["inside"].as_bool(), ask["entry"].is_null()), (Some("t1"), Some(true), true));
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "secret": "hunter2" })), "204");
    let out = child.wait_with_output().unwrap();
    assert_eq!(stdout(&out), "got [secret]\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "[secret]");
    assert_eq!(out.status.code(), Some(3));
    let told: Vec<_> = (0..3).map(|_| relay.raw_event()).collect();
    assert_eq!(
        told,
        [serde_json::json!({ "masking": true }), serde_json::json!({ "masked": true }), serde_json::json!({ "masking": false })],
        "the hooks mask while the typed value's call runs"
    );
}

#[test]
fn a_typed_value_masks_every_call_while_its_call_runs_and_is_forgotten_after() {
    let mut relay = Relay::start("scoped");
    let asking = relay.mask_run(r#"x=$("$SECRETS" ask t2); sleep 0.5; echo "$x""#).spawn().unwrap();
    let ask = relay.next_ask();
    let other = relay.mask_run("sleep 0.2; echo hunter2").spawn().unwrap();
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "secret": "hunter2" })), "204");
    assert_eq!(stdout(&other.wait_with_output().unwrap()), "[secret]\n");
    assert_eq!(stdout(&asking.wait_with_output().unwrap()), "[secret]\n");
    assert_eq!(stdout(&run(relay.mask_run("echo hunter2"))), "hunter2\n");
}

#[test]
fn a_call_whose_relay_goes_away_withholds_the_rest_of_its_output() {
    let relay = Relay::start("gone");
    let mut child = relay.mask_run("echo before; sleep 0.5; echo after").spawn().unwrap();
    let mut first = String::new();
    BufReader::new(child.stdout.as_mut().unwrap()).read_line(&mut first).unwrap();
    assert_eq!(first, "before\n");
    drop(relay);
    let out = child.wait_with_output().unwrap();
    assert_eq!(stdout(&out), "");
    assert!(String::from_utf8_lossy(&out.stderr).contains("withheld"), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(out.status.code(), Some(0));
}

#[test]
fn the_relay_ends_when_its_parent_goes() {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map_or_else(std::env::temp_dir, PathBuf::from);
    let socket = dir.join(format!("secrets-test-orphan-{}.sock", std::process::id()));
    let data = data_dir("orphan");
    let mut parent = Command::new("/bin/sh")
        .args(["-c", r#""$0" "$1" > /dev/null & echo $!; sleep 30"#, RELAY])
        .arg(&socket)
        .env("XDG_DATA_HOME", &data)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut pid = String::new();
    BufReader::new(parent.stdout.as_mut().unwrap()).read_line(&mut pid).unwrap();
    let _reaped = KilledPid(pid.trim().to_owned());
    let alive = PathBuf::from(format!("/proc/{}", pid.trim()));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(alive.exists() && socket.exists(), "the relay didn't start");
    parent.kill().unwrap();
    parent.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive.exists() && std::fs::read_to_string(alive.join("stat")).is_ok_and(|s| !s.contains(") Z ")) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !alive.exists() || std::fs::read_to_string(alive.join("stat")).is_ok_and(|s| s.contains(") Z ")),
        "the orphaned relay still runs: {:?}",
        std::fs::read_to_string(alive.join("stat"))
    );
    assert!(!PathBuf::from(format!("{}.bin", socket.display())).exists(), "its helper copies are gone");
}

/// Kills a process by pid when dropped, so a failing test leaves nothing running.
struct KilledPid(String);

impl Drop for KilledPid {
    fn drop(&mut self) {
        let _ = Command::new("kill").arg(&self.0).stderr(Stdio::null()).status();
    }
}

#[test]
fn an_oversized_body_is_refused_before_it_is_read() {
    let relay = Relay::start("oversized");
    let mut stream = UnixStream::connect(&relay.socket).unwrap();
    write!(stream, "POST /mask HTTP/1.0\r\nContent-Length: {}\r\n\r\n", 64 << 20).unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    assert!(reply.starts_with("HTTP/1.0 413"), "{reply}");
}

#[test]
fn two_sessions_change_one_vault_without_losing_each_others_changes() {
    let data = data_dir("shared");
    let mut first = Relay::start_in("shared-a", &data);
    let second = Relay::start_in("shared-b", &data);
    assert_eq!(second.vault, "absent");
    first.create_vault("pass phrase");
    assert_eq!(post_reply(&second.socket, "/create", &serde_json::json!({ "passphrase": "other" })).0, "409", "a vault made meanwhile is not replaced");
    assert_eq!(second.get("/vault").1["state"], "locked");
    assert_eq!(post(&second.socket, "/unlock", &serde_json::json!({ "passphrase": "pass phrase" })), "204");
    first.add("One", "one", "password", "session", "value-one-1");
    let add = |tag: &str| serde_json::json!({ "op": "add", "name": tag, "tag": tag, "kind": "password", "use": "session", "value": format!("value-{tag}-1") });
    assert_eq!(post(&second.socket, "/vault", &add("two")), "200");
    assert_eq!(post(&first.socket, "/vault", &add("three")), "200");
    let tags = |relay: &Relay| relay.get("/vault").1["entries"].as_array().unwrap().iter().map(|e| e["tag"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(tags(&first), ["one", "two", "three"]);
    assert_eq!(tags(&second), ["one", "two", "three"]);
    assert_eq!(stdout(&run(second.mask_run("echo value-three-1"))), "[secret]\n", "the other session's new entry is masked");
    let one = first.get("/vault").1["entries"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(post(&first.socket, "/vault", &serde_json::json!({ "op": "delete", "id": one })), "200");
    assert_eq!(post(&second.socket, "/vault", &add("four")), "200");
    assert_eq!(tags(&second), ["two", "three", "four"], "a deleted entry stays deleted");
    drop((first, second));
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_change_that_cannot_be_saved_changes_nothing() {
    let data = data_dir("unsaved");
    let mut relay = Relay::start_in("unsaved", &data);
    relay.create_vault("pass phrase");
    let dir = data.join("secrets");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let added = serde_json::json!({ "op": "add", "name": "New", "tag": "new", "kind": "password", "use": "session", "value": "value-new-1" });
    let (status, reason) = post_reply(&relay.socket, "/vault", &added);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(status, "400", "{reason}");
    assert_eq!(relay.get("/vault").1["entries"], serde_json::json!([]));
    assert_eq!(stdout(&run(relay.mask_run("echo value-new-1"))), "value-new-1\n");
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_key_file_that_cannot_be_read_is_named_without_the_value() {
    let data = data_dir("keypath");
    let mut relay = Relay::start_in("keypath", &data);
    relay.create_vault("pass phrase");
    let (status, reason) = relay.add_key("k", Path::new("typed-secret-in-the-file-field"));
    assert_eq!(status, "400");
    assert!(!reason.contains("typed-secret"), "{reason}");
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_short_value_is_masked_in_its_own_call_and_in_others_only_past_the_minimum() {
    let mut relay = Relay::start("short");
    let both = |relay: &mut Relay| {
        let asking = relay.mask_run(r#"x=$("$SECRETS" ask t3); sleep 0.5; printf "%s and hunter2\n" "$x""#).spawn().unwrap();
        let ask = relay.next_ask();
        let other = relay.mask_run("sleep 0.2; echo abc").spawn().unwrap();
        assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "secret": "abc" })), "204");
        (stdout(&asking.wait_with_output().unwrap()), stdout(&other.wait_with_output().unwrap()))
    };
    assert_eq!(both(&mut relay), ("[secret] and hunter2\n".to_owned(), "abc\n".to_owned()));
    assert_eq!(post(&relay.socket, "/settings", &serde_json::json!({ "maskMinLength": 1 })), "204");
    assert_eq!(both(&mut relay), ("[secret] and hunter2\n".to_owned(), "[secret]\n".to_owned()));
    assert_eq!(post(&relay.socket, "/settings", &serde_json::json!({ "maskMinLength": 0 })), "400");
}

#[test]
fn split_values_encoded_forms_and_glued_tokens_are_masked() {
    let mut relay = Relay::start("forms");
    let cases = [
        (r#"printf "hun"; sleep 0.3; printf "ter2 and hunt"; sleep 0.3; printf "er2\n""#, "[secret] and [secret]\n"),
        (r#"printf "hunt""#, "[secret]"),
        (r#"printf "the hun""#, "the hun"),
        (r#"printf "pw=hunter""#, "[secret]"),
        (r#"printf "auth: %s\n" "$(printf "alex:%s" "$x" | base64)""#, "auth: [secret]\n"),
        (r#"printf "pw=%s;rest more\n" "$x""#, "[secret] more\n"),
    ];
    for (command, want) in cases {
        let child = relay.mask_run(&format!(r#"x=$("$SECRETS" ask t4); {command}"#)).spawn().unwrap();
        assert_eq!(relay.answer_next("hunter2"), "204");
        assert_eq!(stdout(&child.wait_with_output().unwrap()), want, "{command}");
    }
    let out = run(relay.mask_run(r#"printf "\000\377binary""#));
    assert_eq!(out.stdout, b"\x00\xffbinary");
}

#[test]
fn output_flows_while_the_command_runs() {
    let relay = Relay::start("flow");
    let mut child = relay.mask_run("printf 'Enter: '; sleep 2; echo done").spawn().unwrap();
    let mut out = child.stdout.take().unwrap();
    let started = Instant::now();
    let mut first = [0u8; 7];
    out.read_exact(&mut first).unwrap();
    assert_eq!(&first, b"Enter: ");
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    child.wait().unwrap();

    let mut echo = relay.mask_run(r#"while read -r line; do printf "%s\n" "$line"; done"#).stdin(Stdio::piped()).spawn().unwrap();
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
    let out = run(relay.mask_run("kill -TERM $$"));
    assert_eq!(out.status.code(), Some(128 + 15));
}

#[test]
fn without_a_relay_the_command_still_runs_and_says_so() {
    let out = Command::new(MASK_RUN).arg("echo hunter2").env("SECRETS_RELAY", "/nonexistent/relay.sock").output().unwrap();
    assert_eq!(stdout(&out), "hunter2\n");
    assert!(String::from_utf8_lossy(&out.stderr).contains("not masked"));
}

#[test]
fn a_refused_mask_run_runs_only_under_another_one() {
    let mut relay = Relay::start("peer");
    let nested = format!(r#"x=$("$SECRETS" ask t5); '{MASK_RUN}' "echo $x""#);
    let child = relay.mask_run(&nested).spawn().unwrap();
    assert_eq!(relay.answer_next("hunter2"), "204");
    let out = child.wait_with_output().unwrap();
    assert_eq!((stdout(&out), String::from_utf8_lossy(&out.stderr).into_owned()), ("[secret]\n".to_owned(), String::new()));

    let data = data_dir("peer");
    let touched = data.join("ran");
    std::fs::create_dir_all(&data).unwrap();
    // The relay's parent starts it, but it isn't the helper the relay pinned.
    let out = Command::new(MASK_RUN).arg(format!("touch '{}'", touched.display())).env("SECRETS_RELAY", &relay.socket).output().unwrap();
    assert_eq!(out.status.code(), Some(126));
    assert!(String::from_utf8_lossy(&out.stderr).contains("did not run"), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!touched.exists());
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn helpers_in_a_tree_that_can_change_are_copies_removed_when_the_relay_ends() {
    let mut relay = Relay::start("pinned");
    let built = Path::new(MASK_RUN).parent().unwrap();
    assert_eq!(relay.bin, PathBuf::from(format!("{}.bin", relay.socket.display())));
    for helper in ["secrets-mask-run", "secrets", "secrets-askpass", "secrets-askpass-sudo", "secrets-askpass-ssh", "secrets-askpass-git"] {
        assert_eq!(std::fs::read(relay.bin.join(helper)).unwrap(), std::fs::read(built.join(helper)).unwrap(), "{helper}");
    }
    assert_eq!(stdout(&run(relay.mask_run("echo pinned"))), "pinned\n");
    relay.stop();
    assert!(!relay.bin.exists());
}

#[test]
fn a_running_call_masks_what_another_session_saves_meanwhile() {
    let data = data_dir("watched");
    let mut first = Relay::start_in("watched-a", &data);
    let second = Relay::start_in("watched-b", &data);
    first.create_vault("pass phrase");
    assert_eq!(post(&second.socket, "/unlock", &serde_json::json!({ "passphrase": "pass phrase" })), "204");
    let running = first.mask_run("sleep 1; echo value-late-1").spawn().unwrap();
    let add = serde_json::json!({ "op": "add", "name": "Late", "tag": "late", "kind": "password", "use": "session", "value": "value-late-1" });
    assert_eq!(post(&second.socket, "/vault", &add), "200");
    assert_eq!(stdout(&running.wait_with_output().unwrap()), "[secret]\n");
    drop((first, second));
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn an_ask_names_the_calls_running_through_the_relay() {
    let mut relay = Relay::start("live");
    let other = relay.mask_run("sleep 1").spawn().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let asking = relay.mask_run(r#""$SECRETS" ask t6 > /dev/null"#).spawn().unwrap();
    let ask = relay.next_ask();
    let live: Vec<&str> = ask["live"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
    assert_eq!(live.len(), 2, "{ask}");
    assert!(live.iter().any(|l| l.ends_with("sleep 1")) && live.contains(&ask["cmdline"].as_str().unwrap()), "{ask}");
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "cancel": true })), "204");
    asking.wait_with_output().unwrap();
    other.wait_with_output().unwrap();
}

#[test]
fn a_cancelled_ask_exits_1_with_a_line() {
    let mut relay = Relay::start("cancel");
    for (program, args, line) in [
        (SECRETS, &["ask", "deploy", "token"][..], "secrets: the user cancelled: deploy token\n"),
        (ASKPASS, &["deploy token"][..], "secrets-askpass: the user cancelled: deploy token\n"),
    ] {
        let child = Command::new(program).args(args).env("SECRETS_RELAY", &relay.socket).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let ask = relay.next_ask();
        assert_eq!(ask["prompt"], "deploy token");
        assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "cancel": true })), "204");
        let out = child.wait_with_output().unwrap();
        assert_eq!((out.status.code(), String::from_utf8_lossy(&out.stderr).into_owned()), (Some(1), line.to_owned()));
        assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "secret": "late" })), "410");
    }
}

#[test]
fn each_askpass_asks_with_its_programs_tag() {
    let data = data_dir("askpass");
    let mut relay = Relay::start_in("askpass", &data);
    relay.create_vault("pass phrase");
    let id = relay.add("Login", "sudo", "password", "session", "sudo-pw-12");
    for (helper, tag) in [("secrets-askpass-ssh", "ssh"), ("secrets-askpass-git", "git")] {
        let child = Command::new(relay.bin.join(helper)).arg("Password:").env("SECRETS_RELAY", &relay.socket).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let ask = relay.next_ask();
        assert_eq!((ask["tag"].as_str(), ask["entry"].is_null()), (Some(tag), true), "{helper}");
        assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "cancel": true })), "204");
        child.wait_with_output().unwrap();
    }
    let sudo = Command::new(relay.bin.join("secrets-askpass-sudo"))
        .arg("[sudo] password for alex: ")
        .env("SECRETS_RELAY", &relay.socket)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let ask = relay.next_ask();
    assert_eq!((ask["tag"].as_str(), ask["entry"]["id"].as_str()), (Some("sudo"), Some(id.as_str())));
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "entry": id })), "204");
    assert_eq!(stdout(&sudo.wait_with_output().unwrap()), "sudo-pw-12\n");
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn an_open_vault_hands_a_tagged_entry_out_as_decided_and_masks_it_everywhere() {
    let data = data_dir("vault");
    let mut relay = Relay::start_in("vault", &data);
    relay.create_vault("correct horse");
    let file = data.join("secrets/vault");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    let id = relay.add("Prod DB", "db", "password", "session", "hunter22x");
    let again = serde_json::json!({ "op": "add", "name": "Prod DB", "tag": "db", "kind": "password", "use": "session", "value": "x" });
    assert_eq!(post_reply(&relay.socket, "/vault", &again), ("400".to_owned(), "tag db is taken or not made of letters, digits, - _ .".to_owned()));
    assert!(memchr::memmem::find(&std::fs::read(&file).unwrap(), b"hunter22x").is_none());

    let first = relay.secrets(&["ask", "--tag", "db", "Prod DB password"]).spawn().unwrap();
    let ask = relay.next_ask();
    assert_eq!((ask["entry"]["id"].as_str(), ask["entry"]["allowed"].as_bool(), ask["inside"].as_bool()), (Some(id.as_str()), Some(false), Some(false)));
    assert!(ask["cmdline"].as_str().unwrap().ends_with("secrets ask --tag db Prod DB password"), "{ask}");
    let picked = serde_json::json!({ "id": ask["id"], "entry": id, "session": true });
    assert_eq!(post(&relay.socket, "/answer", &picked), "204");
    assert_eq!(relay.next_event(), serde_json::json!({ "vault": "open" }), "a session grant is told");
    assert_eq!(stdout(&first.wait_with_output().unwrap()), "hunter22x\n");
    let second = relay.secrets(&["ask", "--tag", "db", "Prod DB password"]).spawn().unwrap();
    assert_eq!(relay.next_ask()["entry"]["allowed"], true);
    drop(second);

    let unknown = relay.secrets(&["ask", "--tag", "nope", "x"]).spawn().unwrap();
    assert!(relay.next_ask()["entry"].is_null());
    drop(unknown);

    let list = relay.secrets(&["list"]).spawn().unwrap();
    relay.decide_next("list", "give");
    assert_eq!(stdout(&list.wait_with_output().unwrap()), "db\tpassword\tsession\tallowed\tProd DB\n");
    assert_eq!(stdout(&run(relay.mask_run("echo the db password is hunter22x"))), "the db password is [secret]\n");
    let masked = post_reply(&relay.socket, "/mask", &serde_json::json!({ "texts": ["pw hunter22x here", "plain"] })).1;
    assert_eq!(serde_json::from_str::<serde_json::Value>(&masked).unwrap(), serde_json::json!({ "texts": ["pw [secret] here", "plain"] }));
    let carried = post_reply(&relay.socket, "/check", &serde_json::json!({ "texts": ["curl -u alex:hunter22x https://db"] })).1;
    assert_eq!(serde_json::from_str::<serde_json::Value>(&carried).unwrap(), serde_json::json!({ "label": "Prod DB (db)" }));
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_value_typed_while_the_vault_is_open_is_only_suggested_and_kept_when_saved() {
    let data = data_dir("suggest");
    let mut relay = Relay::start_in("suggest", &data);
    relay.create_vault("pass phrase");
    let child = relay.mask_run(r#"x=$("$SECRETS" ask "sudo pw"); echo "$x" > /dev/null"#).spawn().unwrap();
    assert_eq!(relay.answer_next("typed-secret-1"), "204");
    assert_eq!(relay.next_event(), serde_json::json!({ "vault": "open" }));
    child.wait_with_output().unwrap();
    let (_, shown) = relay.get("/vault");
    assert_eq!(shown["entries"], serde_json::json!([]));
    assert_eq!(shown["suggestions"][0]["prompt"], "sudo pw");
    assert!(!shown.to_string().contains("typed-secret-1"));
    assert_eq!(stdout(&run(relay.mask_run("echo typed-secret-1"))), "[secret]\n");

    let save = serde_json::json!({ "op": "save", "id": shown["suggestions"][0]["id"], "name": "sudo", "tag": "sudo", "kind": "password", "use": "each" });
    assert_eq!(post(&relay.socket, "/vault", &save), "200");
    relay.next_event();
    let (_, shown) = relay.get("/vault");
    assert_eq!((shown["entries"][0]["tag"].as_str(), shown["suggestions"].as_array().map(Vec::len)), (Some("sudo"), Some(0)));
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_new_passphrase_keeps_the_entries_and_closes_the_vault_in_other_sessions() {
    let data = data_dir("rekey");
    let mut first = Relay::start_in("rekey-a", &data);
    let second = Relay::start_in("rekey-b", &data);
    first.create_vault("old phrase");
    let id = first.add("Login", "sudo", "password", "session", "sudo-pw-34");
    assert_eq!(post(&second.socket, "/unlock", &serde_json::json!({ "passphrase": "old phrase" })), "204");
    assert_eq!(post(&first.socket, "/vault", &serde_json::json!({ "op": "allow", "id": id, "allowed": true })), "200");
    assert_eq!(post_reply(&first.socket, "/passphrase", &serde_json::json!({ "passphrase": "" })).0, "400");
    assert_eq!(post(&first.socket, "/passphrase", &serde_json::json!({ "passphrase": "new phrase" })), "204");
    let shown = first.get("/vault").1;
    assert_eq!((shown["state"].as_str(), shown["entries"][0]["allowed"].as_bool()), (Some("open"), Some(true)), "{shown}");
    assert_eq!(second.get("/vault").1["state"], "locked", "the other session's key no longer fits");
    assert_eq!(post(&second.socket, "/unlock", &serde_json::json!({ "passphrase": "old phrase" })), "403");
    assert_eq!(post(&second.socket, "/unlock", &serde_json::json!({ "passphrase": "new phrase" })), "204");
    assert_eq!(second.get("/vault").1["entries"][0]["tag"], "sudo");
    drop((first, second));
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn typed_entries_another_relay_saves_are_dropped() {
    let data = data_dir("typedsave");
    let mut relay = Relay::start_in("typedsave", &data);
    relay.create_vault("pass phrase");
    relay.add("Kept", "kept", "password", "session", "kept-value-1");
    let file = data.join("secrets/vault");
    let mut older = Vault::open(&file, b"pass phrase").unwrap();
    older.entries.push(Entry { id: "typed-1".to_owned(), name: "typed".to_owned(), tag: "typed-1".to_owned(), kind: Kind::Typed, use_: Use::Each, value: "old-typed-value".to_owned(), created: 0 });
    older.save(&file).unwrap();
    let tags: Vec<String> = relay.get("/vault").1["entries"].as_array().unwrap().iter().map(|e| e["tag"].as_str().unwrap().to_owned()).collect();
    assert_eq!(tags, ["kept"]);
    assert_eq!(stdout(&run(relay.mask_run("echo old-typed-value kept-value-1"))), "old-typed-value [secret]\n");
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_closed_vault_offers_nothing_and_opens_only_with_its_passphrase() {
    let data = data_dir("closed");
    std::fs::create_dir_all(data.join("secrets")).unwrap();
    let costs = Costs { memory_kib: 64, time: 1, lanes: 1 };
    let mut vault = Vault::create(b"pass phrase", costs).unwrap();
    for (tag, kind, value) in [("api", Kind::Token, "tok-998877"), ("typed-1", Kind::Typed, "old-typed-value")] {
        vault.entries.push(Entry { id: tag.to_owned(), name: tag.to_owned(), tag: tag.to_owned(), kind, use_: Use::Each, value: value.to_owned(), created: 0 });
    }
    let file = data.join("secrets/vault");
    vault.save(&file).unwrap();

    let mut relay = Relay::start_in("closed", &data);
    assert_eq!(relay.vault, "locked");
    let refused = run(relay.secrets(&["list"]));
    assert_eq!(String::from_utf8_lossy(&refused.stderr), "secrets: the vault is closed\n");
    let asking = relay.secrets(&["ask", "--tag", "api", "API token"]).spawn().unwrap();
    let ask = relay.next_ask();
    assert!(ask["entry"].is_null(), "{ask}");
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "entry": "api" })), "409");
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": ask["id"], "secret": "typed-now" })), "204");
    assert_eq!(stdout(&asking.wait_with_output().unwrap()), "typed-now\n");
    assert_eq!(stdout(&run(relay.mask_run("echo tok-998877"))), "tok-998877\n");

    assert_eq!(post_reply(&relay.socket, "/unlock", &serde_json::json!({ "passphrase": "wrong" })), ("403".to_owned(), "wrong passphrase".to_owned()));
    assert_eq!(post(&relay.socket, "/create", &serde_json::json!({ "passphrase": "other" })), "409");
    assert_eq!(post(&relay.socket, "/unlock", &serde_json::json!({ "passphrase": "pass phrase" })), "204");
    assert_eq!(relay.next_event(), serde_json::json!({ "vault": "open" }));
    let (_, shown) = relay.get("/vault");
    assert_eq!((shown["entries"].as_array().map(Vec::len), shown["suggestions"].as_array().map(Vec::len)), (Some(1), Some(0)));
    assert_eq!(stdout(&run(relay.mask_run("echo tok-998877 typed-now"))), "[secret] typed-now\n");
    drop(relay);
    let reopened = Vault::open(&file, b"pass phrase").unwrap();
    assert_eq!(reopened.entries.iter().map(|e| e.tag.as_str()).collect::<Vec<_>>(), ["api"]);
    std::fs::remove_dir_all(&data).unwrap();
}

fn keygen(file: &Path, kind: &str, passphrase: &str) {
    let made = Command::new("ssh-keygen").args(["-q", "-t", kind, "-N", passphrase, "-C", "file comment", "-f"]).arg(file).status().unwrap();
    assert!(made.success());
}

/// The key type and base64 of each line `ssh-add -L` prints for the agent.
fn listed(agent: &Path) -> Vec<String> {
    let out = Command::new("ssh-add").arg("-L").env("SSH_AUTH_SOCK", agent).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().map(|l| l.split(' ').take(2).collect::<Vec<_>>().join(" ")).collect()
}

fn public_of(file: &Path) -> String {
    let text = std::fs::read_to_string(file.with_extension("pub")).unwrap();
    text.split(' ').take(2).collect::<Vec<_>>().join(" ")
}

/// Signs `message` with the agent holding `key`'s private half; the signature file on success.
fn agent_sign(agent: &Path, key: &Path, message: &Path) -> Command {
    let mut sign = Command::new("ssh-keygen");
    sign.args(["-Y", "sign", "-n", "test", "-f"]).arg(key.with_extension("pub")).arg(message).env("SSH_AUTH_SOCK", agent).stdout(Stdio::piped()).stderr(Stdio::piped());
    sign
}

fn verified(key: &Path, message: &Path) -> bool {
    let signers = key.with_extension("signers");
    std::fs::write(&signers, format!("tester {}\n", public_of(key))).unwrap();
    let sig = PathBuf::from(format!("{}.sig", message.display()));
    let ok = Command::new("ssh-keygen")
        .args(["-Y", "verify", "-n", "test", "-I", "tester", "-f"])
        .arg(&signers)
        .arg("-s")
        .arg(&sig)
        .stdin(std::fs::File::open(message).unwrap())
        .output()
        .unwrap()
        .status
        .success();
    std::fs::remove_file(&sig).unwrap();
    ok
}

#[test]
fn the_agent_lists_vault_keys_and_signs_only_once_given() {
    let data = data_dir("agent");
    let mut relay = Relay::start_in("agent", &data);
    relay.create_vault("pass phrase");
    let keys = data.join("keys");
    std::fs::create_dir_all(&keys).unwrap();
    let (ed25519, rsa, locked) = (keys.join("id_ed25519"), keys.join("id_rsa"), keys.join("id_locked"));
    keygen(&ed25519, "ed25519", "");
    keygen(&rsa, "rsa", "");
    keygen(&locked, "ed25519", "key pass");
    assert_eq!(relay.add_key("ed", &ed25519).0, "200");
    assert_eq!(relay.add_key("rsa", &rsa).0, "200");
    assert_eq!(relay.add_key("locked", &locked), ("400".to_owned(), "the key is passphrase-protected; the vault takes unencrypted keys only".to_owned()));
    assert_eq!(listed(&relay.agent()), [public_of(&ed25519), public_of(&rsa)]);
    // Without its private file beside the .pub, ssh-keygen can only sign through the agent.
    std::fs::remove_file(&ed25519).unwrap();
    std::fs::remove_file(&rsa).unwrap();

    let message = keys.join("message");
    std::fs::write(&message, "sign me").unwrap();
    for (tag, key) in [("ed", &ed25519), ("rsa", &rsa)] {
        let sign = agent_sign(&relay.agent(), key, &message).spawn().unwrap();
        assert_eq!(relay.decide_next("sign", "give")["tag"], tag);
        let out = sign.wait_with_output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(verified(key, &message), "{tag}");
    }
    let refused = agent_sign(&relay.agent(), &ed25519, &message).spawn().unwrap();
    relay.decide_next("sign", "refuse");
    assert!(!refused.wait_with_output().unwrap().status.success());
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn forwarding_offers_and_signs_with_the_users_own_agent_only_when_switched_on() {
    let data = data_dir("forward");
    std::fs::create_dir_all(&data).unwrap();
    let upstream_socket = data.join("upstream.sock");
    let _upstream = Killed(Command::new("ssh-agent").arg("-D").arg("-a").arg(&upstream_socket).stdout(Stdio::null()).spawn().unwrap());
    let started = Instant::now();
    while !upstream_socket.exists() && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let theirs = data.join("id_theirs");
    keygen(&theirs, "ed25519", "");
    assert!(Command::new("ssh-add").arg("-q").arg(&theirs).env("SSH_AUTH_SOCK", &upstream_socket).status().unwrap().success());
    // Without its private file beside the .pub, ssh-keygen can only sign through an agent.
    std::fs::remove_file(&theirs).unwrap();

    let mut relay = Relay::start_with("forward", &data, &[("SECRETS_UPSTREAM_AGENT", &upstream_socket)]);
    relay.create_vault("pass phrase");
    let mine = data.join("id_mine");
    keygen(&mine, "ed25519", "");
    assert_eq!(relay.add_key("mine", &mine).0, "200");
    assert_eq!(listed(&relay.agent()), [public_of(&mine)]);
    let message = data.join("message");
    std::fs::write(&message, "sign me").unwrap();
    assert!(!run(agent_sign(&relay.agent(), &theirs, &message)).status.success());

    assert_eq!(post(&relay.socket, "/vault", &serde_json::json!({ "op": "forward", "on": true })), "200");
    assert_eq!(listed(&relay.agent()), [public_of(&mine), public_of(&theirs)]);
    let out = run(agent_sign(&relay.agent(), &theirs, &message));
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(verified(&theirs, &message));
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

/// A child killed when the test ends, failed or not.
struct Killed(Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
