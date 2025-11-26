use async_trait::async_trait;
use axum::body::Body;
use clap::Parser;
use cmux_sandbox::bubblewrap::BubblewrapService;
use cmux_sandbox::build_router;
use cmux_sandbox::errors::{SandboxError, SandboxResult};
use cmux_sandbox::models::{
    CreateSandboxRequest, ExecRequest, ExecResponse, HostEvent, OpenUrlRequest, SandboxSummary,
};
use cmux_sandbox::service::{HostEventSender, SandboxService};
use cmux_sandbox::DEFAULT_HTTP_PORT;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};
use tokio::time::{sleep, Duration};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[derive(Parser, Debug)]
#[command(name = "cmux-sandboxd", author, version)]
struct Options {
    /// Address the HTTP server binds to
    #[arg(long, default_value = "0.0.0.0")]
    bind: String,
    /// Port for the HTTP server
    #[arg(long, default_value_t = DEFAULT_HTTP_PORT, env = "CMUX_SANDBOX_PORT")]
    port: u16,
    /// Directory used for sandbox workspaces
    #[arg(long, default_value = "/var/lib/cmux/sandboxes")]
    data_dir: PathBuf,
    /// Directory used for logs
    #[arg(long, default_value = "/var/log/cmux", env = "CMUX_SANDBOX_LOG_DIR")]
    log_dir: PathBuf,
    /// Path for the Unix socket used by sandboxes to open URLs
    #[arg(
        long,
        default_value = "/var/run/cmux/open-url.sock",
        env = "CMUX_OPEN_URL_SOCKET"
    )]
    open_url_socket: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let options = Options::parse();
    let _guard = init_tracing(&options.log_dir);

    run_server(options).await;

    Ok(())
}

fn init_tracing(log_dir: &PathBuf) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let stdout_layer = tracing_subscriber::fmt::layer().with_target(false);

    // Try to create log dir
    if let Err(e) = std::fs::create_dir_all(log_dir) {
        eprintln!(
            "Failed to create log directory {:?}: {}. Logging to file disabled.",
            log_dir, e
        );
        tracing_subscriber::registry()
            .with(filter)
            .with(stdout_layer)
            .init();
        return None;
    }

    let file_appender = tracing_appender::rolling::daily(log_dir, "cmux-sandboxd.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_target(false)
        .with_ansi(false);

    tracing_subscriber::registry()
        .with(filter)
        .with(stdout_layer)
        .with(file_layer)
        .init();

    Some(guard)
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!("failed to listen for shutdown signal: {error}");
    }
    tracing::info!("shutdown signal received");
}

async fn run_server(options: Options) {
    let bind_ip = parse_bind_ip(&options.bind);
    // Broadcast channel for host-directed events (open-url, notifications)
    let (host_event_tx, _) = tokio::sync::broadcast::channel::<HostEvent>(64);

    let service = build_service(&options).await;
    let app = build_router(service, host_event_tx.clone());

    // Start the Unix socket listener for open-url requests from sandboxes
    let socket_path = options.open_url_socket.clone();
    tokio::spawn(async move {
        if let Err(e) = run_open_url_socket(&socket_path, host_event_tx).await {
            tracing::error!("open-url socket failed: {e}");
        }
    });

    let addr = SocketAddr::new(bind_ip, options.port);
    let retry_delay = Duration::from_secs(5);

    loop {
        match TcpListener::bind(addr).await {
            Ok(listener) => {
                tracing::info!("cmux-sandboxd listening on http://{}", addr);
                tracing::info!("HTTP/1.1 and HTTP/2 are enabled");

                match axum::serve(listener, app.clone())
                    .with_graceful_shutdown(shutdown_signal())
                    .await
                {
                    Ok(()) => {
                        tracing::info!("server shut down gracefully");
                        break;
                    }
                    Err(error) => {
                        tracing::error!(?error, "server error; restarting");
                    }
                }
            }
            Err(error) => {
                tracing::error!(?error, %addr, "failed to bind listener");
            }
        }

        tracing::info!(
            "retrying server startup in {} seconds",
            retry_delay.as_secs()
        );
        sleep(retry_delay).await;
    }
}

fn parse_bind_ip(bind: &str) -> IpAddr {
    match bind.parse() {
        Ok(ip) => ip,
        Err(error) => {
            tracing::error!(
                ?error,
                %bind,
                "invalid bind address; defaulting to 0.0.0.0"
            );
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        }
    }
}

async fn build_service(options: &Options) -> Arc<dyn SandboxService> {
    match BubblewrapService::new(options.data_dir.clone(), options.port).await {
        Ok(service) => Arc::new(service),
        Err(error) => {
            tracing::error!(
                ?error,
                "failed to initialize bubblewrap service; running in degraded mode"
            );
            Arc::new(UnavailableSandboxService::new(error.to_string()))
        }
    }
}

