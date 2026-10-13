//! Error handling for the daemon.
//!
//! All fallible server-side operations funnel into [`ApiError`], which knows how
//! to render itself into the contract's error envelope. See
//! `docs/architecture/server-client.md` for the list of error codes.

use serde_json::{json, Value};

/// Error codes understood by the client (see the server-client contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// Malformed request or unknown method.
    BadRequest,
    /// A repository, ref, or other named entity could not be found.
    NotFound,
    /// An operation cannot proceed because of the current state.
    Conflict,
    /// A `git` invocation failed.
    GitError,
    /// Local filesystem or I/O failure.
    IoError,
    /// Unexpected server-side failure.
    Internal,
}

impl ErrorCode {
    /// The wire representation of the code.
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Conflict => "conflict",
            ErrorCode::GitError => "git_error",
            ErrorCode::IoError => "io_error",
            ErrorCode::Internal => "internal_error",
        }
    }
}

/// Every failure the daemon can report to the client.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// Malformed request payload or unknown method.
    #[error("{message}")]
    BadRequest { message: String },

    /// Requested entity (repository, ref, tag, stash...) does not exist.
    #[error("{message}")]
    NotFound { message: String },

    /// The repository state prevents the operation (for example an active
    /// merge).
    #[error("{message}")]
    Conflict { message: String },

    /// A git command exited with a non-success code.
    #[error("git command failed: {stderr}")]
    GitError {
        /// Git's stderr, trimmed.
        stderr: String,
        /// The argv (without the leading `git -C <path>`) used for the call.
        args: Vec<String>,
        /// The exit code git reported.
        code: i32,
    },

    /// Local I/O failure.
    #[error("{message}")]
    IoError { message: String },

    /// Unexpected failure; used for bugs and thread pool panics.
    #[error("{message}")]
    Internal { message: String },
}

impl ApiError {
    /// Builds a `bad_request` error.
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::BadRequest {
            message: message.into(),
        }
    }

    /// Builds a `not_found` error.
    pub fn not_found(message: impl Into<String>) -> Self {
        ApiError::NotFound {
            message: message.into(),
        }
    }

    /// Builds an `internal_error` result.
    pub fn internal(message: impl Into<String>) -> Self {
        ApiError::Internal {
            message: message.into(),
        }
    }

    /// The error code used on the wire.
    pub fn code(&self) -> ErrorCode {
        match self {
            ApiError::BadRequest { .. } => ErrorCode::BadRequest,
            ApiError::NotFound { .. } => ErrorCode::NotFound,
            ApiError::Conflict { .. } => ErrorCode::Conflict,
            ApiError::GitError { .. } => ErrorCode::GitError,
            ApiError::IoError { .. } => ErrorCode::IoError,
            ApiError::Internal { .. } => ErrorCode::Internal,
        }
    }

    /// Human readable message; for git errors this is git's stderr.
    pub fn message(&self) -> String {
        match self {
            ApiError::GitError { stderr, .. } => {
                let trimmed = stderr.trim();
                if trimmed.is_empty() {
                    "git command failed".to_string()
                } else {
                    trimmed.to_string()
                }
            }
            other => other.to_string(),
        }
    }

    /// Optional structured payload attached to the error.
    pub fn data(&self) -> Option<Value> {
        match self {
            ApiError::GitError {
                stderr, args, ..
            } => Some(json!({
                "stderr": stderr,
                "args": args,
            })),
            _ => None,
        }
    }

    /// Renders the `{ code, message, data? }` object from the contract.
    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "code": self.code().as_str(),
            "message": self.message(),
        });

        if let Some(data) = self.data() {
            value
                .as_object_mut()
                .expect("error object just created")
                .insert("data".to_string(), data);
        }

        value
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        ApiError::IoError {
            message: error.to_string(),
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        ApiError::Internal {
            message: format!("failed to serialize result: {error}"),
        }
    }
}
