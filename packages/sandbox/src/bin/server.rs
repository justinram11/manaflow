use clap::Parser;
use cmux_sandbox::bubblewrap::BubblewrapService;
use cmux_sandbox::build_router;
use cmux_sandbox::DEFAULT_HTTP_PORT;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};
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

    let bind_ip: IpAddr = options
        .bind
        .parse()
        .map_err(|error| anyhow::anyhow!("invalid bind address: {error}"))?;

    // Create broadcast channel for URL open requests
    // URLs from sandboxes are broadcast to all connected mux clients
    let (url_tx, _) = tokio::sync::broadcast::channel::<String>(64);

    let service = Arc::new(BubblewrapService::new(options.data_dir, options.port).await?);
    let app = build_router(service, url_tx.clone());

    // Start the Unix socket listener for open-url requests from sandboxes
    let socket_path = options.open_url_socket.clone();
    tokio::spawn(async move {
        if let Err(e) = run_open_url_socket(&socket_path, url_tx).await {
            tracing::error!("open-url socket failed: {e}");
        }
    });

    let addr = SocketAddr::new(bind_ip, options.port);
    let listener = TcpListener::bind(addr).await?;
    tracing::info!("cmux-sandboxd listening on http://{}", addr);
    tracing::info!("HTTP/1.1 and HTTP/2 are enabled");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

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

/// Run a Unix socket listener for open-url requests from sandboxes.
/// Protocol: Each request is a single line containing the URL, response is "OK\n" or "ERROR: message\n".
async fn run_open_url_socket(
    socket_path: &PathBuf,
    url_tx: tokio::sync::broadcast::Sender<String>,
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
                let url_tx = url_tx.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_open_url_connection(stream, url_tx).await {
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
    url_tx: tokio::sync::broadcast::Sender<String>,
) -> anyhow::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    // Read a single line containing the URL
    reader.read_line(&mut line).await?;
    let url = line.trim();

    // Validate URL
    if !url.starts_with("http://") && !url.starts_with("https://") {
        writer
            .write_all(b"ERROR: URL must start with http:// or https://\n")
            .await?;
        return Ok(());
    }

    // Broadcast URL to connected clients (they will open it on the host)
    match url_tx.send(url.to_string()) {
        Ok(receivers) => {
            tracing::info!("broadcast URL to {} clients: {}", receivers, url);
            writer.write_all(b"OK\n").await?;
        }
        Err(_) => {
            // No receivers - no mux clients connected
            tracing::warn!("no clients connected to receive URL: {}", url);
            writer.write_all(b"ERROR: no clients connected\n").await?;
        }
    }

    Ok(())
}
