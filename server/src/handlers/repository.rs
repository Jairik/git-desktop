//! Repository handlers: `repo.list`, `repo.open`, `repo.close`, `repo.type`,
//! `repo.setAlias` and `repo.init`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::models::{Repository, RepositoryType};
use crate::rpc::params_of;
use crate::state::AppState;
use crate::store;

/// Parameters for `repo.open`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenParams {
    /// The absolute path of the repository.
    pub path: String,
    /// An optional user supplied label.
    #[serde(default)]
    pub alias: Option<String>,
}

/// Parameters for `repo.close`, `repo.type` and `repo.init`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// Parameters for `repo.setAlias`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAliasParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The new alias, or null to clear it.
    pub alias: Option<String>,
}

/// `repo.list` — every repository in the store, newest last.
pub async fn repo_list(state: &AppState, _params: Value) -> Result<Value, ApiError> {
    let store = state.lock_store();

    let repositories: Vec<Repository> = store
        .entries()
        .iter()
        .map(store::to_repository)
        .collect();

    Ok(json!(repositories))
}

/// `repo.open` — validate a path as a repository and register it in the store.
pub async fn repo_open(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: OpenParams = params_of(params)?;

    let repository_type = git::repository::repository_type(&state.runner, &params.path).await?;

    if !matches!(
        repository_type,
        RepositoryType::Regular { .. } | RepositoryType::Bare { .. }
    ) {
        return Err(ApiError::not_found(format!(
            "no git repository at {}",
            params.path
        )));
    }

    let entry = state
        .lock_store()
        .upsert(&params.path, params.alias.as_deref());

    state.persist();

    Ok(json!(store::to_repository(&entry)))
}

/// `repo.close` — remove a repository from the store.
pub async fn repo_close(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PathParams = params_of(params)?;

    let removed = state.lock_store().remove(&params.path);

    if removed.is_none() {
        return Err(ApiError::not_found(format!(
            "repository not found in store: {}",
            params.path
        )));
    }

    state.persist();

    Ok(json!({}))
}

/// `repo.type` — the kind of repository found at the path.
pub async fn repo_type(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PathParams = params_of(params)?;

    let repository_type = git::repository::repository_type(&state.runner, &params.path).await?;

    Ok(json!(repository_type))
}

/// `repo.setAlias` — set (or clear) the alias of a repository.
pub async fn repo_set_alias(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: SetAliasParams = params_of(params)?;

    // Only repositories the client has opened can be renamed; an unknown path
    // is a `not_found` rather than a silent registration.
    let entry = state
        .lock_store()
        .set_alias(&params.path, params.alias.as_deref());

    let entry = entry.ok_or_else(|| {
        ApiError::not_found(format!("repository not found in store: {}", params.path))
    })?;

    state.persist();

    Ok(json!(store::to_repository(&entry)))
}

/// `repo.init` — create a new repository at the given path.
pub async fn repo_init(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: PathParams = params_of(params)?;

    git::repository::init_repository(&state.runner, &params.path).await?;

    let entry = state.lock_store().upsert(&params.path, None);

    state.persist();

    Ok(json!(store::to_repository(&entry)))
}
