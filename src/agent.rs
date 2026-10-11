//! The ssh-agent protocol (RFC 9987 §5) for the keys the vault holds: listing them and signing with them.
//! A frame is a u32 length, then a type byte and its contents; strings are a u32 length and the bytes.

use rsa::pkcs1v15::SigningKey;
use rsa::signature::{SignatureEncoding as _, Signer as _};
use ssh_encoding::Encode;
use ssh_key::PrivateKey;
use ssh_key::private::KeypairData;

pub const FAILURE: u8 = 5;
pub const REQUEST_IDENTITIES: u8 = 11;
pub const IDENTITIES_ANSWER: u8 = 12;
pub const SIGN_REQUEST: u8 = 13;
pub const SIGN_RESPONSE: u8 = 14;
const RSA_SHA2_256: u32 = 2;
const RSA_SHA2_512: u32 = 4;
/// Longer frames are refused: no request of the four answered here comes near it.
pub const FRAME_MAX: usize = 256 * 1024;

pub enum Request {
    Identities,
    Sign { blob: Vec<u8>, data: Vec<u8>, flags: u32 },
    /// Any other message, answered with a failure (or passed upstream).
    Other,
}

fn take<'a>(body: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
    let (head, rest) = body.split_at_checked(n)?;
    *body = rest;
    Some(head)
}

fn take_u32(body: &mut &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(take(body, 4)?.try_into().ok()?))
}

fn take_string<'a>(body: &mut &'a [u8]) -> Option<&'a [u8]> {
    let n = usize::try_from(take_u32(body)?).ok()?;
    take(body, n)
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// A frame's body (type byte and contents) with its length in front.
pub fn frame(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 4);
    put_string(&mut out, body);
    out
}

pub fn parse_request(body: &[u8]) -> Request {
    let mut rest = body;
    match take(&mut rest, 1).and_then(|t| t.first().copied()) {
        Some(REQUEST_IDENTITIES) => Request::Identities,
        Some(SIGN_REQUEST) => (|| {
            let blob = take_string(&mut rest)?.to_vec();
            let data = take_string(&mut rest)?.to_vec();
            let flags = take_u32(&mut rest)?;
            Some(Request::Sign { blob, data, flags })
        })()
        .unwrap_or(Request::Other),
        _ => Request::Other,
    }
}

/// The body of an identities answer listing each (key blob, comment).
pub fn identities_answer(identities: &[(Vec<u8>, String)]) -> Vec<u8> {
    let mut out = vec![IDENTITIES_ANSWER];
    out.extend_from_slice(&u32::try_from(identities.len()).unwrap_or(u32::MAX).to_be_bytes());
    for (blob, comment) in identities {
        put_string(&mut out, blob);
        put_string(&mut out, comment.as_bytes());
    }
    out
}

/// The (key blob, comment) pairs of an identities answer's body, as another agent sent it.
pub fn parse_identities_answer(body: &[u8]) -> Option<Vec<(Vec<u8>, String)>> {
    let mut rest = body;
    if take(&mut rest, 1)? != [IDENTITIES_ANSWER] {
        return None;
    }
    let count = take_u32(&mut rest)?;
    (0..count)
        .map(|_| Some((take_string(&mut rest)?.to_vec(), String::from_utf8_lossy(take_string(&mut rest)?).into_owned())))
        .collect()
}

pub fn sign_response(signature: &[u8]) -> Vec<u8> {
    let mut out = vec![SIGN_RESPONSE];
    put_string(&mut out, signature);
    out
}

/// An unencrypted OpenSSH private key out of its file's text.
pub fn parse_key(text: &str) -> Result<PrivateKey, String> {
    let key = PrivateKey::from_openssh(text).map_err(|e| format!("not an OpenSSH private key: {e}"))?;
    if key.is_encrypted() {
        return Err("the key is passphrase-protected; the vault takes unencrypted keys only".to_owned());
    }
    Ok(key)
}

fn encoded(value: &impl Encode) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    value.encode(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The public key as the agent protocol names it: its wire-format blob.
pub fn blob(key: &PrivateKey) -> Result<Vec<u8>, String> {
    encoded(key.public_key().key_data())
}

/// Not `rsa::RsaPrivateKey::try_from`: ssh-key's conversion passes `p` as both primes, which every real key fails.
fn rsa_private(pair: &ssh_key::private::RsaKeypair) -> Result<rsa::RsaPrivateKey, String> {
    let number = |m: &ssh_key::Mpint| m.as_positive_bytes().map(rsa::BigUint::from_bytes_be).ok_or("an RSA key part is not a positive number");
    let primes = vec![number(&pair.private.p)?, number(&pair.private.q)?];
    rsa::RsaPrivateKey::from_components(number(&pair.public.n)?, number(&pair.public.e)?, number(&pair.private.d)?, primes).map_err(|e| e.to_string())
}

/// The signature blob (algorithm name and signature) over `data`. RSA follows the request's flags, SHA-2 only.
pub fn sign(key: &PrivateKey, data: &[u8], flags: u32) -> Result<Vec<u8>, String> {
    if let KeypairData::Rsa(pair) = key.key_data() {
        let private = rsa_private(pair)?;
        let (name, signature) = if flags & RSA_SHA2_512 != 0 {
            ("rsa-sha2-512", SigningKey::<sha2::Sha512>::new(private).try_sign(data).map_err(|e| e.to_string())?.to_vec())
        } else if flags & RSA_SHA2_256 != 0 {
            ("rsa-sha2-256", SigningKey::<sha2::Sha256>::new(private).try_sign(data).map_err(|e| e.to_string())?.to_vec())
        } else {
            return Err("ssh-rsa with SHA-1 is not signed; the client must ask for rsa-sha2-256 or -512".to_owned());
        };
        let mut out = Vec::new();
        put_string(&mut out, name.as_bytes());
        put_string(&mut out, &signature);
        return Ok(out);
    }
    let signature: ssh_key::Signature = rsa::signature::Signer::try_sign(key, data).map_err(|e| e.to_string())?;
    encoded(&signature)
}
