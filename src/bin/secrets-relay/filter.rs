//! Masking, done here only: the values never leave this process. Each Bash call's `secrets-mask-run` pipes its
//! output through a `/filter` stream, masked with the values handed to that call and, while the vault is open,
//! every value it holds. The hooks send other tools' results to `/mask` and tool calls' input to `/check`.

use std::collections::HashMap;

use secrets::filter::{self as frame, BODY_MAX};
use secrets::mask::{Masker, forms};
use secrets::vault::Entry;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;
use zeroize::Zeroizing;

use crate::{Context, emit, lock, peer, respond};

/// A running call: the values it was handed, and its matcher, built from those and the vault's.
struct Call {
    values: Vec<Zeroizing<String>>,
    masker: Masker,
}

pub struct Filter {
    min_length: usize,
    calls: HashMap<i32, Call>,
    /// The open vault's values, entries and suggestions; empty while it is closed.
    vault_values: Vec<Zeroizing<String>>,
    vault: Masker,
    /// Something was masked this session; told to the hooks once, for their write-back guard.
    has_masked: bool,
}

impl Filter {
    pub fn new(min_length: usize) -> Self {
        Self { min_length, calls: HashMap::new(), vault_values: Vec::new(), vault: Masker::new(min_length), has_masked: false }
    }

    fn masker_with(&self, values: &[Zeroizing<String>]) -> Masker {
        let mut masker = Masker::new(self.min_length);
        for value in values.iter().chain(&self.vault_values) {
            masker.add(value);
        }
        masker
    }

    fn rebuild(&mut self) {
        self.vault = self.masker_with(&[]);
        let maskers: Vec<(i32, Masker)> = self.calls.iter().map(|(pid, call)| (*pid, self.masker_with(&call.values))).collect();
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
    }

    /// Masks the call `pid`'s output with `value` from now on, until the call ends.
    pub fn hand_to(&mut self, pid: i32, value: &str) {
        if let Some(call) = self.calls.get_mut(&pid) {
            call.masker.add(value);
            call.values.push(Zeroizing::new(value.to_owned()));
        }
    }

    fn found(&mut self, found: bool) {
        if found && !self.has_masked {
            self.has_masked = true;
            emit(&json!({ "masked": true }));
        }
    }

    /// One request frame of the call `pid` against what its stream holds back: the bytes to write now.
    fn take(&mut self, pid: i32, held: &mut Vec<u8>, kind: u8, body: &[u8]) -> Vec<u8> {
        held.extend_from_slice(body);
        let Some(masker) = self.calls.get(&pid).map(|call| &call.masker) else { return std::mem::take(held) };
        let cut = if kind == frame::END { held.len() } else { masker.cut(held, kind == frame::IDLE) };
        let (out, found) = masker.mask_found(held.get(..cut).unwrap_or_default());
        held.drain(..cut);
        self.found(found);
        out
    }
}

/// Serves one call's output stream until mask-run hangs up, then forgets what the call was handed.
pub async fn serve(stream: &mut UnixStream, ctx: &Context) {
    let Some(pid) = peer::mask_run_pid(stream, &ctx.mask_run) else {
        return respond(stream, "403 Forbidden", b"").await;
    };
    {
        let mut state = lock(ctx);
        let masker = state.filter.masker_with(&[]);
        state.filter.calls.insert(pid, Call { values: Vec::new(), masker });
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
    lock(ctx).filter.calls.remove(&pid);
}

async fn read_request(stream: &mut UnixStream) -> Option<(u8, u8, Vec<u8>)> {
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

/// `/mask`: the texts with the open vault's values masked.
pub fn mask_texts(ctx: &Context, body: &[u8]) -> Option<serde_json::Value> {
    let texts = serde_json::from_slice::<Texts>(body).ok()?.texts;
    let mut state = lock(ctx);
    let mut any = false;
    let masked: Vec<String> = texts
        .iter()
        .map(|text| {
            let (out, found) = state.filter.vault.mask_found(text.as_bytes());
            any |= found;
            String::from_utf8_lossy(&out).into_owned()
        })
        .collect();
    state.filter.found(any);
    Some(json!({ "texts": masked }))
}

/// `/check`: the entry, as "name (tag)", whose value any of the texts carries in some form; null for none.
pub fn check_texts(entries: &[Entry], min_length: usize, body: &[u8]) -> Option<serde_json::Value> {
    let texts = serde_json::from_slice::<Texts>(body).ok()?.texts;
    let carried = entries.iter().filter(|e| e.value.chars().count() >= min_length).find(|entry| {
        forms(&entry.value).iter().any(|form| texts.iter().any(|text| memchr::memmem::find(text.as_bytes(), form).is_some()))
    });
    Some(json!({ "label": carried.map(|e| format!("{} ({})", e.name, e.tag)) }))
}
