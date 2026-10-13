//! `secrets ask`: a program waits for a secret; the user types it into the request's card or, with the vault open,
//! picks an entry. The value goes to the program and to the asking call's filter, and is not kept here.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::json;
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::{Context, emit, hung_up, lock, peer, respond};

struct Asking {
    tx: oneshot::Sender<Option<Zeroizing<String>>>,
    prompt: String,
    /// The asking call's `secrets-mask-run`, whose output masks the value; none when it asks from outside a call.
    call: Option<i32>,
}

#[derive(Default)]
pub struct Pass {
    waiting: HashMap<String, Asking>,
}

#[derive(Deserialize)]
struct Ask {
    #[serde(default)]
    prompt: String,
    tag: Option<String>,
}

/// `POST /ask {prompt, tag?}`: 200 with the value once answered, 403 when cancelled.
pub async fn ask(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let Ok(ask) = serde_json::from_slice::<Ask>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let Ok(id) = secrets::vault::random_hex::<16>() else { return respond(stream, "500 Internal Server Error", b"").await };
    let by = peer::requester(peer::peer_pid(stream), &ctx.mask_run);
    let (tx, rx) = oneshot::channel();
    let entry = {
        let mut state = lock(ctx);
        state.pass.waiting.insert(id.clone(), Asking { tx, prompt: ask.prompt.clone(), call: by.inside.then_some(by.pid) });
        let tagged = ask.tag.as_deref().and_then(|tag| state.vault.tagged(tag));
        tagged.map(|(e, allowed)| json!({ "id": e.id, "name": e.name, "tag": e.tag, "kind": e.kind, "use": e.use_, "allowed": allowed }))
    };
    let event = json!({ "id": id, "prompt": ask.prompt, "tag": ask.tag, "entry": entry, "pid": by.pid, "cmdline": by.cmdline, "inside": by.inside });
    emit(&json!({ "ask": event }));
    tokio::select! {
        answer = rx => match answer {
            Ok(Some(value)) => respond(stream, "200 OK", value.as_bytes()).await,
            _ => respond(stream, "403 Forbidden", b"").await,
        },
        () = hung_up(stream) => {
            lock(ctx).pass.waiting.remove(&id);
            emit(&json!({ "gone": id }));
        }
    }
}

#[derive(Deserialize)]
struct Answer {
    id: String,
    secret: Option<String>,
    /// A vault entry's id instead of a typed value.
    entry: Option<String>,
    #[serde(default)]
    session: bool,
    #[serde(default)]
    cancel: bool,
}

/// `POST /answer` from the hooks: 204 taken, 410 no such ask, 409 with the reason when a picked entry can't be
/// handed out (the ask keeps waiting).
pub async fn answer(stream: &mut UnixStream, ctx: &Context, body: &[u8]) {
    let (status, reason) = match serde_json::from_slice::<Answer>(body) {
        Ok(answer) => take(ctx, answer),
        Err(_) => ("400 Bad Request", ""),
    };
    respond(stream, status, reason.as_bytes()).await;
}

fn take(ctx: &Context, answer: Answer) -> (&'static str, &'static str) {
    let mut state = lock(ctx);
    let Some(asking) = state.pass.waiting.remove(&answer.id) else { return ("410 Gone", "") };
    if answer.cancel {
        let _ = asking.tx.send(None);
        return ("204 No Content", "");
    }
    let value = match (answer.entry, answer.secret) {
        (Some(entry), _) => {
            let Some(value) = state.vault.hand_out(&entry, answer.session) else {
                state.pass.waiting.insert(answer.id, asking);
                return ("409 Conflict", "no such entry, or the vault is closed");
            };
            value
        }
        (None, Some(secret)) => {
            let secret = Zeroizing::new(secret);
            if state.vault.suggest(&asking.prompt, &secret) {
                let values = state.vault.values();
                state.filter.set_vault_values(values);
                emit(&json!({ "vault": state.vault.shown() }));
            }
            secret
        }
        (None, None) => {
            state.pass.waiting.insert(answer.id, asking);
            return ("400 Bad Request", "");
        }
    };
    if let Some(call) = asking.call {
        state.filter.hand_to(call, &value);
    }
    let _ = asking.tx.send(Some(value));
    ("204 No Content", "")
}
