//! Runs secrets-relay, secrets-mask-run and secrets-ask together, without Claude Code.
// clippy.toml's test allowances reach #[test] functions, not this file's helpers.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Output, Stdio};
use std::time::{Duration, Instant};

const RELAY: &str = env!("CARGO_BIN_EXE_secrets-relay");
const MASK_RUN: &str = env!("CARGO_BIN_EXE_secrets-mask-run");
const ASK: &str = env!("CARGO_BIN_EXE_secrets-ask");
const VAULT: &str = env!("CARGO_BIN_EXE_secrets-vault");

struct Relay {
    child: Child,
    events: BufReader<ChildStdout>,
    socket: PathBuf,
    /// The vault state the relay started with.
    vault: String,
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
        Self { child, events, socket, vault }
    }

    fn next_event(&mut self) -> serde_json::Value {
        let mut line = String::new();
        self.events.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    /// Answers the next event, an ask of `kind`, with `secret`; the ask's prompt.
    fn answer_ask(&mut self, kind: &str, secret: &str) -> String {
        let event = self.next_event();
        assert_eq!(event["ask"]["kind"], kind, "{event}");
        let id = event["ask"]["id"].as_str().unwrap().to_owned();
        assert_eq!(post(&self.socket, "/answer", &serde_json::json!({ "id": id, "secret": secret })), "204");
        event["ask"]["prompt"].as_str().unwrap().to_owned()
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

    /// Adds an ssh key entry from a key file; the relay's status and reason.
    fn add_key(&mut self, tag: &str, file: &Path) -> (String, String) {
        let added = serde_json::json!({ "op": "add", "name": format!("{tag} key"), "tag": tag, "kind": "ssh-key", "use": "session", "value": file });
        let reply = post_reply(&self.socket, "/vault", &added);
        if reply.0 == "200" {
            assert_eq!(self.next_event(), serde_json::json!({ "vault": "open" }));
        }
        reply
    }

    fn vault_cmd(&self, args: &[&str]) -> Command {
        let mut command = Command::new(VAULT);
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

/// Creates a vault through the passphrase asks, as the hooks would.
fn create_vault(relay: &mut Relay, passphrase: &str) {
    assert_eq!(relay.vault, "absent");
    assert_eq!(post(&relay.socket, "/unlock", &serde_json::json!({})), "204");
    assert_eq!(relay.answer_ask("unlock", passphrase), "New vault passphrase");
    assert_eq!(relay.answer_ask("unlock", "typo"), "New vault passphrase, again");
    assert_eq!(relay.answer_ask("unlock", passphrase), "Passphrases differed; new vault passphrase");
    relay.answer_ask("unlock", passphrase);
    assert_eq!(relay.next_event(), serde_json::json!({ "vault": "open" }));
}

#[test]
fn a_new_vault_hands_an_entry_out_as_decided_and_masks_it() {
    let data = data_dir("vault");
    let mut relay = Relay::start_in("vault", &data);
    create_vault(&mut relay, "correct horse");
    let file = data.join("secrets/vault");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    let added = serde_json::json!({ "op": "add", "name": "Prod DB", "tag": "db", "kind": "password", "use": "session", "value": "hunter22x" });
    assert_eq!(post_reply(&relay.socket, "/vault", &added).0, "200");
    assert_eq!(relay.next_event(), serde_json::json!({ "vault": "open" }));
    assert_eq!(post_reply(&relay.socket, "/vault", &added), ("400".to_owned(), "tag db is taken or not made of letters, digits, - _ .".to_owned()));
    assert!(memchr::memmem::find(&std::fs::read(&file).unwrap(), b"hunter22x").is_none());

    let first = relay.vault_cmd(&["get", "db"]).spawn().unwrap();
    let event = relay.decide_next("get", "session");
    assert_eq!((event["tag"].as_str(), event["allowed"].as_bool()), (Some("db"), Some(false)));
    assert_eq!(String::from_utf8_lossy(&first.wait_with_output().unwrap().stdout), "hunter22x\n");
    let second = relay.vault_cmd(&["get", "db"]).spawn().unwrap();
    assert_eq!(relay.decide_next("get", "give")["allowed"], true);
    assert_eq!(String::from_utf8_lossy(&second.wait_with_output().unwrap().stdout), "hunter22x\n");

    let list = relay.vault_cmd(&["list"]).spawn().unwrap();
    relay.decide_next("list", "give");
    assert_eq!(String::from_utf8_lossy(&list.wait_with_output().unwrap().stdout), "db\tpassword\tsession\tallowed\tProd DB\n");
    let missing = run(relay.vault_cmd(&["get", "nope"]));
    assert_eq!(String::from_utf8_lossy(&missing.stderr), "secrets-vault: no entry tagged nope\n");
    let out = run(relay.mask_run("echo the db password is hunter22x", &[]));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "the db password is [secret]\n");
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_saved_vault_unlocks_after_a_wrong_passphrase_and_keeps_typed_values_for_masking_only() {
    let data = data_dir("reopen");
    let mut relay = Relay::start_in("reopen", &data);
    create_vault(&mut relay, "pass phrase");
    let added = serde_json::json!({ "op": "add", "name": "API", "tag": "api", "kind": "token", "use": "each", "value": "tok-998877" });
    assert_eq!(post_reply(&relay.socket, "/vault", &added).0, "200");
    relay.next_event();
    let typed = relay.mask_run(r#"x=$($ASK_SECRET "sudo pw"); echo "$x" > /dev/null"#, &[]).spawn().unwrap();
    assert_eq!(relay.answer_ask("secret", "typed-secret-1"), "sudo pw");
    typed.wait_with_output().unwrap();
    drop(relay);

    let mut relay = Relay::start_in("reopen", &data);
    assert_eq!(relay.vault, "locked");
    let refused = relay.vault_cmd(&["get", "api"]).spawn().unwrap();
    assert_eq!(relay.answer_ask("unlock", "wrong"), "Vault passphrase");
    assert_eq!(relay.answer_ask("unlock", "pass phrase"), "Vault passphrase: wrong, again");
    assert_eq!(relay.next_event(), serde_json::json!({ "vault": "open" }));
    assert_eq!(relay.decide_next("get", "refuse")["use"], "each");
    let out = refused.wait_with_output().unwrap();
    assert_eq!((out.status.code(), String::from_utf8_lossy(&out.stderr).into_owned()), (Some(1), "secrets-vault: refused: api\n".to_owned()));

    let (status, shown) = relay.get("/vault");
    assert_eq!((status.as_str(), shown["state"].as_str()), ("200", Some("open")));
    let kinds: Vec<_> = shown["entries"].as_array().unwrap().iter().map(|e| (e["kind"].as_str().unwrap(), e["name"].as_str().unwrap())).collect();
    assert_eq!(kinds, [("token", "API"), ("typed", "sudo pw")]);
    assert!(shown.to_string().contains("typed-secret-1"));
    let typed_tag = shown["entries"][1]["tag"].as_str().unwrap().to_owned();
    assert_eq!(String::from_utf8_lossy(&run(relay.vault_cmd(&["get", &typed_tag])).stderr), format!("secrets-vault: no entry tagged {typed_tag}\n"));
    let out = run(relay.mask_run("echo typed-secret-1 tok-998877", &[]));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "[secret] [secret]\n");
    drop(relay);
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
    create_vault(&mut relay, "pass phrase");
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
        assert_eq!(relay.decide_next("get", "give")["tag"], tag);
        let out = sign.wait_with_output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(verified(key, &message), "{tag}");
    }
    let refused = agent_sign(&relay.agent(), &ed25519, &message).spawn().unwrap();
    relay.decide_next("get", "refuse");
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
    create_vault(&mut relay, "pass phrase");
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

#[test]
fn a_cancelled_unlock_refuses_what_waited_on_it() {
    let data = data_dir("cancel-unlock");
    let mut relay = Relay::start_in("cancel-unlock", &data);
    create_vault(&mut relay, "pass phrase");
    drop(relay);
    let mut relay = Relay::start_in("cancel-unlock", &data);
    let waiting = relay.vault_cmd(&["list"]).spawn().unwrap();
    let event = relay.next_event();
    let id = event["ask"]["id"].as_str().unwrap();
    assert_eq!(post(&relay.socket, "/answer", &serde_json::json!({ "id": id, "cancel": true })), "204");
    let out = waiting.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stderr), "secrets-vault: the vault was not unlocked\n");
    drop(relay);
    std::fs::remove_dir_all(&data).unwrap();
}
