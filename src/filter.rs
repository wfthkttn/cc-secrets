//! The `/filter` stream between `secrets-mask-run` and the relay. After the HTTP head, mask-run sends one request
//! frame per piece of the command's output: kind, stream, a big-endian u32 length, the bytes. The relay answers each
//! with one reply frame: whether it still holds a tail of that stream back, a u32 length, the bytes to write now.

pub const DATA: u8 = 0;
/// No output came for a while: let out all but a tail that could still become a value.
pub const IDLE: u8 = 1;
/// The stream ended: everything held goes out.
pub const END: u8 = 2;

pub const STDOUT: u8 = 0;
pub const STDERR: u8 = 1;

/// The longest request body the relay reads; mask-run sends at most its read size.
pub const BODY_MAX: usize = 1 << 20;

pub fn request(kind: u8, stream: u8, body: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(body.len() + 6);
    frame.push(kind);
    frame.push(stream);
    frame.extend_from_slice(&u32::try_from(body.len()).unwrap_or(u32::MAX).to_be_bytes());
    frame.extend_from_slice(body);
    frame
}

pub fn reply(holding: bool, body: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(body.len() + 5);
    frame.push(u8::from(holding));
    frame.extend_from_slice(&u32::try_from(body.len()).unwrap_or(u32::MAX).to_be_bytes());
    frame.extend_from_slice(body);
    frame
}
