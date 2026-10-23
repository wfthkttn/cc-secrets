//! The vault, one for every session: this daemon alone reads and writes its file. Closed (absent or locked) it holds
//! and tracks nothing; open, it holds its entries and the values typed while it was open that it suggests keeping.
//! What each session lets its agent have of an entry is that session's `access`, not the vault's. Only the hooks
//! unlock it, with the passphrase typed into the Vault tab; unlocked once, it is open for every session until the
//! Lock button or the daemon's end.

use std::path::PathBuf;
use std::sync::Arc;

use secrets::agent;
use secrets::vault::{Entry, Kind, Vault, random_hex};
use serde::Deserialize;
use serde_json::json;
use secrets::local::Stream;
use zeroize::{Zeroize as _, Zeroizing};

use crate::access::Grant;
use crate::session::Id;
use crate::{COSTS, Context, Shared, State, emit, lock, note, now, respond};

pub enum Locker {
    Absent,
    Locked,
    Open(Box<Opened>),
}

pub struct Opened {
    vault: Vault,
    suggestions: Vec<Suggestion>,
}

/// A value typed while the vault was open, kept in memory until the user saves or dismisses it.
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

    /// Every value the open vault holds, its suggestions too.
    pub fn values(&self) -> Vec<Zeroizing<String>> {
        let Self::Open(open) = self else { return Vec::new() };
        let entries = open.vault.entries.iter().map(|e| Zeroizing::new(e.value.clone()));
        entries.chain(open.suggestions.iter().map(|s| s.value.clone())).collect()
    }

    /// The entry tagged `tag` that `secrets ask --tag` can hand out.
    pub fn tagged(&self, tag: &str) -> Option<&Entry> {
        self.entries().iter().find(|e| e.tag == tag && e.kind != Kind::SshKey)
    }

    /// The value of the entry `id` for an answer.
    pub fn hand_out(&self, id: &str) -> Option<Zeroizing<String>> {
        let entry = self.entries().iter().find(|e| e.id == id && e.kind != Kind::SshKey)?;
        Some(Zeroizing::new(entry.value.clone()))
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

/// Writes the vault; the reason it couldn't, which the hooks are told too.
fn save(ctx: &Context, vault: &Vault) -> Result<(), String> {
    vault.save(&ctx.vault_path).map_err(|error| {
        let text = format!("vault: can't save {}: {error}", ctx.vault_path.display());
        emit(&json!({ "trouble": text }));
        text
    })
}

/// Forgets every session's grants of entries the open vault no longer holds; a closed vault tells nothing of them.
pub fn prune(state: &mut State) {
    let Locker::Open(open) = &state.vault else { return };
    let live = open.vault.entries.iter().map(|e| e.id.as_str()).collect();
    for session in state.sessions.values_mut() {
        if let Err(error) = session.access.keep_only(&live) {
            emit(&json!({ "trouble": format!("vault: {error}") }));
        }
    }
}

/// Sets the session's grant of the entry `id`; the hooks are told of a change.
pub fn grant(state: &mut State, session: Id, id: &str, grant: Grant) -> Result<(), String> {
    if !state.vault.entries().iter().any(|e| e.id == id) {
        return Err("no such entry, or the vault is closed".to_owned());
    }
    let open = state.sessions.get_mut(&session).ok_or_else(|| "the session ended".to_owned())?;
    if open.access.set(id, grant)? {
        emit(&json!({ "vault": state.vault.shown() }));
    }
    Ok(())
}

/// The vault changed: masking takes its values, the hooks are told.
fn changed(state: &mut State) {
    let values = state.vault.values();
    state.filter.set_vault_values(values);
    emit(&json!({ "vault": state.vault.shown() }));
}

fn opened(state: &mut State, vault: Vault) {
    state.vault = Locker::Open(Box::new(Opened { vault, suggestions: Vec::new() }));
    prune(state);
    changed(state);
}

/// `POST /lock`: the open vault closes for every session, its suggestions gone; 204, 409 when it isn't open.
pub async fn close(stream: &mut Stream, ctx: &Context, by: &str) {
    let shown = {
        let mut state = lock(ctx);
        let shown = state.vault.shown();
        if shown == "open" {
            state.vault = Locker::Locked;
            changed(&mut state);
        }
        shown
    };
    if shown == "open" {
        note(&format!("vault locked by {by}"));
        respond(stream, "204 No Content", b"").await;
    } else {
        respond(stream, "409 Conflict", format!("the vault is {shown}").as_bytes()).await;
    }
}

#[derive(Deserialize)]
struct Passphrase {
    passphrase: String,
}

/// `/unlock` or, with `create`, `/create`: 204 once open, 403 for a wrong passphrase, 409 when the vault isn't in
/// a state to do it, 500 with the reason when the file can't be read or written.
pub async fn open(stream: &mut Stream, ctx: &Shared, body: &[u8], create: bool, by: &str) {
    let Ok(Passphrase { passphrase }) = serde_json::from_slice::<Passphrase>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let passphrase = Zeroizing::new(passphrase);
    let expected = if create { "absent" } else { "locked" };
    let shown = lock(ctx).vault.shown();
    if shown != expected {
        return respond(stream, "409 Conflict", format!("the vault is {shown}").as_bytes()).await;
    }
    let shared = Arc::clone(ctx);
    let result = tokio::task::spawn_blocking(move || -> Result<(), (&'static str, String)> {
        let path = &shared.vault_path;
        let failed = |error: secrets::vault::Error| match error {
            secrets::vault::Error::Refused => ("403 Forbidden", "wrong passphrase".to_owned()),
            error => ("500 Internal Server Error", format!("{}: {error}", path.display())),
        };
        let mut vault = if create { Vault::create(passphrase.as_bytes(), COSTS) } else { Vault::open(path, passphrase.as_bytes()) }.map_err(failed)?;
        let mut state = lock(&shared);
        // Another session's unlock or create may have come first.
        let shown = state.vault.shown();
        if shown != expected {
            return Err(("409 Conflict", format!("the vault is {shown}")));
        }
        if create || vault.entries.iter().any(|e| e.kind == Kind::Typed) {
            // Earlier versions kept every typed answer as an entry.
            vault.entries.retain(|e| e.kind != Kind::Typed);
            vault.save(path).map_err(failed)?;
        }
        opened(&mut state, vault);
        Ok(())
    })
    .await;
    let done = if create { "created" } else { "unlocked" };
    match result {
        Ok(Ok(())) => {
            note(&format!("vault {done} by {by}"));
            respond(stream, "204 No Content", b"").await;
        }
        Ok(Err((status, reason))) => {
            note(&format!("vault not {done} for {by}: {reason}"));
            respond(stream, status, reason.as_bytes()).await;
        }
        Err(error) => respond(stream, "500 Internal Server Error", format!("unlocking stopped: {error}").as_bytes()).await,
    }
}

/// `POST /passphrase {passphrase}`: the open vault sealed under a new passphrase, its entries kept; 204 once saved,
/// 409 when it isn't open, 400 for an empty passphrase, 500 with the reason when it can't be saved.
pub async fn rekey(stream: &mut Stream, ctx: &Shared, body: &[u8], by: &str) {
    let Ok(Passphrase { passphrase }) = serde_json::from_slice::<Passphrase>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let passphrase = Zeroizing::new(passphrase);
    if passphrase.is_empty() {
        return respond(stream, "400 Bad Request", b"the passphrase is empty").await;
    }
    let shared = Arc::clone(ctx);
    let result = tokio::task::spawn_blocking(move || -> Result<(), (&'static str, String)> {
        let mut state = lock(&shared);
        let shown = state.vault.shown();
        let Locker::Open(open) = &mut state.vault else { return Err(("409 Conflict", format!("the vault is {shown}"))) };
        let failed = |error: secrets::vault::Error| ("500 Internal Server Error", format!("{}: {error}", shared.vault_path.display()));
        open.vault.rekey(passphrase.as_bytes(), COSTS).map_err(failed)?;
        save(&shared, &open.vault).map_err(|reason| ("500 Internal Server Error", reason))?;
        changed(&mut state);
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => {
            note(&format!("vault passphrase changed by {by}"));
            respond(stream, "204 No Content", b"").await;
        }
        Ok(Err((status, reason))) => respond(stream, status, reason.as_bytes()).await,
        Err(error) => respond(stream, "500 Internal Server Error", format!("changing the passphrase stopped: {error}").as_bytes()).await,
    }
}

/// `GET /vault`: what the session's Vault tab shows; never a value.
pub fn show(state: &State, session: Id) -> serde_json::Value {
    let open = state.sessions.get(&session);
    let access = |id: &str| open.map_or(Grant::Ask, |s| s.access.of(id));
    let (entries, suggestions) = match &state.vault {
        Locker::Open(vault) => (
            vault
                .vault
                .entries
                .iter()
                .map(|e| json!({ "id": e.id, "name": e.name, "tag": e.tag, "kind": e.kind, "created": e.created, "access": access(&e.id) }))
                .collect(),
            vault.suggestions.iter().map(|s| json!({ "id": s.id, "prompt": s.prompt })).collect(),
        ),
        _ => (Vec::new(), Vec::new()),
    };
    let forward = open.is_some_and(|s| s.access.forward());
    let upstream = open.is_some_and(|s| s.upstream.is_some());
    json!({ "state": state.vault.shown(), "entries": entries, "suggestions": suggestions, "forward": forward, "upstream": upstream })
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Change {
    Add { name: String, #[serde(default)] tag: String, kind: Kind, value: String },
    Edit { id: String, name: Option<String>, tag: Option<String>, kind: Option<Kind>, value: Option<String> },
    Delete { id: String },
    /// The entry goes to place `to` in the list; past the end, to the end.
    Move { id: String, to: usize },
    /// The session's grant of the entry, not the vault's.
    Access { id: String, access: Grant },
    /// A suggestion becomes an entry under the name, tag and kind given.
    Save { id: String, name: String, #[serde(default)] tag: String, kind: Kind },
    Dismiss { id: String },
    /// The session's ssh-agent offers the user's own agent's keys too.
    Forward { on: bool },
}

#[cfg(unix)]
fn home() -> Option<std::ffi::OsString> {
    std::env::var_os("HOME")
}

/// The home Windows programs use: a `HOME` set for Git Bash may be an MSYS path (`/c/Users/…`).
#[cfg(windows)]
fn home() -> Option<std::ffi::OsString> {
    std::env::var_os("USERPROFILE")
}

/// An ssh key entry's value: the text of the unencrypted OpenSSH key file at `path` (`~/` is the home dir).
fn key_text(path: &str) -> Result<String, String> {
    let path = path.trim();
    let file = match path.strip_prefix("~/") {
        Some(rest) => PathBuf::from(home().ok_or("the home folder isn't set (HOME, on Windows USERPROFILE), so ~/ can't be read")?).join(rest),
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
    let Opened { vault, suggestions } = open;
    let taken = |tag: &str, except: &str| vault.entries.iter().any(|e| e.tag == tag && e.id != except);
    let bad_tag = |tag: &str| format!("tag {tag} is taken or not made of letters, digits, - _ .");
    let id = match change {
        Change::Add { name, tag, kind, value } => {
            let tag = new_tag(kind, tag)?;
            if !is_tag(&tag) || taken(&tag, "") {
                return Err(bad_tag(&tag));
            }
            let value = if kind == Kind::SshKey { key_text(&value)? } else { value };
            let id = random_hex::<8>().map_err(|e| e.to_string())?;
            vault.entries.push(Entry { id: id.clone(), name, tag, kind, value, created: now() });
            id
        }
        Change::Save { id, name, tag, kind } => {
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
            vault.entries.push(Entry { id: entry_id.clone(), name, tag, kind, value: suggestion.value.to_string(), created: now() });
            entry_id
        }
        Change::Dismiss { id } => {
            let at = suggestions.iter().position(|s| s.id == id).ok_or("no such suggestion")?;
            suggestions.remove(at);
            return Ok(id);
        }
        Change::Edit { id, name, tag, kind, value } => {
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
            if let Some(value) = value {
                std::mem::replace(&mut entry.value, value).zeroize();
            }
            id
        }
        Change::Delete { id } => {
            let at = vault.entries.iter().position(|e| e.id == id).ok_or("no such entry")?;
            vault.entries.remove(at);
            id
        }
        Change::Move { id, to } => {
            let at = vault.entries.iter().position(|e| e.id == id).ok_or("no such entry")?;
            let entry = vault.entries.remove(at);
            vault.entries.insert(to.min(vault.entries.len()), entry);
            id
        }
        Change::Forward { .. } | Change::Access { .. } => return Err("not an entry change".to_owned()),
    };
    Ok(id)
}

/// Applies the change for the session; the changed entry's id, or why not.
fn apply(ctx: &Context, session: Id, parsed: Change) -> Result<String, String> {
    let mut state = lock(ctx);
    if let Change::Forward { on } = parsed {
        let open = state.sessions.get_mut(&session).ok_or_else(|| "the session ended".to_owned())?;
        if on && open.upstream.is_none() {
            return Err("there is no ssh-agent of yours to forward to".to_owned());
        }
        open.access.set_forward(on)?;
        emit(&json!({ "vault": state.vault.shown() }));
        return Ok("forward".to_owned());
    }
    if let Change::Access { id, access } = parsed {
        grant(&mut state, session, &id, access)?;
        return Ok(id);
    }
    let saves = !matches!(parsed, Change::Dismiss { .. });
    let Locker::Open(open) = &mut state.vault else { return Err("the vault is not open".to_owned()) };
    let before = (open.vault.entries.clone(), open.suggestions.clone());
    let done = change(open, parsed).and_then(|id| if saves { save(ctx, &open.vault).map(|()| id) } else { Ok(id) });
    let id = match done {
        Ok(id) => id,
        Err(reason) => {
            (open.vault.entries, open.suggestions) = before;
            return Err(reason);
        }
    };
    prune(&mut state);
    changed(&mut state);
    Ok(id)
}

/// `POST /vault`: 200 `{id}` once applied (and saved, for a change to the entries); 400 with the reason.
pub async fn change_vault(stream: &mut Stream, ctx: &Context, session: Id, body: &[u8]) {
    let result = match serde_json::from_slice::<Change>(body) {
        Ok(parsed) => apply(ctx, session, parsed),
        Err(e) => Err(format!("not a change: {e}")),
    };
    match result {
        Ok(id) => respond(stream, "200 OK", json!({ "id": id }).to_string().as_bytes()).await,
        Err(reason) => respond(stream, "400 Bad Request", reason.as_bytes()).await,
    }
}
