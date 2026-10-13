//! The vault in the session. Closed (absent or locked) it holds and tracks nothing; open, it holds its entries,
//! the grants of this session and the values typed this session that it suggests keeping. Only the hooks unlock it,
//! with the passphrase typed into the Vault tab.
//!
//! Every session's relay opens the same file. A change is made under `vault.lock` to what the file holds then, and
//! a relay that finds the file replaced since it last read it takes the new one in before serving.

use std::collections::HashSet;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use secrets::agent;
use secrets::vault::{Entry, Kind, Use, Vault, random_hex};
use serde::Deserialize;
use serde_json::json;
use tokio::net::UnixStream;
use zeroize::{Zeroize as _, Zeroizing};

use crate::{COSTS, Context, Decision, Shared, State, decide, emit, lock, note, now, peer, respond};

pub enum Locker {
    Absent,
    Locked,
    Open(Box<Opened>),
}

pub struct Opened {
    vault: Vault,
    /// Entry ids allowed in this session.
    allowed: HashSet<String>,
    suggestions: Vec<Suggestion>,
    /// The file as last read or written here; a save from another session replaces it.
    seen: Option<Stamp>,
}

/// Which save of the vault file this is (`vault::identity`).
type Stamp = Vec<u8>;

fn stamp(path: &Path) -> Option<Stamp> {
    secrets::vault::identity(path)
}

/// Holds `vault.lock` beside the vault until dropped, so no other session's relay changes the file meanwhile.
fn exclusive(path: &Path) -> Result<std::fs::File, String> {
    let lock_path = path.with_file_name("vault.lock");
    if let Some(dir) = lock_path.parent() {
        std::os::unix::fs::DirBuilderExt::mode(std::fs::DirBuilder::new().recursive(true), 0o700)
            .create(dir)
            .map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(&lock_path)
        .map_err(|e| format!("can't open {}: {e}", lock_path.display()))?;
    rustix::fs::flock(&file, rustix::fs::FlockOperation::LockExclusive).map_err(|e| format!("can't lock {}: {e}", lock_path.display()))?;
    Ok(file)
}

/// `exclusive` off the runtime thread: waiting for another session's relay stalls no stream of this one.
async fn exclusive_waiting(path: &Path) -> Result<std::fs::File, String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || exclusive(&path)).await.map_err(|e| format!("locking the vault stopped: {e}"))?
}

/// A value typed this session while the vault was open, kept in memory until the user saves or dismisses it.
#[derive(Clone)]
struct Suggestion {
    id: String,
    prompt: String,
    value: Zeroizing<String>,
}

impl Locker {
    pub fn shown(&self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Locked => "locked",
            Self::Open(_) => "open",
        }
    }

    /// The entries `secrets ask` and `/check` deal with; none while the vault is closed.
    pub fn entries(&self) -> &[Entry] {
        match self {
            Self::Open(open) => &open.vault.entries,
            _ => &[],
        }
    }

    pub fn ssh_keys(&self) -> Vec<Entry> {
        self.entries().iter().filter(|e| e.kind == Kind::SshKey).cloned().collect()
    }

    pub fn is_allowed(&self, id: &str) -> bool {
        matches!(self, Self::Open(open) if open.allowed.contains(id))
    }

    /// Allows the entry for the session; true when that is new, which the caller tells.
    pub fn allow(&mut self, id: &str) -> bool {
        let Self::Open(open) = self else { return false };
        open.allowed.insert(id.to_owned())
    }

    /// Every value the open vault holds, its suggestions too.
    pub fn values(&self) -> Vec<Zeroizing<String>> {
        let Self::Open(open) = self else { return Vec::new() };
        let entries = open.vault.entries.iter().map(|e| Zeroizing::new(e.value.clone()));
        entries.chain(open.suggestions.iter().map(|s| s.value.clone())).collect()
    }

    /// The entry tagged `tag` that `secrets ask --tag` can hand out, and whether this session allowed it.
    pub fn tagged(&self, tag: &str) -> Option<(&Entry, bool)> {
        let Self::Open(open) = self else { return None };
        let entry = open.vault.entries.iter().find(|e| e.tag == tag && e.kind != Kind::SshKey)?;
        Some((entry, open.allowed.contains(&entry.id)))
    }

    /// The value of the entry `id` for an answer, and whether it made a new session grant, which the caller tells.
    pub fn hand_out(&mut self, id: &str, session: bool) -> Option<(Zeroizing<String>, bool)> {
        let Self::Open(open) = self else { return None };
        let entry = open.vault.entries.iter().find(|e| e.id == id && e.kind != Kind::SshKey)?;
        let value = Zeroizing::new(entry.value.clone());
        let granted = session && open.allowed.insert(id.to_owned());
        Some((value, granted))
    }

    /// Keeps a typed value as a suggestion while the vault is open; false when closed or already held.
    pub fn suggest(&mut self, prompt: &str, value: &str) -> bool {
        let Self::Open(open) = self else { return false };
        let is_held = open.vault.entries.iter().any(|e| e.value == value) || open.suggestions.iter().any(|s| *s.value == value);
        if value.is_empty() || is_held {
            return false;
        }
        let Ok(id) = random_hex::<8>() else { return false };
        open.suggestions.push(Suggestion { id, prompt: prompt.to_owned(), value: Zeroizing::new(value.to_owned()) });
        true
    }
}

