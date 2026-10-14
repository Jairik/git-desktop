//! The JSON-RPC envelope and the method dispatch table.
//!
//! Every request arrives at `POST /rpc` as `{ id, method, params }` and is
//! answered with `{ id, ok, result }` or `{ id, ok, error }`. Adding a method
//! means adding a match arm below — the rest of the plumbing is shared.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::handlers;
use crate::state::AppState;

/// The name of the daemon reported by `/info`.
pub const SERVER_NAME: &str = "gitdaemon";

/// The version of the daemon.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// A decoded `POST /rpc` request body.
#[derive(Debug, Clone)]
pub struct RpcRequest {
    /// The request id, echoed back in the response.
    pub id: Value,
    /// The method name.
    pub method: String,
    /// The method parameters.
    pub params: Value,
}

impl RpcRequest {
    /// Decodes a request body, tolerating a missing `params` object.
    pub fn parse(body: &[u8]) -> Result<RpcRequest, ApiError> {
        let value: Value = serde_json::from_slice(body)
            .map_err(|error| ApiError::bad_request(format!("invalid JSON body: {error}")))?;

        let object = value
            .as_object()
            .ok_or_else(|| ApiError::bad_request("request body must be an object"))?;

        let method = object
            .get("method")
            .and_then(Value::as_str)
            .map(|method| method.to_string())
            .ok_or_else(|| ApiError::bad_request("request is missing a string 'method'"))?;

        Ok(RpcRequest {
            id: object.get("id").cloned().unwrap_or(Value::Null),
            method,
            params: object.get("params").cloned().unwrap_or(Value::Null),
        })
    }
}

/// A success response envelope.
pub fn success_response(id: Value, result: Value) -> Value {
    json!({
        "id": id,
        "ok": true,
        "result": result,
    })
}

/// A failure response envelope.
pub fn error_response(id: Value, error: &ApiError) -> Value {
    json!({
        "id": id,
        "ok": false,
        "error": error.to_json(),
    })
}

/// Dispatches a request to its handler.
///
/// The handler runs inside a spawned task so that a panic is turned into an
/// error envelope instead of tearing down the connection.
pub async fn dispatch(state: Arc<AppState>, method: &str, params: Value) -> Result<Value, ApiError> {
    let task_state = Arc::clone(&state);
    let task_method = method.to_string();

    let result = tokio::spawn(async move { dispatch_inner(&task_state, &task_method, params).await }).await;

    match result {
        Ok(result) => result,
        Err(error) if error.is_panic() => {
            crate::log::error("RPC handler panicked");
            let message = error.to_string();

            Err(ApiError::internal(format!("handler panicked: {message}")))
        }
        Err(error) => Err(ApiError::internal(format!("handler task failed: {error}"))),
    }
}

/// The dispatch table: method name → handler.
async fn dispatch_inner(state: &AppState, method: &str, params: Value) -> Result<Value, ApiError> {
    match method {
        // Repository
        "repo.list" => handlers::repository::repo_list(state, params).await,
        "repo.open" => handlers::repository::repo_open(state, params).await,
        "repo.close" => handlers::repository::repo_close(state, params).await,
        "repo.type" => handlers::repository::repo_type(state, params).await,
        "repo.setAlias" => handlers::repository::repo_set_alias(state, params).await,
        "repo.init" => handlers::repository::repo_init(state, params).await,

        // Status / staging
        "status.get" => handlers::status::status_get(state, params).await,
        "status.stage" => handlers::status::status_stage(state, params).await,
        "status.unstage" => handlers::status::status_unstage(state, params).await,
        "status.unstageAll" => handlers::status::status_unstage_all(state, params).await,
        "status.discard" => handlers::status::status_discard(state, params).await,

        // Diffs
        "diff.workingDirectory" => handlers::diff::diff_working_directory(state, params).await,
        "diff.commit" => handlers::diff::diff_commit(state, params).await,
        "diff.stash" => handlers::diff::diff_stash(state, params).await,
        "image.workingDirectory" => handlers::diff::image_working_directory(state, params).await,

        // Commits / history
        "commit.create" => handlers::log::commit_create(state, params).await,
        "log.list" => handlers::log::log_list(state, params).await,
        "log.oneLine" => handlers::log::log_one_line(state, params).await,
        "log.commit" => handlers::log::log_commit(state, params).await,
        "log.changedFiles" => handlers::log::log_changed_files(state, params).await,
        "commit.undo" => handlers::log::commit_undo(state, params).await,
        "commit.resetTo" => handlers::log::commit_reset_to(state, params).await,

        // Branches
        "branch.list" => handlers::branch::branch_list(state, params).await,
        "branch.create" => handlers::branch::branch_create(state, params).await,
        "branch.rename" => handlers::branch::branch_rename(state, params).await,
        "branch.delete" => handlers::branch::branch_delete(state, params).await,
        "branch.checkout" => handlers::branch::branch_checkout(state, params).await,
        "commit.checkout" => handlers::branch::commit_checkout(state, params).await,
        "branch.aheadBehind" => handlers::branch::branch_ahead_behind(state, params).await,

        // Remotes
        "remote.list" => handlers::remote::remote_list(state, params).await,
        "remote.add" => handlers::remote::remote_add(state, params).await,
        "remote.remove" => handlers::remote::remote_remove(state, params).await,
        "remote.setUrl" => handlers::remote::remote_set_url(state, params).await,

        // Tags
        "tag.list" => handlers::tag::tag_list(state, params).await,
        "tag.create" => handlers::tag::tag_create(state, params).await,
        "tag.delete" => handlers::tag::tag_delete(state, params).await,

        // Stash
        "stash.list" => handlers::stash::stash_list(state, params).await,
        "stash.create" => handlers::stash::stash_create(state, params).await,
        "stash.pop" => handlers::stash::stash_pop(state, params).await,
        "stash.drop" => handlers::stash::stash_drop(state, params).await,

        // Config / identity
        "config.getValue" => handlers::config::config_get_value(state, params).await,
        "config.setValue" => handlers::config::config_set_value(state, params).await,
        "config.author" => handlers::config::config_author(state, params).await,

        // Network
        "fetch" => handlers::network::fetch(state, params).await,
        "pull" => handlers::network::pull(state, params).await,
        "push" => handlers::network::push(state, params).await,
        "clone" => handlers::network::clone(state, params).await,

        // GitHub (thin over the `gh` CLI)
        "github.status" => handlers::github::github_status(state, params).await,
        "github.remote" => handlers::github::github_remote(state, params).await,
        "pr.list" => handlers::github::pr_list(state, params).await,
        "pr.view" => handlers::github::pr_view(state, params).await,
        "pr.checkout" => handlers::github::pr_checkout(state, params).await,
        "ci.status" => handlers::github::ci_status(state, params).await,

        _ => Err(ApiError::bad_request(format!("unknown method: {method}"))),
    }
}

/// Decodes the `params` object of a request into a typed payload.
pub(crate) fn params_of<T: DeserializeOwned>(params: Value) -> Result<T, ApiError> {
    serde_json::from_value(params)
        .map_err(|error| ApiError::bad_request(format!("invalid params: {error}")))
}
