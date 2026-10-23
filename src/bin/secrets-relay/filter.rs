//! Masking, done here only: the values never leave this process. Each Bash call's `secrets-mask-run` pipes its
//! output through a `/filter` stream, masked with the values handed to that call, the values typed for any call
//! still running and, while the vault is open, every value it holds. The hooks send other tools' results to `/mask`
//! and tool calls' input to `/check`.

use std::collections::{HashMap, HashSet};

use secrets::filter::{self as frame, BODY_MAX};
use secrets::mask::{Masker, forms};
use secrets::vault::Entry;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use secrets::local::Stream;
use zeroize::{Zeroize as _, Zeroizing};

use crate::session::Id;
use crate::{Context, emit, lock, peer, respond};

/// A running call: the values it was handed, and its matcher, built from those and the vault's.
struct Call {
    values: Vec<Zeroizing<String>>,
    masker: Masker,
    /// Its `secrets-mask-run`'s, which holds the command.
    cmdline: String,
    /// The Claude Code process of the session it runs in.
    claude_code: i32,
    /// The job its processes run in; none when mask-run couldn't make one.
    #[cfg(windows)]
    job: Option<secrets::job::Job>,
}

pub struct Filter {
    min_length: usize,
    calls: HashMap<i32, Call>,
    /// Typed values, each with the call it was handed to: every call masks them until that call ends, since another
    /// call can show the asking one's command line (`ps`).
    typed: Vec<(i32, Zeroizing<String>)>,
    /// The open vault's values, entries and suggestions; empty while it is closed.
    vault_values: Vec<Zeroizing<String>>,
    vault: Masker,
    /// The Claude Code processes of the sessions where something was masked; told to the hooks once per session, for
    /// their write-back guard.
    has_masked: HashSet<i32>,
    /// What the hooks were last told of whether `/mask` has values to mask.
    told_masking: bool,
}

impl Filter {
    pub fn new(min_length: usize) -> Self {
        Self {
            min_length,
            calls: HashMap::new(),
            typed: Vec::new(),
            vault_values: Vec::new(),
            vault: Masker::new(min_length),
            has_masked: HashSet::new(),
            told_masking: false,
        }
    }

    /// The command lines of the session's calls whose output runs through here now.
    pub fn live(&self, claude_code: i32) -> Vec<String> {
        self.calls.values().filter(|call| call.claude_code == claude_code).map(|call| call.cmdline.clone()).collect()
    }

    /// The session's running call whose processes include `pid`, by its job: on Windows the line of parents can break
    /// between a call and its processes.
    #[cfg(windows)]
    pub fn call_holding(&self, claude_code: i32, pid: i32) -> Option<i32> {
        self.calls.iter().find(|(_, call)| call.claude_code == claude_code && call.job.as_ref().is_some_and(|job| job.holds(pid))).map(|(call, _)| *call)
    }

    /// On Unix the line of parents leads to every call, so no call is found otherwise.
    #[cfg(unix)]
    #[allow(clippy::unused_self, reason = "the same signature as on Windows")]
    pub fn call_holding(&self, _claude_code: i32, _pid: i32) -> Option<i32> {
        None
    }

    /// Whether `/mask` has values to mask, as the hooks were last told.
    pub fn masking(&self) -> bool {
        self.told_masking
    }

    /// Tells the hooks when `/mask` starts or stops having values to mask: the open vault's, or one typed for a
    /// running call. They send other tools' results only meanwhile.
    fn tell_masking(&mut self) {
        let masking = !self.vault_values.is_empty() || !self.typed.is_empty();
        if masking != self.told_masking {
            self.told_masking = masking;
            emit(&json!({ "masking": masking }));
        }
    }