/// Writes the vault; the new file's stamp, or the reason, which the hooks are told too.
fn save(ctx: &Context, vault: &Vault) -> Result<Option<Stamp>, String> {
    vault.save(&ctx.vault_path).map(|()| stamp(&ctx.vault_path)).map_err(|error| {
        let text = format!("vault: can't save {}: {error}", ctx.vault_path.display());
        emit(&json!({ "trouble": text }));
        text
    })
}

/// The vault changed: masking takes its values, the hooks are told.
fn changed(state: &mut State) {
    let values = state.vault.values();
    state.filter.set_vault_values(values);
    emit(&json!({ "vault": state.vault.shown() }));
}

/// Catches up with the file before serving: another session's save is taken in, and a vault made, replaced or
/// removed elsewhere shows as such.
pub fn fresh(ctx: &Context, state: &mut State) {
    let now = stamp(&ctx.vault_path);
    let Locker::Open(open) = &mut state.vault else {
        let shown = if now.is_some() { Locker::Locked } else { Locker::Absent };
        if shown.shown() != state.vault.shown() {
            state.vault = shown;
            emit(&json!({ "vault": state.vault.shown() }));
        }
        return;
    };
    if now == open.seen {
        return;
    }
    let reloaded = if now.is_some() { open.vault.reload(&ctx.vault_path).map_err(|e| e.to_string()) } else { Err("the vault file is gone".to_owned()) };
    match reloaded {
        Ok(()) => {
            open.seen = now;
            let Opened { vault, allowed, .. } = &mut **open;
            allowed.retain(|id| vault.entries.iter().any(|e| e.id == *id));
        }
        Err(reason) => {
            emit(&json!({ "trouble": format!("vault: closed, since another session changed its file ({reason})") }));
            state.vault = if now.is_some() { Locker::Locked } else { Locker::Absent };
        }
    }
    changed(state);
}

/// Drops the typed entries earlier versions kept, under the lock; the stamp of the file as saved then.
fn without_typed(path: &Path, vault: &mut Vault) -> Result<Option<Stamp>, Opening> {
    let _held = exclusive(path).map_err(Opening::Lock)?;
    vault.reload(path)?;
    vault.entries.retain(|e| e.kind != Kind::Typed);
    vault.save(path)?;
    Ok(stamp(path))
}

/// Catches up as soon as another session's relay saves, so a call already running masks what it added; the check
/// before each request stays for whatever this misses.
pub async fn watch(ctx: Shared) {
    use rustix::fs::inotify;
    let Some(dir) = ctx.vault_path.parent() else { return };
    let watching = std::os::unix::fs::DirBuilderExt::mode(std::fs::DirBuilder::new().recursive(true), 0o700)
        .create(dir)
        .map_err(|e| e.to_string())
        .and_then(|()| inotify::init(inotify::CreateFlags::NONBLOCK | inotify::CreateFlags::CLOEXEC).map_err(|e| e.to_string()))
        .and_then(|fd| {
            let flags = inotify::WatchFlags::MOVED_TO | inotify::WatchFlags::MOVED_FROM | inotify::WatchFlags::DELETE;
            inotify::add_watch(&fd, dir, flags).map(|_| fd).map_err(|e| e.to_string())
        })
        .and_then(|fd| tokio::io::unix::AsyncFd::new(fd).map_err(|e| e.to_string()));
    let watched = match watching {
        Ok(watched) => watched,
        Err(error) => return note(&format!("can't watch {} for other sessions' saves: {error}", dir.display())),
    };
    let mut buf = [0u8; 4096];
    loop {
        let Ok(mut ready) = watched.readable().await else { return };
        loop {
            match rustix::io::read(ready.get_inner(), &mut buf) {
                Ok(0) => return note(&format!("watching {} ended", dir.display())),
                Ok(_) => {}
                Err(rustix::io::Errno::AGAIN) => break ready.clear_ready(),
                Err(error) => return note(&format!("watching {} stopped: {error}", dir.display())),
            }
        }
        fresh(&ctx, &mut lock(&ctx));
    }
}

