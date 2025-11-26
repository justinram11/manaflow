use crate::errors::{ErrorBody, SandboxError, SandboxResult};
use crate::models::{
    CreateSandboxRequest, ExecRequest, ExecResponse, HealthResponse, SandboxSummary,
};
use crate::service::{AppState, SandboxService};
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{DefaultBodyLimit, Path, Query};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{any, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;
use utoipa::OpenApi as UtoipaOpenApi;
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;

#[derive(Deserialize)]
struct ProxyParams {
    port: u16,
}

#[derive(Deserialize)]
struct OpenUrlParams {
    url: String,
}

#[derive(Deserialize)]
struct AttachParams {
    cols: Option<u16>,
    rows: Option<u16>,
    command: Option<String>,
    #[serde(default = "default_tty")]
    tty: bool,
}

fn default_tty() -> bool {
    true
}

#[derive(UtoipaOpenApi)]
#[openapi(
    paths(
        create_sandbox,
        list_sandboxes,
        get_sandbox,
        exec_sandbox,
        delete_sandbox,
        health,
        upload_files,
    ),
    components(schemas(
        CreateSandboxRequest,
        ExecRequest,
        ExecResponse,
        SandboxSummary,
        crate::models::SandboxNetwork,
        crate::models::SandboxStatus,
        HealthResponse,
        ErrorBody
    )),
    tags((name = "sandboxes", description = "Manage bubblewrap-based sandboxes"))
)]
pub struct ApiDoc;

pub fn build_router(
    service: Arc<dyn SandboxService>,
    url_broadcast: crate::service::UrlBroadcastSender,
) -> Router {
    let openapi = ApiDoc::openapi();
    let state = AppState::new(service, url_broadcast);
    let swagger_routes: Router<AppState> =
        SwaggerUi::new("/docs").url("/openapi.json", openapi).into();

    Router::new()
        .route("/healthz", get(health))
        .route("/sandboxes", get(list_sandboxes).post(create_sandbox))
        .route("/sandboxes/{id}", get(get_sandbox).delete(delete_sandbox))
        .route("/sandboxes/{id}/exec", post(exec_sandbox))
        .route(
            "/sandboxes/{id}/files",
            post(upload_files).layer(DefaultBodyLimit::disable()),
        )
        .route("/sandboxes/{id}/attach", any(attach_sandbox))
        .route("/sandboxes/{id}/proxy", any(proxy_sandbox))
        // Multiplexed WebSocket endpoint - single connection for all PTY sessions
        .route("/mux/attach", any(mux_attach))
        // Open URL on host - used by sandboxed processes to open links
        .route("/open-url", get(open_url))
        .merge(swagger_routes)
        .with_state(state)
}

#[utoipa::path(
    get,
    path = "/healthz",
    responses((status = 200, description = "Server is healthy", body = HealthResponse))
)]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
    })
}

#[utoipa::path(
    post,
    path = "/sandboxes",
    request_body = CreateSandboxRequest,
    responses(
        (status = 201, description = "Sandbox created", body = SandboxSummary),
        (status = 400, description = "Bad request", body = ErrorBody)
    )
)]
async fn create_sandbox(
    state: axum::extract::State<AppState>,
    Json(request): Json<CreateSandboxRequest>,
) -> SandboxResult<(StatusCode, Json<SandboxSummary>)> {
    let summary = state.service.create(request).await?;
    Ok((StatusCode::CREATED, Json(summary)))
}

#[utoipa::path(
    get,
    path = "/sandboxes",
    responses((status = 200, description = "List of sandboxes", body = [SandboxSummary]))
)]
async fn list_sandboxes(
    state: axum::extract::State<AppState>,
) -> SandboxResult<Json<Vec<SandboxSummary>>> {
    let sandboxes = state.service.list().await?;
    Ok(Json(sandboxes))
}

#[utoipa::path(
    get,
    path = "/sandboxes/{id}",
    params(
        ("id" = String, Path, description = "Sandbox identifier (UUID or short ID)")
    ),
    responses(
        (status = 200, description = "Sandbox detail", body = SandboxSummary),
        (status = 404, description = "Sandbox not found", body = ErrorBody)
    )
)]
async fn get_sandbox(
    state: axum::extract::State<AppState>,
    Path(id): Path<String>,
) -> SandboxResult<Json<SandboxSummary>> {
    match state.service.get(id.clone()).await? {
        Some(summary) => Ok(Json(summary)),
        None => Err(SandboxError::NotFound(Uuid::nil())), // TODO: Better error
    }
}

#[utoipa::path(
    post,
    path = "/sandboxes/{id}/exec",
    params(
        ("id" = String, Path, description = "Sandbox identifier (UUID or short ID)")
    ),
    request_body = ExecRequest,
    responses(
        (status = 200, description = "Command executed", body = ExecResponse),
        (status = 404, description = "Sandbox not found", body = ErrorBody)
    )
)]
async fn exec_sandbox(
    state: axum::extract::State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<ExecRequest>,
) -> SandboxResult<Json<ExecResponse>> {
    let response = state.service.exec(id, request).await?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/sandboxes/{id}/files",
    params(
        ("id" = String, Path, description = "Sandbox identifier (UUID or short ID)")
    ),
    request_body = Vec<u8>,
    responses(
        (status = 200, description = "Files uploaded"),
        (status = 404, description = "Sandbox not found", body = ErrorBody)
    )
)]
async fn upload_files(
    state: axum::extract::State<AppState>,
    Path(id): Path<String>,
    body: Body,
) -> SandboxResult<StatusCode> {
    state.service.upload_archive(id, body).await?;
    Ok(StatusCode::OK)
}

