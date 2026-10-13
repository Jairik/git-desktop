//! Remote handlers: `remote.list`, `remote.add`, `remote.remove` and
//! `remote.setUrl`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `remote.list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// Parameters for `remote.add` and `remote.setUrl`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAddParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The name of the remote.
    pub name: String,
    /// The URL of the remote.
    pub url: String,
}

/// Parameters for `remote.remove`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRemoveParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The name of the remote.
    pub name: String,
}

/// `remote.list` — the remotes of a repository.
pub async fn remote_list(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: RemoteListParams = params_of(params)?;

    let remotes = git::remote::list_remotes(&state.runner, &params.path).await?;

    Ok(json!(remotes))
}

/// `remote.add` — add a remote.
pub async fn remote_add(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: RemoteAddParams = params_of(params)?;

    git::remote::add_remote(&state.runner, &params.path, &params.name, &params.url).await?;

    Ok(json!({}))
}

/// `remote.remove` — remove a remote.
pub async fn remote_remove(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: RemoteRemoveParams = params_of(params)?;

    git::remote::remove_remote(&state.runner, &params.path, &params.name).await?;

    Ok(json!({}))
}

/// `remote.setUrl` — change the URL of a remote.
pub async fn remote_set_url(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: RemoteAddParams = params_of(params)?;

    git::remote::set_url(&state.runner, &params.path, &params.name, &params.url).await?;

    Ok(json!({}))
}
