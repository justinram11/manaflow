use crate::errors::SandboxResult;
use crate::models::{CreateSandboxRequest, ExecRequest, ExecResponse, SandboxSummary};
use async_trait::async_trait;
use axum::body::Body;
use axum::extract::ws::WebSocket;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Broadcast channel for URL open requests from sandboxes.
/// Sent to connected mux clients to open URLs on the host machine.
pub type UrlBroadcastSender = broadcast::Sender<String>;
pub type UrlBroadcastReceiver = broadcast::Receiver<String>;

#[async_trait]
pub trait SandboxService: Send + Sync + 'static {
    async fn create(&self, request: CreateSandboxRequest) -> SandboxResult<SandboxSummary>;
    async fn list(&self) -> SandboxResult<Vec<SandboxSummary>>;
    async fn get(&self, id: String) -> SandboxResult<Option<SandboxSummary>>;
    async fn exec(&self, id: String, exec: ExecRequest) -> SandboxResult<ExecResponse>;
    async fn attach(
        &self,
        id: String,
        socket: WebSocket,
        initial_size: Option<(u16, u16)>,
        command: Option<Vec<String>>,
        tty: bool,
    ) -> SandboxResult<()>;
    /// Multiplexed attach - handles multiple PTY sessions over a single WebSocket.
    async fn mux_attach(
        &self,
        socket: WebSocket,
        url_rx: UrlBroadcastReceiver,
    ) -> SandboxResult<()>;
    async fn proxy(&self, id: String, port: u16, socket: WebSocket) -> SandboxResult<()>;
    async fn upload_archive(&self, id: String, archive: Body) -> SandboxResult<()>;
    async fn delete(&self, id: String) -> SandboxResult<Option<SandboxSummary>>;
}

#[derive(Clone)]
pub struct AppState {
    pub service: Arc<dyn SandboxService>,
    pub url_broadcast: UrlBroadcastSender,
}

impl AppState {
    pub fn new(service: Arc<dyn SandboxService>, url_broadcast: UrlBroadcastSender) -> Self {
        Self {
            service,
            url_broadcast,
        }
    }
}

#[allow(dead_code)]
fn assert_app_state_bounds() {
    fn assert_state<T: Clone + Send + Sync + 'static>() {}
    assert_state::<AppState>();
}