async fn attach_sandbox(
    state: axum::extract::State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<AttachParams>,
    ws: WebSocketUpgrade,
) -> Response {
    let initial_size = match (params.cols, params.rows) {
        (Some(c), Some(r)) => Some((c, r)),
        _ => None,
    };

    let command = params
        .command
        .map(|c| vec!["/bin/sh".to_string(), "-c".to_string(), c]);

    ws.on_upgrade(move |socket| async move {
        if let Err(e) = state
            .service
            .attach(id, socket, initial_size, command, params.tty)
            .await
        {
            tracing::error!("attach failed: {e}");
        }
    })
}

async fn proxy_sandbox(
    state: axum::extract::State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<ProxyParams>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = state.service.proxy(id, params.port, socket).await {
            tracing::error!("proxy failed: {e}");
        }
    })
}

/// Multiplexed WebSocket endpoint - handles multiple PTY sessions over a single connection.
async fn mux_attach(state: axum::extract::State<AppState>, ws: WebSocketUpgrade) -> Response {
    let url_rx = state.url_broadcast.subscribe();
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = state.service.mux_attach(socket, url_rx).await {
            tracing::error!("mux_attach failed: {e}");
        }
    })
}

/// Open a URL on the host machine. Used by sandboxed processes to open links.
async fn open_url(Query(params): Query<OpenUrlParams>) -> StatusCode {
    // Validate URL to prevent command injection
    if !params.url.starts_with("http://") && !params.url.starts_with("https://") {
        return StatusCode::BAD_REQUEST;
    }

    match open::that(&params.url) {
        Ok(()) => StatusCode::OK,
        Err(e) => {
            tracing::error!("Failed to open URL {}: {}", params.url, e);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[utoipa::path(
    delete,
    path = "/sandboxes/{id}",
    params(
        ("id" = String, Path, description = "Sandbox identifier (UUID or short ID)")
    ),
    responses(
        (status = 200, description = "Sandbox stopped", body = SandboxSummary),
        (status = 404, description = "Sandbox not found", body = ErrorBody)
    )
)]
async fn delete_sandbox(
    state: axum::extract::State<AppState>,
    Path(id): Path<String>,
) -> SandboxResult<Json<SandboxSummary>> {
    match state.service.delete(id.clone()).await? {
        Some(summary) => Ok(Json(summary)),
        None => Err(SandboxError::NotFound(Uuid::nil())), // TODO: Better error handling
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SandboxNetwork, SandboxStatus};
    use async_trait::async_trait;
    use axum::body::Body;
    use axum::extract::ws::WebSocket;
    use axum::http::Request;
    use chrono::Utc;
    use std::sync::Arc;
    use tokio::sync::Mutex;
    use tower::ServiceExt;
    use uuid::Uuid;

    #[derive(Clone, Default)]
    struct MockService {
        calls: Arc<Mutex<usize>>,
    }

    #[async_trait]
    impl SandboxService for MockService {
        async fn create(&self, request: CreateSandboxRequest) -> SandboxResult<SandboxSummary> {
            let mut calls = self.calls.lock().await;
            *calls += 1;
            Ok(fake_summary(request.name.unwrap_or_else(|| "mock".into())))
        }

        async fn list(&self) -> SandboxResult<Vec<SandboxSummary>> {
            Ok(vec![fake_summary("mock-list".into())])
        }

        async fn get(&self, _id: String) -> SandboxResult<Option<SandboxSummary>> {
            Ok(Some(fake_summary("mock-one".into())))
        }

        async fn exec(&self, _id: String, _exec: ExecRequest) -> SandboxResult<ExecResponse> {
            Ok(ExecResponse {
                exit_code: 0,
                stdout: "ok".into(),
                stderr: String::new(),
            })
        }

        async fn attach(
            &self,
            _id: String,
            _socket: WebSocket,
            _initial_size: Option<(u16, u16)>,
            _command: Option<Vec<String>>,
            _tty: bool,
        ) -> SandboxResult<()> {
            Ok(())
        }

        async fn mux_attach(
            &self,
            _socket: WebSocket,
            _url_rx: crate::service::UrlBroadcastReceiver,
        ) -> SandboxResult<()> {
            Ok(())
        }

        async fn proxy(&self, _id: String, _port: u16, _socket: WebSocket) -> SandboxResult<()> {
            Ok(())
        }

        async fn upload_archive(&self, _id: String, _archive: Body) -> SandboxResult<()> {
            Ok(())
        }

        async fn delete(&self, _id: String) -> SandboxResult<Option<SandboxSummary>> {
            Ok(Some(fake_summary("mock-delete".into())))
        }
    }

    fn fake_summary(name: String) -> SandboxSummary {
        SandboxSummary {
            index: 0,
            id: Uuid::new_v4(),
            name,
            created_at: Utc::now(),
            workspace: "/tmp/mock".to_string(),
            status: SandboxStatus::Running,
            network: SandboxNetwork {
                host_interface: "vethh-mock".to_string(),
                sandbox_interface: "vethn-mock".to_string(),
                host_ip: "10.0.0.1".to_string(),
                sandbox_ip: "10.0.0.2".to_string(),
                cidr: 30,
            },
        }
    }

    fn make_test_router() -> Router {
        let (url_tx, _) = tokio::sync::broadcast::channel(16);
        build_router(Arc::new(MockService::default()), url_tx)
    }

    #[tokio::test]
    async fn serves_openapi_document() {
        let app = make_test_router();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/openapi.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn create_endpoint_returns_summary() {
        let app = make_test_router();
        let request = CreateSandboxRequest {
            name: Some("demo".into()),
            workspace: None,
            read_only_paths: Vec::new(),
            tmpfs: Vec::new(),
            env: Vec::new(),
        };

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/sandboxes")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
    }
}