    /// The matcher of the call `pid` (none: `/mask`'s), which was handed `values`: those and the ones typed for it are
    /// masked in its output whatever their length.
    fn masker_for(&self, pid: Option<i32>, values: &[Zeroizing<String>]) -> Masker {
        let mut masker = Masker::new(self.min_length);
        for value in values {
            masker.add_any_length(value);
        }
        for value in &self.vault_values {
            masker.add(value);
        }
        for (owner, value) in &self.typed {
            if Some(*owner) == pid {
                masker.add_any_length(value);
            } else {
                masker.add(value);
            }
        }
        masker
    }

    fn rebuild(&mut self) {
        self.vault = self.masker_for(None, &[]);
        let maskers: Vec<(i32, Masker)> = self.calls.iter().map(|(pid, call)| (*pid, self.masker_for(Some(*pid), &call.values))).collect();
        for (pid, masker) in maskers {
            if let Some(call) = self.calls.get_mut(&pid) {
                call.masker = masker;
            }
        }
    }

    pub fn min_length(&self) -> usize {
        self.min_length
    }

    pub fn set_min_length(&mut self, min_length: usize) {
        self.min_length = min_length;
        self.rebuild();
    }

    pub fn set_vault_values(&mut self, values: Vec<Zeroizing<String>>) {
        self.vault_values = values;
        self.rebuild();
        self.tell_masking();
    }

    /// Masks the call `pid`'s output with `value` from now on, whatever its length, until the call ends.
    pub fn hand_to(&mut self, pid: i32, value: &str) {
        if let Some(call) = self.calls.get_mut(&pid) {
            call.masker.add_any_length(value);
            call.values.push(Zeroizing::new(value.to_owned()));
        }
    }

    /// Masks every running call's output with a value typed for the call `pid`, until that call ends; the call `pid`
    /// masks it whatever its length.
    pub fn type_for(&mut self, pid: i32, value: &str) {
        if !self.calls.contains_key(&pid) {
            return;
        }
        for (call_pid, call) in &mut self.calls {
            if *call_pid == pid {
                call.masker.add_any_length(value);
            } else {
                call.masker.add(value);
            }
        }
        self.vault.add(value);
        self.typed.push((pid, Zeroizing::new(value.to_owned())));
        self.tell_masking();
    }

    /// Forgets the call `pid` and the values typed for it.
    fn end(&mut self, pid: i32) {
        self.calls.remove(&pid);
        let before = self.typed.len();
        self.typed.retain(|(owner, _)| *owner != pid);
        if self.typed.len() != before {
            self.rebuild();
            self.tell_masking();
        }
    }

    /// Something was masked in the session of `claude_code`. Every session is told the first time, as the event
    /// names no session; a guard on where nothing was masked costs nothing.
    fn found(&mut self, found: bool, claude_code: i32) {
        if found && self.has_masked.insert(claude_code) {
            emit(&json!({ "masked": true }));
        }
    }

    /// One request frame of the call `pid` against what its stream holds back: the bytes to write now.
    fn take(&mut self, pid: i32, held: &mut Vec<u8>, kind: u8, body: &[u8]) -> Vec<u8> {
        held.extend_from_slice(body);
        let Some((masker, claude_code)) = self.calls.get(&pid).map(|call| (&call.masker, call.claude_code)) else { return std::mem::take(held) };
        let (cut, (out, found)) = if kind == frame::END {
            (held.len(), masker.mask_end(held))
        } else {
            let cut = masker.cut(held, kind == frame::IDLE);
            (cut, masker.mask_found(held.get(..cut).unwrap_or_default()))
        };
        held.drain(..cut);
        self.found(found, claude_code);
        out
    }
}

/// What mask-run sends with `/filter` on Windows.
#[cfg(windows)]
#[derive(Deserialize)]
struct Opening {
    /// Its handle to the job its command runs in.
    job: usize,
}

