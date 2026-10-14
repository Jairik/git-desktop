//! Shared application state.
//!
//! [`AppState`] holds everything the handlers need: the git runner, the
//! repository store and the event bus used to broadcast progress to the
//! connected WebSocket clients.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::git::GitRunner;
use crate::github::GhRunner;
use crate::store::RepositoryStore;

/// The number of progress events buffered for slow WebSocket clients.
const EVENT_BUFFER: usize = 512;

/// Broadcasts server→client events to every connected WebSocket.
#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<String>,
}

impl EventBus {
    /// Creates a new bus.
    pub fn new() -> Self {
        let (sender, _receiver) = broadcast::channel(EVENT_BUFFER);

        EventBus { sender }
    }

    /// Broadcasts a `{ "event": <name>, "data": <payload> }` frame.
    pub fn emit(&self, event: &str, data: Value) {
        let frame = json!({
            "event": event,
            "data": data,
        })
        .to_string();

        // A slow or disconnected client dropping a frame is not an error.
        let _ = self.sender.send(frame);
    }

    /// Subscribes to the bus; used by the WebSocket handler.
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.sender.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        EventBus::new()
    }
}

/// Everything the request handlers share.
pub struct AppState {
    /// Runs the git commands.
    pub runner: GitRunner,
    /// Runs the gh (GitHub CLI) commands.
    pub gh: GhRunner,
    /// The repository store, guarded by a blocking mutex (all users are short).
    pub store: Mutex<RepositoryStore>,
    /// The directory the store is persisted to.
    pub data_dir: PathBuf,
    /// The WebSocket event bus.
    pub events: EventBus,
    /// The port the daemon is listening on.
    pub port: u16,
    /// The daemon name reported by `/info`.
    pub name: String,
    /// The daemon version reported by `/health` and `/info`.
    pub version: String,
}

impl AppState {
    /// Builds the state, loading the store from `data_dir`.
    pub fn new(data_dir: PathBuf, port: u16, name: String, version: String) -> Self {
        let store = RepositoryStore::load(&data_dir);

        AppState {
            runner: GitRunner,
            gh: GhRunner,
            store: Mutex::new(store),
            data_dir,
            events: EventBus::new(),
            port,
            name,
            version,
        }
    }

    /// Persists the store to disk after a mutation.
    pub fn persist(&self) {
        let store = self.lock_store();

        store.save(&self.data_dir);
    }

    /// Locks the store, recovering from a poisoned mutex.
    pub fn lock_store(&self) -> std::sync::MutexGuard<'_, RepositoryStore> {
        match self.store.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}
