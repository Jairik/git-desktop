//! Config handlers: `config.getValue`, `config.setValue` and `config.author`.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::git;
use crate::rpc::params_of;
use crate::state::AppState;

/// Parameters for `config.getValue`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigGetParams {
    /// The repository to read from; omitted for the global config.
    #[serde(default)]
    pub path: Option<String>,
    /// The name of the config value, e.g. `user.name`.
    pub name: String,
    /// Whether to only read the repository's own config.
    #[serde(default)]
    pub only_local: bool,
}

/// Parameters for `config.setValue`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSetParams {
    /// The repository to write to; omitted for the global config.
    #[serde(default)]
    pub path: Option<String>,
    /// The name of the config value.
    pub name: String,
    /// The value to write.
    pub value: String,
    /// Whether to only write the repository's own config.
    #[serde(default)]
    pub only_local: bool,
}

/// Parameters for `config.author`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorParams {
    /// The absolute path of the repository.
    pub path: String,
}

/// `config.getValue` — read a config value, or null when unset.
pub async fn config_get_value(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ConfigGetParams = params_of(params)?;

    let value = git::config::get_config_value(
        &state.runner,
        params.path.as_deref(),
        &params.name,
        params.only_local,
    )
    .await?;

    Ok(json!(value))
}

/// `config.setValue` — write a config value.
pub async fn config_set_value(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: ConfigSetParams = params_of(params)?;

    git::config::set_config_value(
        &state.runner,
        params.path.as_deref(),
        &params.name,
        &params.value,
        params.only_local,
    )
    .await?;

    Ok(json!({}))
}

/// `config.author` — the author identity git would use for a commit.
pub async fn config_author(state: &AppState, params: Value) -> Result<Value, ApiError> {
    let params: AuthorParams = params_of(params)?;

    let author = git::config::get_author_identity(&state.runner, &params.path).await?;

    Ok(json!(author))
}