/// Serves one call's output stream until mask-run hangs up, then forgets what the call was handed. A `secrets-mask-run`
/// that isn't the call but runs inside one of the session's calls (a nested Claude Code's) gets 409: its output goes
/// through that call's. On Unix it finds that call among its parents itself, so it gets 403 like any other.
#[cfg_attr(unix, allow(unused_variables, reason = "the body carries something on Windows only"))]
pub async fn serve(stream: &mut Stream, ctx: &Context, session: Id, body: &[u8]) {
    let Some(claude_code) = lock(ctx).sessions.get(&session).map(|s| s.claude_code) else {
        return respond(stream, "403 Forbidden", b"").await;
    };
    let Some(pid) = peer::mask_run_pid(stream, &ctx.mask_run, claude_code) else {
        let inside = peer::peer_pid(stream).and_then(|peer| lock(ctx).filter.call_holding(claude_code, peer)).is_some();
        return respond(stream, if inside { "409 Conflict" } else { "403 Forbidden" }, b"").await;
    };
    let cmdline = peer::cmdline_of(i64::from(pid));
    #[cfg(windows)]
    let job = serde_json::from_slice::<Opening>(body).ok().and_then(|opening| secrets::job::Job::of(pid, opening.job));
    #[cfg(windows)]
    if job.is_none() && !body.is_empty() {
        crate::note(&format!("the job of the call {pid} can't be used: what a program under another Git Bash program asks for counts as outside the session"));
    }
    {
        let mut state = lock(ctx);
        let masker = state.filter.masker_for(Some(pid), &[]);
        #[cfg(unix)]
        let call = Call { values: Vec::new(), masker, cmdline, claude_code };
        #[cfg(windows)]
        let call = Call { values: Vec::new(), masker, cmdline, claude_code, job };
        state.filter.calls.insert(pid, call);
    }
    if stream.write_all(b"HTTP/1.0 200 OK\r\n\r\n").await.is_ok() {
        let mut held = [Vec::new(), Vec::new()];
        while let Some((kind, which, body)) = read_request(stream).await {
            let Some(held) = held.get_mut(usize::from(which)) else { break };
            let out = lock(ctx).filter.take(pid, held, kind, &body);
            if stream.write_all(&frame::reply(!held.is_empty(), &out)).await.is_err() {
                break;
            }
        }
    }
    lock(ctx).filter.end(pid);
}

async fn read_request(stream: &mut Stream) -> Option<(u8, u8, Vec<u8>)> {
    let mut head = [0u8; 6];
    stream.read_exact(&mut head).await.ok()?;
    let [kind, which, a, b, c, d] = head;
    let length = usize::try_from(u32::from_be_bytes([a, b, c, d])).ok().filter(|n| *n <= BODY_MAX)?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await.ok()?;
    Some((kind, which, body))
}

#[derive(Deserialize)]
pub struct Texts {
    texts: Vec<String>,
}

impl Drop for Texts {
    fn drop(&mut self) {
        self.texts.zeroize();
    }
}

/// `/mask`: the texts with the open vault's values masked, for the session of `claude_code`.
pub fn mask_texts(ctx: &Context, claude_code: i32, body: &[u8]) -> Option<serde_json::Value> {
    let parsed = serde_json::from_slice::<Texts>(body).ok()?;
    let mut state = lock(ctx);
    let mut any = false;
    let masked: Vec<String> = parsed
        .texts
        .iter()
        .map(|text| {
            let (out, found) = state.filter.vault.mask_found(text.as_bytes());
            any |= found;
            String::from_utf8_lossy(&out).into_owned()
        })
        .collect();
    state.filter.found(any, claude_code);
    Some(json!({ "texts": masked }))
}

/// `/check`: the entry, as "name (tag)", whose value any of the texts carries in some form; null for none.
pub fn check_texts(entries: &[Entry], min_length: usize, body: &[u8]) -> Option<serde_json::Value> {
    let parsed = serde_json::from_slice::<Texts>(body).ok()?;
    let carried = entries.iter().filter(|e| e.value.chars().count() >= min_length).find(|entry| {
        forms(&entry.value).iter().any(|form| parsed.texts.iter().any(|text| memchr::memmem::find(text.as_bytes(), form).is_some()))
    });
    Some(json!({ "label": carried.map(|e| format!("{} ({})", e.name, e.tag)) }))
}