/// Run a Unix socket listener for open-url requests from sandboxes.
/// Protocol: Each request is a single line containing the URL, response is "OK\n" or "ERROR: message\n".
async fn run_open_url_socket(
    socket_path: &PathBuf,
    host_events: HostEventSender,
) -> anyhow::Result<()> {
    // Ensure parent directory exists
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Remove existing socket file if it exists
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }

    let listener = UnixListener::bind(socket_path)?;
    tracing::info!("open-url socket listening on {:?}", socket_path);

    // Make socket world-writable so sandboxes can connect
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o666))?;
    }

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let host_events = host_events.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_open_url_connection(stream, host_events).await {
                        tracing::warn!("open-url connection error: {e}");
                    }
                });
            }
            Err(e) => {
                tracing::error!("open-url socket accept error: {e}");
            }
        }
    }
}

/// Handle a single open-url connection.
async fn handle_open_url_connection(
    stream: tokio::net::UnixStream,
    host_events: HostEventSender,
) -> anyhow::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    // Read a single line containing the URL
    reader.read_line(&mut line).await?;
    let trimmed = line.trim();

    if trimmed.is_empty() {
        writer.write_all(b"ERROR: URL must not be empty\n").await?;
        return Ok(());
    }

    let mut request = match serde_json::from_str::<OpenUrlRequest>(trimmed) {
        Ok(req) => req,
        Err(_) => OpenUrlRequest {
            url: trimmed.to_string(),
            sandbox_id: None,
            tab_id: None,
        },
    };

    if request
        .sandbox_id
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        request.sandbox_id = None;
    }
    if request
        .tab_id
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        request.tab_id = None;
    }

    // Validate URL
    if !request.url.starts_with("http://") && !request.url.starts_with("https://") {
        writer
            .write_all(b"ERROR: URL must start with http:// or https://\n")
            .await?;
        return Ok(());
    }

    // Broadcast URL to connected clients (they will open it on the host)
    match host_events.send(HostEvent::OpenUrl(OpenUrlRequest {
        url: request.url.clone(),
        sandbox_id: request.sandbox_id.clone(),
        tab_id: request.tab_id.clone(),
    })) {
        Ok(receivers) => {
            tracing::info!("broadcast URL to {} clients: {}", receivers, request.url);
            writer.write_all(b"OK\n").await?;
        }
        Err(_) => {
            // No receivers - no mux clients connected
            tracing::warn!("no clients connected to receive URL: {}", request.url);
            writer.write_all(b"ERROR: no clients connected\n").await?;
        }
    }

    Ok(())
}

#[derive(Clone)]
struct UnavailableSandboxService {
    reason: String,
}

impl UnavailableSandboxService {
    fn new(reason: String) -> Self {
        Self { reason }
    }

    fn error(&self, operation: &str) -> SandboxError {
        SandboxError::Internal(format!(
            "{operation} unavailable: sandbox service failed to start ({})",
            self.reason
        ))
    }
}

#[async_trait]
impl SandboxService for UnavailableSandboxService {
    async fn create(&self, _request: CreateSandboxRequest) -> SandboxResult<SandboxSummary> {
        Err(self.error("create sandbox"))
    }

    async fn list(&self) -> SandboxResult<Vec<SandboxSummary>> {
        Err(self.error("list sandboxes"))
    }

    async fn get(&self, _id: String) -> SandboxResult<Option<SandboxSummary>> {
        Err(self.error("get sandbox"))
    }

    async fn exec(&self, _id: String, _exec: ExecRequest) -> SandboxResult<ExecResponse> {
        Err(self.error("exec sandbox command"))
    }

    async fn attach(
        &self,
        _id: String,
        _socket: axum::extract::ws::WebSocket,
        _initial_size: Option<(u16, u16)>,
        _command: Option<Vec<String>>,
        _tty: bool,
    ) -> SandboxResult<()> {
        Err(self.error("attach sandbox session"))
    }

    async fn mux_attach(
        &self,
        _socket: axum::extract::ws::WebSocket,
        _host_event_rx: cmux_sandbox::service::HostEventReceiver,
    ) -> SandboxResult<()> {
        Err(self.error("mux attach"))
    }

    async fn proxy(
        &self,
        _id: String,
        _port: u16,
        _socket: axum::extract::ws::WebSocket,
    ) -> SandboxResult<()> {
        Err(self.error("proxy sandbox port"))
    }

    async fn upload_archive(&self, _id: String, _archive: Body) -> SandboxResult<()> {
        Err(self.error("upload archive"))
    }

    async fn delete(&self, _id: String) -> SandboxResult<Option<SandboxSummary>> {
        Err(self.error("delete sandbox"))
    }
}
