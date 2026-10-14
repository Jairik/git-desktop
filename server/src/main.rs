//! The daemon's entry point: builds the axum router and serves it.
//!
//! Routes:
//!
//! - `POST /rpc` — JSON-RPC style request/response (see [`crate::rpc`])
//! - `GET /ws`   — WebSocket push channel for progress events
//! - `GET /health` — `{ "ok": true, "version": "…" }`
//! - `GET /info`   — `{ "name": "…", "version": "…", "port": … }`
//!
//! On start the daemon creates its data directory, loads the repository store,
//! writes the discovery file `~/.gitdaemon/server.json` and binds
//! `127.0.0.1:$GITDAEMON_PORT` (default 4789).

mod agents;
mod error;
mod git;
mod github;
mod handlers;
mod log;
mod models;
mod rpc;
mod state;
mod store;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::http::request::Parts as RequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::rpc::{error_response, success_response, RpcRequest, SERVER_NAME, SERVER_VERSION};
use crate::state::AppState;

/// The default port, used when `GITDAEMON_PORT` is not set.
const DEFAULT_PORT: u16 = 4789;

#[tokio::main]
async fn main() {
    log::init();

    let port = port_from_env();

    let data_dir = store::data_dir();
    let state = Arc::new(AppState::new(
        data_dir.clone(),
        port,
        SERVER_NAME.to_string(),
        SERVER_VERSION.to_string(),
    ));

    write_discovery_file(port);

    // The API router always takes precedence over the static-SPA fallback, so
    // `/rpc`, `/ws`, `/health` and `/info` keep working whether or not a client
    // build is being served.
    let api = Router::new()
        .route("/rpc", post(rpc_handler))
        .route("/ws", get(ws_handler))
        .route("/health", get(health_handler))
        .route("/info", get(info_handler))
        .with_state(state.clone());

    let app = match serve_dir() {
        Some(dir) => {
            log::info("serving static SPA")
                .field("dir", dir.display().to_string());
            // Serve the built client as a single-page app: real files come from
            // ServeDir, and any unknown path falls back to index.html so the
            // client's own router can handle deep links.
            api.fallback_service(
                ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html"))),
            )
        }
        None => {
            log::info("API-only mode (set GITDAEMON_SERVE_DIR to serve a built client)");
            api
        }
    };

    let app = app.layer(cors_layer());

    let address = SocketAddr::from(([127, 0, 0, 1], port));

    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            log::error("Failed to bind to address")
                .field("address", address.to_string())
                .field("error", error.to_string());
            std::process::exit(1);
        }
    };

    log::info("gitdaemon listening")
        .field("url", format!("http://{address}"))
        .field("data_dir", data_dir.display().to_string());

    if let Err(error) = axum::serve(listener, app).await {
        log::error("Server error").field("error", error.to_string());
        std::process::exit(1);
    }
}

/// Reads the port from `GITDAEMON_PORT`, falling back to the default.
fn port_from_env() -> u16 {
    std::env::var("GITDAEMON_PORT")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// The directory to serve as a static SPA, from `GITDAEMON_SERVE_DIR`.
///
/// Returns `None` (API-only mode) when the variable is unset/empty or points at
/// a directory that does not exist — a missing build is not an error.
fn serve_dir() -> Option<PathBuf> {
    std::env::var_os("GITDAEMON_SERVE_DIR")
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty() && dir.is_dir())
}

/// A loopback-only CORS policy.
///
/// The daemon binds to 127.0.0.1 but is still reachable from any page the
/// user's browser loads, so only origins that can be served locally are
/// allowed: `null` (a `file://` page or a sandboxed iframe) plus
/// `http://localhost`, `http://127.0.0.1` and `http://[::1]` on any port. That
/// keeps the Vite dev server and the packaged client working while blocking
/// arbitrary websites.
fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::predicate(is_loopback_origin))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
}

/// Whether an `Origin` header can only have been produced by localhost.
fn is_loopback_origin(origin: &header::HeaderValue, _request: &RequestParts) -> bool {
    // A sandboxed iframe or a `file://` page sends the opaque `null` origin.
    let Ok(origin) = origin.to_str() else {
        return false;
    };

    let Some((_scheme, rest)) = origin.split_once("://") else {
        return origin == "null";
    };

    // Only plain http origins are allowed: https on a loopback address would
    // need a certificate we cannot provide.
    if !origin.starts_with("http://") {
        return false;
    }

    // Strip the port, remembering that an IPv6 host is bracketed.
    let host = match rest.rsplit_once(':') {
        Some((host, _port)) => host,
        None => rest,
    };

    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "[::1]"
    )
}

