//! `secrets ask`: a program waits for a secret; the user types it into the request's card or, with the vault open,
//! picks an entry. The value goes to the program and to the filter, which masks a typed one in every call while the
//! asking call runs, and is not kept here.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::json;
use secrets::local::Stream;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::access::Grant;
use crate::session::{self, Id};
use crate::{Context, emit, hung_up, lock, locker, peer, respond};

struct Asking {
    tx: oneshot::Sender<Option<Zeroizing<String>>>,
    prompt: String,
    /// The asking call's `secrets-mask-run`, whose output masks the value; none when it asks from outside a call.
    call: Option<i32>,
    /// The `ask` event, sent again to a later attach.
    event: serde_json::Value,
}

#[derive(Default)]
pub struct Pass {
    waiting: HashMap<String, Asking>,
}

impl Pass {
    /// The `ask` events of the requests still waiting.
    pub fn events(&self) -> impl Iterator<Item = serde_json::Value> + '_ {
        self.waiting.values().map(|asking| asking.event.clone())
    }
}

#[derive(Deserialize)]
struct Ask {
    #[serde(default)]
    prompt: String,
    tag: Option<String>,
}

/// `POST /ask {prompt, tag?}`: 200 with the value once answered, 403 when cancelled or the session ended.
pub async fn ask(stream: &mut Stream, ctx: &Context, session: Id, body: &[u8]) {
    let Ok(ask) = serde_json::from_slice::<Ask>(body) else { return respond(stream, "400 Bad Request", b"").await };
    let Ok(id) = secrets::vault::random_hex::<16>() else { return respond(stream, "500 Internal Server Error", b"").await };
    let (tx, rx) = oneshot::channel();
    let asked = {
        let mut guard = lock(ctx);
        let state = &mut *guard;
        state.sessions.get_mut(&session).map(|open| {
            let by = peer::requester(peer::peer_pid(stream), &ctx.mask_run, open.claude_code, &state.filter);
            let tagged = ask.tag.as_deref().and_then(|tag| state.vault.tagged(tag));
            let entry = tagged.map(|e| json!({ "id": e.id, "name": e.name, "tag": e.tag, "kind": e.kind, "access": open.access.of(&e.id) }));
            let live = state.filter.live(open.claude_code);
            let fields = json!({ "id": id, "prompt": ask.prompt, "tag": ask.tag, "entry": entry, "pid": by.pid, "cmdline": by.cmdline, "inside": by.inside, "live": live });
            let event = json!({ "ask": fields });
            session::tell(session, &event);
            open.pass.waiting.insert(id.clone(), Asking { tx, prompt: ask.prompt.clone(), call: by.inside.then_some(by.pid), event });
        })
    };
    if asked.is_none() {
        return respond(stream, "403 Forbidden", b"").await;
    }
    tokio::select! {
        answer = rx => match answer {
            Ok(Some(value)) => respond(stream, "200 OK", value.as_bytes()).await,
            _ => respond(stream, "403 Forbidden", b"").await,
        },
        () = hung_up(stream) => {
            if let Some(open) = lock(ctx).sessions.get_mut(&session) {
                open.pass.waiting.remove(&id);
            }
            session::tell(session, &json!({ "gone": id }));
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
pub async fn answer(stream: &mut Stream, ctx: &Context, session: Id, body: &[u8]) {
    let (status, reason) = match serde_json::from_slice::<Answer>(body) {
        Ok(answer) => take(ctx, session, answer),
        Err(_) => ("400 Bad Request", ""),
    };
    respond(stream, status, reason.as_bytes()).await;
}

fn take(ctx: &Context, session: Id, answer: Answer) -> (&'static str, &'static str) {
    let mut state = lock(ctx);
    let Some(asking) = state.sessions.get_mut(&session).and_then(|s| s.pass.waiting.remove(&answer.id)) else { return ("410 Gone", "") };
    let put_back = |state: &mut crate::State, asking: Asking| {
        if let Some(open) = state.sessions.get_mut(&session) {
            open.pass.waiting.insert(answer.id.clone(), asking);
        }
    };
    if answer.cancel {
        let _ = asking.tx.send(None);
        return ("204 No Content", "");
    }
    let typed = answer.secret.is_some() && answer.entry.is_none();
    let value = match (answer.entry.as_ref(), answer.secret) {
        (Some(entry), _) => {
            let Some(value) = state.vault.hand_out(entry) else {
                put_back(&mut state, asking);
                return ("409 Conflict", "no such entry, or the vault is closed");
            };
            // The value goes out either way: the person picked it; a grant that can't be kept is only told.
            if answer.session
                && let Err(error) = locker::grant(&mut state, session, entry, Grant::Allowed)
            {
                emit(&json!({ "trouble": format!("vault: not allowed for the session: {error}") }));
            }
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
            put_back(&mut state, asking);
            return ("400 Bad Request", "");
        }
    };
    match asking.call {
        Some(call) if typed => state.filter.type_for(call, &value),
        Some(call) => state.filter.hand_to(call, &value),
        None => {}
    }
    let _ = asking.tx.send(Some(value));
    ("204 No Content", "")
}
