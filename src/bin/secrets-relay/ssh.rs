//! `<socket>.agent`: an ssh-agent offering the open vault's ssh keys; each signature waits on a `sign` decision.
//! With forwarding on, it also offers the user's own agent's keys and passes their signatures through.

use std::path::Path;

use secrets::agent;
use secrets::vault::Entry;
use serde_json::json;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;

use crate::{Context, Decision, Shared, decide, lock, note, peer};

async fn read_frame(stream: &mut UnixStream) -> Option<Vec<u8>> {
    let mut length = [0u8; 4];
    stream.read_exact(&mut length).await.ok()?;
    let length = usize::try_from(u32::from_be_bytes(length)).ok().filter(|n| (1..=agent::FRAME_MAX).contains(n))?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await.ok()?;
    Some(body)
}

/// One request to the user's own agent; its reply's body, or None when it can't be reached.
async fn ask_upstream(path: &Path, body: &[u8]) -> Option<Vec<u8>> {
    let mut stream = UnixStream::connect(path).await.ok()?;
    stream.write_all(&agent::frame(body)).await.ok()?;
    read_frame(&mut stream).await
}

/// The open vault's ssh keys with their blobs; none while it is closed.
fn vault_keys(ctx: &Context) -> Vec<(Entry, ssh_key::PrivateKey, Vec<u8>)> {
    let entries = lock(ctx).vault.ssh_keys();
    let mut keys = Vec::new();
    for entry in entries {
        match agent::parse_key(&entry.value).and_then(|key| Ok((agent::blob(&key)?, key))) {
            Ok((blob, key)) => keys.push((entry, key, blob)),
            Err(error) => note(&format!("ssh key {} is not offered: {error}", entry.tag)),
        }
    }
    keys
}

pub async fn serve(mut stream: UnixStream, ctx: Shared) {
    let peer = peer::peer_pid(&stream);
    while let Some(body) = read_frame(&mut stream).await {
        let reply = reply(&mut stream, &ctx, peer, &body).await;
        if stream.write_all(&agent::frame(&reply)).await.is_err() {
            return;
        }
    }
}

async fn reply(stream: &mut UnixStream, ctx: &Context, peer: Option<i32>, body: &[u8]) -> Vec<u8> {
    let upstream = if lock(ctx).forward { ctx.upstream.clone() } else { None };
    match agent::parse_request(body) {
        agent::Request::Identities => {
            let mut identities: Vec<(Vec<u8>, String)> = vault_keys(ctx).into_iter().map(|(entry, _, blob)| (blob, entry.name.clone())).collect();
            if let Some(path) = &upstream {
                let theirs = ask_upstream(path, body).await.and_then(|reply| agent::parse_identities_answer(&reply)).unwrap_or_default();
                for identity in theirs {
                    if !identities.iter().any(|(blob, _)| *blob == identity.0) {
                        identities.push(identity);
                    }
                }
            }
            agent::identities_answer(&identities)
        }
        agent::Request::Sign { blob, data, flags } => match vault_keys(ctx).into_iter().find(|(_, _, b)| *b == blob) {
            Some((entry, key, _)) => sign_with(stream, ctx, peer, &entry, &key, &data, flags).await,
            None => match &upstream {
                Some(path) => ask_upstream(path, body).await.unwrap_or_else(|| vec![agent::FAILURE]),
                None => vec![agent::FAILURE],
            },
        },
        agent::Request::Other => vec![agent::FAILURE],
    }
}

/// Signs with a vault key once the hooks give it.
async fn sign_with(stream: &mut UnixStream, ctx: &Context, peer: Option<i32>, entry: &Entry, key: &ssh_key::PrivateKey, data: &[u8], flags: u32) -> Vec<u8> {
    let by = peer::requester(peer, &ctx.mask_run);
    let allowed = lock(ctx).vault.is_allowed(&entry.id);
    let event = json!({ "tag": entry.tag, "name": entry.name, "kind": entry.kind, "use": entry.use_, "allowed": allowed, "pid": by.pid, "cmdline": by.cmdline, "inside": by.inside });
    let decision = decide(stream, ctx, "sign", event).await;
    if decision == Some(Decision::Session) {
        lock(ctx).vault.allow(&entry.id);
    }
    if !matches!(decision, Some(Decision::Give | Decision::Session)) {
        return vec![agent::FAILURE];
    }
    agent::sign(key, data, flags).map_or_else(
        |error| {
            note(&format!("can't sign with {}: {error}", entry.tag));
            vec![agent::FAILURE]
        },
        |signature| agent::sign_response(&signature),
    )
}