/// Whether an `Origin` header can only have been produced by an http loopback
/// page.
///
/// This is the stricter sibling of [`is_loopback_origin`] used for *execution*
/// guards: unlike the CORS predicate it rejects the opaque `null` origin (which
/// a sandboxed iframe on a hostile site can produce). The client is always
/// served over http loopback (daemon SPA, Vite dev server, or Electron), so
/// rejecting `null` breaks no supported path.
fn is_strict_loopback_origin(origin: &header::HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };

    // No scheme at all is the opaque `null` origin (or garbage) — reject it.
    let Some((_scheme, rest)) = origin.split_once("://") else {
        return false;
    };

    if !origin.starts_with("http://") {
        return false;
    }

    // Strip the port, remembering that an IPv6 host is bracketed.
    let host = match rest.rsplit_once(':') {
        Some((host, _port)) => host,
        None => rest,
    };

    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "[::1]"
    )
}

/// Rejects a request whose `Origin` header is present but names a non-loopback
/// (cross-site) origin.
///
/// CORS only filters *responses*; it does not stop a request from executing, so
/// a hostile page could still fire a CORS "simple request" (`text/plain`, no
/// preflight) at `/rpc` and have the daemon run it. This guard runs *before*
/// dispatch: a missing `Origin` (curl, non-browser callers, our e2e) is allowed,
/// and a present one must be an http loopback origin.
fn reject_cross_site_origin(headers: &HeaderMap) -> Option<Response> {
    let origin = headers.get(header::ORIGIN)?;

    if is_strict_loopback_origin(origin) {
        return None;
    }

    log::warn("rejected cross-site request")
        .field("origin", origin.to_str().unwrap_or("<invalid>").to_string());

    Some((StatusCode::FORBIDDEN, "Forbidden").into_response())
}

/// Writes `~/.gitdaemon/server.json` so the client can discover the daemon.
///
/// Best-effort: failing to write it is not fatal.
fn write_discovery_file(port: u16) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };

    let dir = std::path::Path::new(&home).join(".gitdaemon");

    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }

    let contents = json!({ "url": format!("http://127.0.0.1:{port}") }).to_string();

    if let Err(error) = std::fs::write(dir.join("server.json"), contents) {
        log::warn("Failed to write discovery file").field("error", error.to_string());
    }
}

/// `GET /health`.
async fn health_handler(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({
        "ok": true,
        "version": state.version,
    }))
    .into_response()
}

/// `GET /info`.
async fn info_handler(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({
        "name": state.name,
        "version": state.version,
        "port": state.port,
    }))
    .into_response()
}

/// `POST /rpc` — dispatches a single method call.
async fn rpc_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Some(forbidden) = reject_cross_site_origin(&headers) {
        return forbidden;
    }

    let request = match RpcRequest::parse(&body) {
        Ok(request) => request,
        Err(error) => return Json(error_response(Value::Null, &error)).into_response(),
    };

    log::info("rpc").field("method", request.method.clone());

    let result = rpc::dispatch(Arc::clone(&state), &request.method, request.params.clone()).await;

    let response = match result {
        Ok(result) => success_response(request.id.clone(), result),
        Err(error) => {
            let code = error.code().as_str().to_string();

            log::info("rpc failed")
                .field("method", request.method.clone())
                .field("code", code);

            error_response(request.id.clone(), &error)
        }
    };

    Json(response).into_response()
}

/// `GET /ws` — upgrades the connection and forwards progress events to it.
async fn ws_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    if let Some(forbidden) = reject_cross_site_origin(&headers) {
        return forbidden;
    }

    socket
        .on_upgrade(move |socket| handle_socket(socket, Arc::clone(&state)))
}

/// Bridges the event bus and a single WebSocket connection.
async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let mut events = state.events.subscribe();

    loop {
        tokio::select! {
            frame = events.recv() => {
                match frame {
                    Ok(frame) => {
                        if socket.send(Message::Text(frame)).await.is_err() {
                            // The client went away.
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        log::debug("ws client lagged behind")
                            .field("skipped", skipped);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    // The client closed the connection.
                    None | Some(Err(_)) => break,
                    Some(Ok(Message::Close(_))) => break,
                    _ => {}
                }
            }
        }
    }
}
