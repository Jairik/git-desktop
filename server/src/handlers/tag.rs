//! Tag handlers: `tag.list`, `tag.create` and `tag.delete`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `tag.list`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagListParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// Parameters for `tag.create`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCreateParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The name of the tag.
    pub name: String,
    /// The commit the tag should point at.
    pub target_commit_sha: String,
}

/// Parameters for `tag.delete`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDeleteParams {
    /// The absolute path of the repository.
    pub path: String,
    /// The name of the tag.
    pub name: String,
}

/// `tag.list` — a map of tag name to SHA.
pub async fn tag_list(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: TagListParams = params_of(params)?;

    let tags = git::tags::list_tags(&state.runner, &params.path).await?;

    Ok(json!(tags))
}

/// `tag.create` — create an annotated tag.
pub async fn tag_create(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: TagCreateParams = params_of(params)?;

    git::tags::create_tag(
        &state.runner,
        &params.path,
        &params.name,
        &params.target_commit_sha,
    )
    .await?;

    Ok(json!({}))
}

/// `tag.delete` — delete a tag.
pub async fn tag_delete(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: TagDeleteParams = params_of(params)?;

    git::tags::delete_tag(&state.runner, &params.path, &params.name).await?;

    Ok(json!({}))
}
