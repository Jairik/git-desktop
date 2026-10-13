//! The in-memory repository store, persisted to `server/data/repositories.json`.
//!
//! The store is the daemon's only piece of durable state. It is a plain vector
//! of entries (newest last) that is written back to disk after every mutation.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file the store is persisted to, relative to the data directory.
const STORE_FILE: &str = "repositories.json";

/// A repository as stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredRepository {
    /// The canonical absolute path of the repository.
    pub id: String,
    /// The absolute path the repository was opened with.
    pub path: String,
    /// An optional user supplied label.
    #[serde(default)]
    pub alias: Option<String>,
    /// Whether the path existed the last time we looked.
    #[serde(default)]
    pub missing: bool,
}

/// The list of repositories the client knows about.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RepositoryStore {
    /// The entries, ordered oldest first (i.e. newest last).
    #[serde(default)]
    pub repositories: Vec<StoredRepository>,
}

impl RepositoryStore {
    /// Loads the store from disk, returning an empty store when it's absent or
    /// unreadable.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(STORE_FILE);

        match std::fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<RepositoryStore>(&contents) {
                Ok(mut store) => {
                    store.refresh_missing();
                    store
                }
                Err(error) => {
                    crate::log::warn("Failed to parse repositories.json, starting with an empty store")
                        .field("error", error.to_string());
                    RepositoryStore::default()
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => RepositoryStore::default(),
            Err(error) => {
                crate::log::warn("Failed to read repositories.json, starting with an empty store")
                    .field("error", error.to_string());
                RepositoryStore::default()
            }
        }
    }

    /// Persists the store to disk, best-effort.
    pub fn save(&self, data_dir: &Path) {
        if std::fs::create_dir_all(data_dir).is_err() {
            return;
        }

        let path = data_dir.join(STORE_FILE);

        match serde_json::to_string_pretty(self) {
            Ok(contents) => {
                if let Err(error) = std::fs::write(&path, contents) {
                    crate::log::warn("Failed to write repositories.json")
                        .field("path", path.display().to_string())
                        .field("error", error.to_string());
                }
            }
            Err(error) => {
                crate::log::error("Failed to serialize the repository store")
                    .field("error", error.to_string());
            }
        }
    }

    /// Registers (or updates) a repository, keeping the ordering stable.
    ///
    /// Returns the entry as it should be reported to the client.
    pub fn upsert(&mut self, path: &str, alias: Option<&str>) -> StoredRepository {
        let id = repository_id(path);

        if let Some(existing) = self.repositories.iter_mut().find(|entry| entry.id == id) {
            existing.path = path.to_string();
            existing.missing = !Path::new(path).exists();

            if alias.is_some() {
                existing.alias = alias.map(|value| value.to_string());
            }

            return existing.clone();
        }

        let entry = StoredRepository {
            id,
            path: path.to_string(),
            alias: alias.map(|value| value.to_string()),
            missing: !Path::new(path).exists(),
        };

        self.repositories.push(entry.clone());

        entry
    }

    /// Removes a repository from the store.
    pub fn remove(&mut self, path: &str) -> Option<StoredRepository> {
        let id = repository_id(path);
        let position = self.repositories.iter().position(|entry| entry.id == id)?;

        Some(self.repositories.remove(position))
    }

    /// Returns the stored entry for the given path.
    pub fn find(&self, path: &str) -> Option<&StoredRepository> {
        let id = repository_id(path);

        self.repositories.iter().find(|entry| entry.id == id)
    }

    /// All entries, oldest first (newest last).
    pub fn entries(&self) -> &[StoredRepository] {
        &self.repositories
    }

    /// Updates the alias of a repository.
    pub fn set_alias(&mut self, path: &str, alias: Option<&str>) -> Option<StoredRepository> {
        let id = repository_id(path);

        let entry = self
            .repositories
            .iter_mut()
            .find(|entry| entry.id == id)?;

        entry.alias = alias.map(|value| value.to_string());

        Some(entry.clone())
    }

    /// Recomputes the `missing` flag for every entry.
    fn refresh_missing(&mut self) {
        for entry in &mut self.repositories {
            entry.missing = !Path::new(&entry.path).exists();
        }
    }
}

/// Computes the stable id of a repository: its canonical absolute path.
pub fn repository_id(path: &str) -> String {
    canonicalize(path).unwrap_or_else(|| absolute(path))
}

/// Canonicalizes a path without requiring it to exist.
pub fn canonicalize(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

/// Makes a path absolute relative to the current working directory.
pub fn absolute(path: &str) -> String {
    let candidate = Path::new(path);

    if candidate.is_absolute() {
        return normalize(path);
    }

    match std::env::current_dir() {
        Ok(cwd) => normalize(&cwd.join(path).to_string_lossy()),
        Err(_) => path.to_string(),
    }
}

/// Removes `.` and `..` components and trailing separators from a path.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();

    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }

    let joined = parts.join("/");

    if path.starts_with('/') {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Returns the directory the daemon stores its data in.
///
/// This is `<cwd>/data` when the daemon runs from inside `server/` and
/// `<cwd>/server/data` otherwise, so it always lands in `server/data/`.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("GITDAEMON_DATA_DIR") {
        return PathBuf::from(dir);
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    if cwd.file_name().map(|name| name == "server").unwrap_or(false) {
        cwd.join("data")
    } else {
        cwd.join("server").join("data")
    }
}

/// Converts a store entry into a repository to report to the client.
pub fn to_repository(entry: &StoredRepository) -> crate::models::Repository {
    crate::models::Repository {
        id: entry.id.clone(),
        path: entry.path.clone(),
        alias: entry.alias.clone(),
        missing: entry.missing || !Path::new(&entry.path).exists(),
    }
}
