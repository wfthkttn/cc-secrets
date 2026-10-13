//! The vault file: entries encrypted under a key derived from the passphrase (Argon2id, XChaCha20-Poly1305).
//!
//! Layout: `MAGIC`, the Argon2 memory, time and lane costs (u32 LE each), a 16-byte salt, a 24-byte nonce, then
//! the sealed JSON list of entries. Everything before the sealed part is its associated data, so a changed cost
//! or salt fails to open like a wrong passphrase does.

use std::io::{Read as _, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::Path;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead as _, KeyInit as _, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize as _, Zeroizing};

const MAGIC: &[u8] = b"secrets-vault\x01";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = MAGIC.len() + 12 + SALT_LEN;

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    /// The passphrase is wrong, or the file was changed.
    Refused,
    /// Not a vault file, or one this version can't read.
    Unreadable(&'static str),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Refused => f.write_str("wrong passphrase, or the vault file was changed"),
            Self::Unreadable(why) => write!(f, "not a vault file this version can read: {why}"),
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Password,
    Token,
    SshKey,
    /// Written by earlier versions for every typed answer; the relay drops these entries when the vault opens.
    Typed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Use {
    /// Once allowed in a session, handed out there without asking again.
    Session,
    /// Asked for on every use.
    Each,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub kind: Kind,
    #[serde(rename = "use")]
    pub use_: Use,
    pub value: String,
    /// Seconds since the Unix epoch.
    pub created: u64,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Costs {
    pub memory_kib: u32,
    pub time: u32,
    pub lanes: u32,
}

/// An open vault: the derived key stays, so saving needs no passphrase.
pub struct Vault {
    costs: Costs,
    salt: [u8; SALT_LEN],
    key: Zeroizing<[u8; 32]>,
    pub entries: Vec<Entry>,
}

pub fn random_bytes<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

pub fn random_hex<const N: usize>() -> std::io::Result<String> {
    Ok(random_bytes::<N>()?.iter().fold(String::new(), |mut hex, b| {
        let _ = std::fmt::Write::write_fmt(&mut hex, format_args!("{b:02x}"));
        hex
    }))
}

fn derive(passphrase: &[u8], salt: &[u8], costs: Costs) -> Result<Zeroizing<[u8; 32]>, Error> {
    let params = Params::new(costs.memory_kib, costs.time, costs.lanes, Some(32)).map_err(|_| Error::Unreadable("Argon2 costs out of range"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase, salt, key.as_mut())
        .map_err(|_| Error::Unreadable("Argon2 refused the salt or passphrase"))?;
    Ok(key)
}

fn header(costs: Costs, salt: &[u8; SALT_LEN]) -> Vec<u8> {
    let mut out = MAGIC.to_vec();
    for cost in [costs.memory_kib, costs.time, costs.lanes] {
        out.extend_from_slice(&cost.to_le_bytes());
    }
    out.extend_from_slice(salt);
    out
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

impl Vault {
    /// A new, empty vault; nothing is written until `save`.
    pub fn create(passphrase: &[u8], costs: Costs) -> Result<Self, Error> {
        let salt = random_bytes::<SALT_LEN>()?;
        let key = derive(passphrase, &salt, costs)?;
        Ok(Self { costs, salt, key, entries: Vec::new() })
    }

    pub fn open(path: &Path, passphrase: &[u8]) -> Result<Self, Error> {
        let data = std::fs::read(path)?;
        if !data.starts_with(MAGIC) {
            return Err(Error::Unreadable("no vault header"));
        }
        let costs = (|| {
            Some(Costs { memory_kib: u32_at(&data, MAGIC.len())?, time: u32_at(&data, MAGIC.len() + 4)?, lanes: u32_at(&data, MAGIC.len() + 8)? })
        })()
        .ok_or(Error::Unreadable("header cut short"))?;
        let salt: [u8; SALT_LEN] = data.get(MAGIC.len() + 12..HEADER_LEN).and_then(|s| s.try_into().ok()).ok_or(Error::Unreadable("header cut short"))?;
        let nonce = data.get(HEADER_LEN..HEADER_LEN + NONCE_LEN).and_then(|n| XNonce::try_from(n).ok()).ok_or(Error::Unreadable("header cut short"))?;
        let sealed = data.get(HEADER_LEN + NONCE_LEN..).ok_or(Error::Unreadable("header cut short"))?;
        let key = derive(passphrase, &salt, costs)?;
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| Error::Unreadable("key length"))?;
        let aad = data.get(..HEADER_LEN).ok_or(Error::Unreadable("header cut short"))?;
        let plain = Zeroizing::new(cipher.decrypt(&nonce, Payload { msg: sealed, aad }).map_err(|_| Error::Refused)?);
        let entries = serde_json::from_slice(&plain).map_err(|_| Error::Unreadable("entries"))?;
        Ok(Self { costs, salt, key, entries })
    }

    /// Writes the vault under a fresh nonce: a 0600 temporary file beside `path`, synced, then renamed over it.
    pub fn save(&self, path: &Path) -> Result<(), Error> {
        let aad = header(self.costs, &self.salt);
        let nonce = random_bytes::<NONCE_LEN>()?;
        let cipher = XChaCha20Poly1305::new_from_slice(self.key.as_ref()).map_err(|_| Error::Unreadable("key length"))?;
        let plain = Zeroizing::new(serde_json::to_vec(&self.entries).map_err(|_| Error::Unreadable("entries"))?);
        let sealed = cipher.encrypt(&XNonce::from(nonce), Payload { msg: &plain, aad: &aad }).map_err(|_| Error::Unreadable("sealing failed"))?;
        if let Some(dir) = path.parent() {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        }
        let temporary = path.with_extension(format!("new-{}", random_hex::<4>()?));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary)?;
        let written = file.write_all(&aad).and_then(|()| file.write_all(&nonce)).and_then(|()| file.write_all(&sealed)).and_then(|()| file.sync_all());
        if let Err(error) = written.and_then(|()| std::fs::rename(&temporary, path)) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    const CHEAP: Costs = Costs { memory_kib: 64, time: 1, lanes: 1 };

    fn entry(tag: &str, value: &str) -> Entry {
        Entry { id: tag.to_owned(), name: format!("name of {tag}"), tag: tag.to_owned(), kind: Kind::Password, use_: Use::Session, value: value.to_owned(), created: 1 }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("secrets-vault-test-{name}-{}", std::process::id())).join("vault")
    }

    #[test]
    fn saved_entries_come_back_with_the_passphrase_and_not_without() {
        let path = scratch("roundtrip");
        let mut vault = Vault::create(b"correct horse", CHEAP).unwrap();
        vault.entries.push(entry("db", "hunter22"));
        vault.save(&path).unwrap();
        let raw = std::fs::read(&path).unwrap();
        assert!(memchr::memmem::find(&raw, b"hunter22").is_none());
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let opened = Vault::open(&path, b"correct horse").unwrap();
        assert_eq!(opened.entries, vault.entries);
        assert!(matches!(Vault::open(&path, b"wrong horse"), Err(Error::Refused)));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_changed_cost_or_byte_refuses_to_open() {
        let path = scratch("tamper");
        let mut vault = Vault::create(b"pass", CHEAP).unwrap();
        vault.entries.push(entry("api", "tok-123456"));
        vault.save(&path).unwrap();
        let good = std::fs::read(&path).unwrap();
        let mut cost = good.clone();
        cost[MAGIC.len() + 4] = 2;
        std::fs::write(&path, &cost).unwrap();
        assert!(matches!(Vault::open(&path, b"pass"), Err(Error::Refused)));
        let mut body = good.clone();
        let last = body.len() - 1;
        body[last] ^= 1;
        std::fs::write(&path, &body).unwrap();
        assert!(matches!(Vault::open(&path, b"pass"), Err(Error::Refused)));
        std::fs::write(&path, b"plain text").unwrap();
        assert!(matches!(Vault::open(&path, b"pass"), Err(Error::Unreadable(_))));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn saving_again_keeps_the_passphrase_and_changes_the_nonce() {
        let path = scratch("resave");
        let mut vault = Vault::create(b"pass", CHEAP).unwrap();
        vault.save(&path).unwrap();
        let first = std::fs::read(&path).unwrap();
        vault.entries.push(entry("ssh", "-----BEGIN OPENSSH PRIVATE KEY-----"));
        vault.save(&path).unwrap();
        let second = std::fs::read(&path).unwrap();
        assert_ne!(first[HEADER_LEN..HEADER_LEN + NONCE_LEN], second[HEADER_LEN..HEADER_LEN + NONCE_LEN]);
        assert_eq!(Vault::open(&path, b"pass").unwrap().entries.len(), 1);
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
