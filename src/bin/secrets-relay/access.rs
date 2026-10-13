//! What this Claude session lets its agent have of each vault entry: ask (a card), allowed (no card) or refused (no
//! card, no value). The vault holds no grants; each session's live in `sessions/<session-id>.json` beside it, so a
//! resumed session finds them again. Kept across lock and unlock: a closed vault gives nothing anyway.

use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Grant {
    Ask,
    Allowed,
    Refused,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    allowed: Vec<String>,
    refused: Vec<String>,
}

#[derive(Default)]
pub struct Access {
    /// The session's file; none until the hooks name the session, and then changes stay in memory.
    file: Option<PathBuf>,
    grants: HashMap<String, Grant>,
}

/// A Claude Code session id as a file name: letters, digits, `-` and `_`.
fn is_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Access {
    pub fn of(&self, id: &str) -> Grant {
        self.grants.get(id).copied().unwrap_or(Grant::Ask)
    }

    /// Takes in the grants `sessions/<session>.json` holds under `dir`, none when there is no file yet.
    pub fn load(dir: &Path, session: &str) -> Result<Self, String> {
        if !is_session_id(session) {
            return Err(format!("{session:?} is not a session id"));
        }
        let file = dir.join(format!("{session}.json"));
        let stored: Stored = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", file.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(error) => return Err(format!("{}: {error}", file.display())),
        };
        let allowed = stored.allowed.into_iter().map(|id| (id, Grant::Allowed));
        let grants = allowed.chain(stored.refused.into_iter().map(|id| (id, Grant::Refused))).collect();
        Ok(Self { file: Some(file), grants })
    }

    /// Sets the entry's grant; true when it changed. Saved at once when the session is named.
    pub fn set(&mut self, id: &str, grant: Grant) -> Result<bool, String> {
        let before = self.of(id);
        if before == grant {
            return Ok(false);
        }
        if grant == Grant::Ask { self.grants.remove(id) } else { self.grants.insert(id.to_owned(), grant) };
        if let Err(error) = self.save() {
            if before == Grant::Ask { self.grants.remove(id) } else { self.grants.insert(id.to_owned(), before) };
            return Err(error);
        }
        Ok(true)
    }

    /// Forgets the grants of entries no longer in the vault.
    pub fn keep_only(&mut self, live: &HashSet<&str>) -> Result<(), String> {
        let before = self.grants.len();
        self.grants.retain(|id, _| live.contains(id.as_str()));
        if self.grants.len() == before { Ok(()) } else { self.save() }
    }

    fn save(&self) -> Result<(), String> {
        let Some(file) = &self.file else { return Ok(()) };
        let listed = |grant: Grant| {
            let mut ids: Vec<String> = self.grants.iter().filter(|(_, g)| **g == grant).map(|(id, _)| id.clone()).collect();
            ids.sort();
            ids
        };
        let stored = Stored { allowed: listed(Grant::Allowed), refused: listed(Grant::Refused) };
        let text = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
        let failed = |e: std::io::Error| format!("can't save {}: {e}", file.display());
        if let Some(dir) = file.parent() {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(failed)?;
        }
        let temporary = file.with_extension("json.new");
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)
            .and_then(|mut f| f.write_all(&text).and_then(|()| f.sync_all()))
            .and_then(|()| std::fs::rename(&temporary, file));
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(failed(error));
        }
        Ok(())
    }
}

/// Removes the files under `dir` of sessions other than `own` with no transcript left in `projects` (Claude Code's
/// `<projects>/<project>/<session-id>.jsonl`): no resume can bring them back. The names removed.
pub fn sweep(dir: &Path, projects: &Path, own: &str) -> Result<Vec<String>, String> {
    let listed = |path: &Path| std::fs::read_dir(path).map_err(|e| format!("can't list {}: {e}", path.display()));
    let mut resumable = HashSet::new();
    for project in listed(projects)? {
        let project = project.map_err(|e| e.to_string())?;
        if !project.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        for file in listed(&project.path())? {
            let name = file.map_err(|e| e.to_string())?.file_name();
            if let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".jsonl")) {
                resumable.insert(id.to_owned());
            }
        }
    }
    let mut removed = Vec::new();
    let files = match std::fs::read_dir(dir) {
        Ok(files) => files,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(removed),
        Err(error) => return Err(format!("can't list {}: {error}", dir.display())),
    };
    for file in files {
        let path = file.map_err(|e| e.to_string())?.path();
        let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")) else { continue };
        if id == own || resumable.contains(id) {
            continue;
        }
        std::fs::remove_file(&path).map_err(|e| format!("can't remove {}: {e}", path.display()))?;
        removed.push(id.to_owned());
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("secrets-access-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_sessions_grants_come_back_and_stay_its_own() {
        let dir = temp("load");
        let mut first = Access::load(&dir, "s-1").unwrap();
        assert_eq!(first.of("e1"), Grant::Ask);
        assert!(first.set("e1", Grant::Allowed).unwrap());
        assert!(first.set("e2", Grant::Refused).unwrap());
        assert!(!first.set("e2", Grant::Refused).unwrap());
        let mode = std::fs::metadata(dir.join("s-1.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let again = Access::load(&dir, "s-1").unwrap();
        assert_eq!((again.of("e1"), again.of("e2"), again.of("e3")), (Grant::Allowed, Grant::Refused, Grant::Ask));
        assert_eq!(Access::load(&dir, "s-2").unwrap().of("e1"), Grant::Ask);
        first.keep_only(&HashSet::from(["e2"])).unwrap();
        assert_eq!(Access::load(&dir, "s-1").unwrap().of("e1"), Grant::Ask);
        assert!(Access::load(&dir, "../vault").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_sweep_keeps_resumable_sessions_and_its_own() {
        let dir = temp("sweep");
        let projects = dir.join("projects");
        std::fs::create_dir_all(projects.join("-home-x")).unwrap();
        std::fs::write(projects.join("-home-x").join("kept.jsonl"), "").unwrap();
        let sessions = dir.join("sessions");
        for id in ["kept", "gone", "own"] {
            Access::load(&sessions, id).unwrap().set("e", Grant::Allowed).unwrap();
        }
        assert_eq!(sweep(&sessions, &projects, "own").unwrap(), vec!["gone".to_owned()]);
        let mut left: Vec<_> = std::fs::read_dir(&sessions).unwrap().map(|f| f.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["kept.json", "own.json"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
