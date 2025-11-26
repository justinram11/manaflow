use crate::errors::SandboxResult;
use crate::models::{CreateSandboxRequest, ExecRequest, ExecResponse, HostEvent, SandboxSummary};
use async_trait::async_trait;
use axum::body::Body;
use axum::extract::ws::WebSocket;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Broadcast channel for host-directed events (open-url, notifications, etc.).
/// Sent to connected mux clients to handle actions on the host machine.
pub type HostEventSender = broadcast::Sender<HostEvent>;
pub type HostEventReceiver = broadcast::Receiver<HostEvent>;

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
        host_event_rx: HostEventReceiver,
    ) -> SandboxResult<()>;
    async fn proxy(&self, id: String, port: u16, socket: WebSocket) -> SandboxResult<()>;
    async fn upload_archive(&self, id: String, archive: Body) -> SandboxResult<()>;
    async fn delete(&self, id: String) -> SandboxResult<Option<SandboxSummary>>;
}

#[derive(Clone)]
pub struct AppState {
    pub service: Arc<dyn SandboxService>,
    pub host_events: HostEventSender,
}

impl AppState {
    pub fn new(service: Arc<dyn SandboxService>, host_events: HostEventSender) -> Self {
        Self {
            service,
            host_events,
        }
    }
}

#[allow(dead_code)]
fn assert_app_state_bounds() {
    fn assert_state<T: Clone + Send + Sync + 'static>() {}
    assert_state::<AppState>();
}