/// Takes the opened vault in. `seen` is the file's stamp from before it was read, so a save made since then is
/// caught up with.
fn opened(state: &mut State, vault: Vault, seen: Option<Stamp>) {
    state.vault = Locker::Open(Box::new(Opened { vault, allowed: HashSet::new(), suggestions: Vec::new(), seen }));
    changed(state);
}

/// Saves a new vault and takes it in at once: no catching up in between finds the file and calls the vault locked.
fn created(ctx: &Context, vault: Vault) -> Result<(), Opening> {
    let path = &ctx.vault_path;
    let _held = exclusive(path).map_err(Opening::Lock)?;
    let mut state = lock(ctx);
    if path.exists() {
        return Err(Opening::Exists);
    }
    vault.save(path)?;
    opened(&mut state, vault, stamp(path));
    Ok(())
}

#[derive(Deserialize)]
struct Passphrase {
    passphrase: String,
}

enum Opening {
    Vault(secrets::vault::Error),
    /// A create found a vault another session made meanwhile.
    Exists,
    Lock(String),
}

impl From<secrets::vault::Error> for Opening {
    fn from(error: secrets::vault::Error) -> Self {
        Self::Vault(error)
    }
}

/// `/unlock` or, with `create`, `/create`: 204 once open, 403 for a wrong passphrase, 409 when the vault isn't in
/// a state to do it, 500 with the reason when the file can't be read or written.
pub async fn open(stream: &mut UnixStream, ctx: &Shared, body: &[u8], create: bool) {
    let Ok(Passphrase { passphrase }) = serde_json::from_slice::<Passphrase>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let passphrase = Zeroizing::new(passphrase);
    let expected = if create { "absent" } else { "locked" };
    let shown = lock(ctx).vault.shown();
    if shown != expected {
        return respond(stream, "409 Conflict", format!("the vault is {shown}").as_bytes()).await;
    }
    let shared = Arc::clone(ctx);
    let result = tokio::task::spawn_blocking(move || -> Result<(), Opening> {
        let path = &shared.vault_path;
        if create {
            return created(&shared, Vault::create(passphrase.as_bytes(), COSTS)?);
        }
        let seen = stamp(path);
        let mut vault = Vault::open(path, passphrase.as_bytes())?;
        let seen = if vault.entries.iter().any(|e| e.kind == Kind::Typed) { without_typed(path, &mut vault)? } else { seen };
        opened(&mut lock(&shared), vault, seen);
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => respond(stream, "204 No Content", b"").await,
        Ok(Err(Opening::Exists)) => {
            fresh(ctx, &mut lock(ctx));
            respond(stream, "409 Conflict", b"another session made the vault meanwhile; unlock it").await;
        }
        Ok(Err(Opening::Vault(secrets::vault::Error::Refused))) => respond(stream, "403 Forbidden", b"wrong passphrase").await,
        Ok(Err(Opening::Vault(error))) => respond(stream, "500 Internal Server Error", format!("{}: {error}", ctx.vault_path.display()).as_bytes()).await,
        Ok(Err(Opening::Lock(reason))) => respond(stream, "500 Internal Server Error", reason.as_bytes()).await,
        Err(error) => respond(stream, "500 Internal Server Error", format!("unlocking stopped: {error}").as_bytes()).await,
    }
}

/// `GET /vault`: what the Vault tab shows; never a value.
pub fn show(state: &State, upstream: bool) -> serde_json::Value {
    let (entries, suggestions) = match &state.vault {
        Locker::Open(open) => (
            open.vault
                .entries
                .iter()
                .map(|e| json!({ "id": e.id, "name": e.name, "tag": e.tag, "kind": e.kind, "use": e.use_, "created": e.created, "allowed": open.allowed.contains(&e.id) }))
                .collect(),
            open.suggestions.iter().map(|s| json!({ "id": s.id, "prompt": s.prompt })).collect(),
        ),
        _ => (Vec::new(), Vec::new()),
    };
    json!({ "state": state.vault.shown(), "entries": entries, "suggestions": suggestions, "forward": state.forward, "upstream": upstream })
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Change {
    Add { name: String, #[serde(default)] tag: String, kind: Kind, #[serde(rename = "use")] use_: Use, value: String },
    Edit { id: String, name: Option<String>, tag: Option<String>, kind: Option<Kind>, #[serde(rename = "use")] use_: Option<Use>, value: Option<String> },
    Delete { id: String },
    Allow { id: String, allowed: bool },
    /// A suggestion becomes an entry under the name, tag, kind and use given.
    Save { id: String, name: String, #[serde(default)] tag: String, kind: Kind, #[serde(rename = "use")] use_: Use },
    Dismiss { id: String },
    Forward { on: bool },
}

/// An ssh key entry's value: the text of the unencrypted OpenSSH key file at `path` (`~/` is the home dir).
fn key_text(path: &str) -> Result<String, String> {
    let path = path.trim();
    let file = match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set, so ~/ can't be read")?).join(rest),
        None => PathBuf::from(path),
    };
    // The path is the form's value field, which may hold a secret typed there, so the reason leaves it out.
    let text = std::fs::read_to_string(&file).map_err(|e| format!("can't read that key file: {e}"))?;
    agent::parse_key(&text)?;
    Ok(text)
}

/// An ssh key entry's value kept: it must already be one.
fn key_text_kept(value: &str) -> Result<String, String> {
    agent::parse_key(value).map(|_| value.to_owned()).map_err(|e| format!("the kept value is no ssh key ({e}); give a key file"))
}

fn is_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

fn new_tag(kind: Kind, tag: String) -> Result<String, String> {
    if !tag.is_empty() {
        return Ok(tag);
    }
    Ok(format!("{}-{}", json!(kind).as_str().unwrap_or("entry"), random_hex::<3>().map_err(|e| e.to_string())?))
}

/// Applies a change to the open vault; the changed entry's id, or why not.
fn change(open: &mut Opened, change: Change) -> Result<String, String> {
    let Opened { vault, allowed, suggestions, .. } = open;
    let taken = |tag: &str, except: &str| vault.entries.iter().any(|e| e.tag == tag && e.id != except);
    let bad_tag = |tag: &str| format!("tag {tag} is taken or not made of letters, digits, - _ .");
    let id = match change {
        Change::Add { name, tag, kind, use_, value } => {
            let tag = new_tag(kind, tag)?;
            if !is_tag(&tag) || taken(&tag, "") {
                return Err(bad_tag(&tag));
            }
            let value = if kind == Kind::SshKey { key_text(&value)? } else { value };
            let id = random_hex::<8>().map_err(|e| e.to_string())?;
            vault.entries.push(Entry { id: id.clone(), name, tag, kind, use_, value, created: now() });
            id
        }
        Change::Save { id, name, tag, kind, use_ } => {
            if kind == Kind::SshKey || kind == Kind::Typed {
                return Err("a typed value is kept as a password or a token".to_owned());
            }
            let tag = new_tag(kind, tag)?;
            if !is_tag(&tag) || taken(&tag, "") {
                return Err(bad_tag(&tag));
            }
            let at = suggestions.iter().position(|s| s.id == id).ok_or("no such suggestion")?;
            let suggestion = suggestions.remove(at);
            let entry_id = random_hex::<8>().map_err(|e| e.to_string())?;
            vault.entries.push(Entry { id: entry_id.clone(), name, tag, kind, use_, value: suggestion.value.to_string(), created: now() });
            entry_id
        }
        Change::Dismiss { id } => {
            let at = suggestions.iter().position(|s| s.id == id).ok_or("no such suggestion")?;
            suggestions.remove(at);
            return Ok(id);
        }
        Change::Edit { id, name, tag, kind, use_, value } => {
            if let Some(tag) = &tag
                && (!is_tag(tag) || taken(tag, &id))
            {
                return Err(bad_tag(tag));
            }
            let entry = vault.entries.iter_mut().find(|e| e.id == id).ok_or("no such entry")?;
            let is_key = kind.unwrap_or(entry.kind) == Kind::SshKey;
            let value = match value {
                Some(path) if is_key => Some(key_text(&path)?),
                Some(value) => Some(value),
                None if is_key => Some(key_text_kept(&entry.value)?),
                None => None,
            };
            if let Some(name) = name {
                entry.name = name;
            }
            if let Some(tag) = tag {
                entry.tag = tag;
            }
            entry.kind = kind.unwrap_or(entry.kind);
            entry.use_ = use_.unwrap_or(entry.use_);
            if let Some(value) = value {
                std::mem::replace(&mut entry.value, value).zeroize();
            }
            id
        }
        Change::Delete { id } => {
            let at = vault.entries.iter().position(|e| e.id == id).ok_or("no such entry")?;
            vault.entries.remove(at);
            allowed.remove(&id);
            id
        }
        Change::Allow { id, allowed: on } => {
            if !vault.entries.iter().any(|e| e.id == id) {
                return Err("no such entry".to_owned());
            }
            if on { allowed.insert(id.clone()) } else { allowed.remove(&id) };
            return Ok(id);
        }
        Change::Forward { .. } => return Err("forwarding is not an entry change".to_owned()),
    };
    Ok(id)
}

/// Applies the change; the changed entry's id, or why not.
async fn apply(ctx: &Context, parsed: Change) -> Result<String, String> {
    if let Change::Forward { on } = parsed {
        if on && ctx.upstream.is_none() {
            return Err("there is no ssh-agent of yours to forward to".to_owned());
        }
        let mut state = lock(ctx);
        state.forward = on;
        emit(&json!({ "vault": state.vault.shown() }));
        return Ok("forward".to_owned());
    }
    let saves = !matches!(parsed, Change::Allow { .. } | Change::Dismiss { .. });
    // The change is made to what the file holds now, with no other session's relay writing meanwhile.
    let _held = if saves { Some(exclusive_waiting(&ctx.vault_path).await?) } else { None };
    let mut state = lock(ctx);
    fresh(ctx, &mut state);
    let Locker::Open(open) = &mut state.vault else { return Err("the vault is not open".to_owned()) };
    let before = (open.vault.entries.clone(), open.allowed.clone(), open.suggestions.clone());
    let done = change(open, parsed).and_then(|id| if saves { save(ctx, &open.vault).map(|seen| (id, Some(seen))) } else { Ok((id, None)) });
    let id = match done {
        Ok((id, seen)) => {
            if let Some(seen) = seen {
                open.seen = seen;
            }
            id
        }
        Err(reason) => {
            (open.vault.entries, open.allowed, open.suggestions) = before;
            return Err(reason);
        }
    };
    changed(&mut state);
    Ok(id)
}

/// `POST /vault`: 200 `{id}` once applied (and saved, for a change to the entries); 400 with the reason.
pub async fn change_vault(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let result = match serde_json::from_slice::<Change>(body) {
        Ok(parsed) => apply(ctx, parsed).await,
        Err(e) => Err(format!("not a change: {e}")),
    };
    match result {
        Ok(id) => respond(stream, "200 OK", json!({ "id": id }).to_string().as_bytes()).await,
        Err(reason) => respond(stream, "400 Bad Request", reason.as_bytes()).await,
    }
}

/// `POST /list`: the vault's entries once the hooks decide; never a value.
pub async fn list(stream: &mut UnixStream, ctx: &Context) {
    let by = peer::requester(peer::peer_pid(stream), &ctx.mask_run);
    let live = {
        let state = lock(ctx);
        matches!(state.vault, Locker::Open(_)).then(|| state.filter.live())
    };
    let Some(live) = live else { return respond(stream, "403 Forbidden", b"the vault is closed").await };
    match decide(stream, ctx, "list", json!({ "pid": by.pid, "cmdline": by.cmdline, "inside": by.inside, "live": live })).await {
        None => return,
        Some(Decision::Refuse) => return respond(stream, "403 Forbidden", b"").await,
        Some(_) => {}
    }
    let listed: Vec<_> = {
        let state = lock(ctx);
        state
            .vault
            .entries()
            .iter()
            .map(|e| json!({ "tag": e.tag, "name": e.name, "kind": e.kind, "use": e.use_, "allowed": state.vault.is_allowed(&e.id) }))
            .collect()
    };
    respond(stream, "200 OK", json!(listed).to_string().as_bytes()).await;
}
