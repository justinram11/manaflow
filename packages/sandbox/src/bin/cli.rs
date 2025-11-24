use clap::{Args, Parser, Subcommand};
use cmux_sandbox::models::{
    CreateSandboxRequest, EnvVar, ExecRequest, ExecResponse, SandboxSummary,
};
use cmux_sandbox::DEFAULT_HTTP_PORT;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use futures::{SinkExt, StreamExt};
use reqwest::Client;
use serde::Serialize;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use ignore::WalkBuilder;
use tar::Builder;

#[cfg(unix)]
use tokio::signal::unix::{signal, SignalKind};

// Proxy imports
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, SanType};
use tokio_rustls::TlsAcceptor;
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

#[derive(Parser, Debug)]
#[command(name = "cmux", version, about = "cmux sandbox controller")]
struct Cli {
    /// Base URL for the sandbox daemon (http or https)
    #[arg(long, env = "CMUX_SANDBOX_URL", default_value_t = default_base_url())]
    base_url: String,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    #[command(subcommand, alias = "s", alias = "sandbox")]
    Sandboxes(SandboxCommand),
    /// Create a new sandbox and attach to it immediately
    New(NewArgs),
    /// Fetch the OpenAPI document from the server
    Openapi,

    /// List known sandboxes (alias for 'sandboxes list')
    Ls,

    /// Attach to a shell in the sandbox (SSH-like)
    #[command(alias = "a")]
    Attach {
        /// Sandbox ID or index (optional, defaults to last connected)
        id: Option<String>,
    },

    /// Execute a command inside a sandbox
    Exec(ExecArgs),

    /// Start a proxy server for the sandbox
    #[command(alias = "p")]
    Proxy {
        /// Sandbox ID or index
        id: String,
        /// Port to listen on (0 for random)
        #[arg(long, default_value_t = 0)]
        port: u16,
    },

    /// Open a browser connected to the sandbox
    #[command(alias = "b")]
    Browser {
        /// Sandbox ID or index
        id: String,
    },

    /// Internal helper to proxy stdin/stdout to a TCP address
    #[command(name = "_internal-proxy", hide = true)]
    InternalProxy { address: String },

    /// Start the sandbox server container
    Start,
    /// Stop the sandbox server container
    Stop,
    /// Restart the sandbox server container
    Restart,
    /// Show status of the sandbox server
    Status,

    /// Manage authentication files
    Auth(AuthArgs),
}

#[derive(Args, Debug)]
struct AuthArgs {
    #[command(subcommand)]
    command: AuthCommand,
}

#[derive(Subcommand, Debug)]
enum AuthCommand {
    /// List detected authentication files on the host
    Status,
}

struct AuthFileDef {
    name: &'static str,
    host_path: &'static str, // Relative to HOME
    sandbox_path: &'static str, // Absolute in sandbox
}

const ENV_CMUX_NO_ATTACH: &str = "CMUX_NO_ATTACH";
const ENV_CMUX_FORCE_ATTACH: &str = "CMUX_FORCE_ATTACH";

const AUTH_FILES: &[AuthFileDef] = &[
    AuthFileDef { name: "Claude Config", host_path: ".claude.json", sandbox_path: "/root/.claude.json" },
    AuthFileDef { name: "Codex Auth", host_path: ".codex/auth.json", sandbox_path: "/root/.codex/auth.json" },
    AuthFileDef { name: "Codex Instructions", host_path: ".codex/instructions.md", sandbox_path: "/root/.codex/instructions.md" },
    AuthFileDef { name: "Codex Config", host_path: ".codex/config.toml", sandbox_path: "/root/.codex/config.toml" },
    AuthFileDef { name: "Gemini Settings", host_path: ".gemini/settings.json", sandbox_path: "/root/.gemini/settings.json" },
    AuthFileDef { name: "Gemini OAuth", host_path: ".gemini/oauth_creds.json", sandbox_path: "/root/.gemini/oauth_creds.json" },
    AuthFileDef { name: "Gemini MCP Tokens", host_path: ".gemini/mcp-oauth-tokens.json", sandbox_path: "/root/.gemini/mcp-oauth-tokens.json" },
    AuthFileDef { name: "Gemini Google Accounts", host_path: ".gemini/google_accounts.json", sandbox_path: "/root/.gemini/google_accounts.json" },
    AuthFileDef { name: "Gemini Account ID", host_path: ".gemini/google_account_id", sandbox_path: "/root/.gemini/google_account_id" },
    AuthFileDef { name: "Gemini Install ID", host_path: ".gemini/installation_id", sandbox_path: "/root/.gemini/installation_id" },
    AuthFileDef { name: "Gemini User ID", host_path: ".gemini/user_id", sandbox_path: "/root/.gemini/user_id" },
    AuthFileDef { name: "Gemini Env", host_path: ".gemini/.env", sandbox_path: "/root/.gemini/.env" },
    AuthFileDef { name: "Env", host_path: ".env", sandbox_path: "/root/.env" },
    AuthFileDef { name: "OpenCode Auth", host_path: ".local/share/opencode/auth.json", sandbox_path: "/root/.local/share/opencode/auth.json" },
    // Amp
    AuthFileDef { name: "Amp Settings", host_path: ".config/amp/settings.json", sandbox_path: "/root/.config/amp/settings.json" },
    AuthFileDef { name: "Amp Secrets", host_path: ".local/share/amp/secrets.json", sandbox_path: "/root/.local/share/amp/secrets.json" },
    // Cursor
    AuthFileDef { name: "Cursor CLI Config", host_path: ".cursor/cli-config.json", sandbox_path: "/root/.cursor/cli-config.json" },
    AuthFileDef { name: "Cursor Auth", host_path: ".config/cursor/auth.json", sandbox_path: "/root/.config/cursor/auth.json" },
    // Qwen
    AuthFileDef { name: "Qwen Settings", host_path: ".qwen/settings.json", sandbox_path: "/root/.qwen/settings.json" },
];

#[derive(Subcommand, Debug)]
enum SandboxCommand {
    /// List known sandboxes
    #[command(alias = "ls")]
    List,
    /// Create a new sandbox
    Create(CreateArgs),
    /// Create a new sandbox and attach to it immediately
    New(NewArgs),
    /// Inspect a sandbox
    Show { id: String },
    /// Execute a command inside a sandbox
    Exec(ExecArgs),
    /// Attach to a shell in the sandbox (SSH-like)
    Ssh { id: String },
    /// Tear down a sandbox
    Delete { id: String },
}

#[derive(Args, Debug)]
struct CreateArgs {
    #[arg(long)]
    name: Option<String>,
    /// Optional positional name for convenience: `cmux sandboxes create myname`
    #[arg(value_name = "NAME")]
    positional_name: Option<String>,
    #[arg(long)]
    workspace: Option<PathBuf>,
    #[arg(long, value_parser = parse_env)]
    env: Vec<EnvVar>,
    #[arg(long = "read-only", value_name = "PATH")]
    read_only_paths: Vec<PathBuf>,
    #[arg(long, value_name = "PATH")]
    tmpfs: Vec<String>,
}

#[derive(Args, Debug)]
struct ExecArgs {
    id: String,
    #[arg(trailing_var_arg = true, required = true)]
    command: Vec<String>,
    #[arg(long)]
    workdir: Option<String>,
    #[arg(short = 'e', long = "env", value_parser = parse_env)]
    env: Vec<EnvVar>,
}

#[derive(Args, Debug)]
struct NewArgs {
    /// Path to the project directory to upload (defaults to current directory)
    #[arg(default_value = ".")]
    path: PathBuf,
}

fn default_base_url() -> String {
    format!("http://127.0.0.1:{DEFAULT_HTTP_PORT}")
}

fn parse_env(raw: &str) -> Result<EnvVar, String> {
    let parts: Vec<&str> = raw.splitn(2, '=').collect();
    if parts.len() != 2 {
        return Err("env should look like KEY=value".to_string());
    }

    Ok(EnvVar {
        key: parts[0].to_string(),
        value: parts[1].to_string(),
    })
}

fn get_config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".cmux")
}

fn get_last_sandbox() -> Option<String> {
    let path = get_config_dir().join("last_sandbox");
    if path.exists() {
        std::fs::read_to_string(path).ok().map(|s| s.trim().to_string())
    } else {
        None
    }
}

fn save_last_sandbox(id: &str) {
    let dir = get_config_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let path = dir.join("last_sandbox");
    let _ = std::fs::write(path, id);
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if let Err(e) = run().await {
        eprintln!("Error: {e:?}");
        std::process::exit(1);
    }
    std::process::exit(0);
}

async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if std::env::var("CMUX_DEBUG").is_ok() {
        eprintln!("cmux base url: {}", cli.base_url);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .no_proxy()
        .http2_keep_alive_interval(Duration::from_secs(30))
        .build()?;

    match cli.command {
        Command::Openapi => {
            let url = format!("{}/openapi.json", cli.base_url.trim_end_matches('/'));
            let response = client.get(url).send().await?;
            let value: serde_json::Value = parse_response(response).await?;
            print_json(&value)?;
        }
        Command::New(args) => {
            let body = CreateSandboxRequest {
                name: Some("interactive".into()),
                workspace: None,
                read_only_paths: vec![],
                tmpfs: vec![],
                env: vec![],
            };
            let url = format!("{}/sandboxes", cli.base_url.trim_end_matches('/'));
            let response = client.post(url).json(&body).send().await?;
            let summary: SandboxSummary = parse_response(response).await?;
            eprintln!("Created sandbox {}", summary.id);

            // Upload directory
            eprintln!("Uploading directory: {}", args.path.display());
            let body = stream_directory(args.path.clone());
            let url = format!("{}/sandboxes/{}/files", cli.base_url.trim_end_matches('/'), summary.id);
            let response = client.post(url).body(body).send().await?;
            if !response.status().is_success() {
                 eprintln!("Failed to upload files: {}", response.status());
            } else {
                 eprintln!("Files uploaded.");
            }

            // Upload auth files
            if let Err(e) = upload_auth_files(&client, &cli.base_url, &summary.id.to_string()).await {
                eprintln!("Warning: Failed to upload auth files: {}", e);
            }

            save_last_sandbox(&summary.id.to_string());
            if should_attach() {
                handle_ssh(&cli.base_url, &summary.id.to_string()).await?;
            } else {
                eprintln!("Skipping interactive shell attach (non-interactive environment detected).");
            }
        }
        Command::Ls => {
            let url = format!("{}/sandboxes", cli.base_url.trim_end_matches('/'));
            let response = client.get(url).send().await?;
            let sandboxes: Vec<SandboxSummary> = parse_response(response).await?;
            print_json(&sandboxes)?;
        }
        Command::Attach { id } => {
            let target_id = if let Some(id) = id {
                id
            } else {
                get_last_sandbox().ok_or_else(|| {
                    anyhow::anyhow!("No sandbox ID provided and no previous sandbox found")
                })? 
            };
            save_last_sandbox(&target_id);
            handle_ssh(&cli.base_url, &target_id).await?;
        }
        Command::Exec(args) => {
            handle_exec_request(&client, &cli.base_url, args).await?;
        }
        Command::InternalProxy { address } => {
            let mut stream = tokio::net::TcpStream::connect(address).await?;
            let (mut ri, mut wi) = stream.split();
            let mut stdin = tokio::io::stdin();
            let mut stdout = tokio::io::stdout();

            let _ = tokio::join!(
                tokio::io::copy(&mut stdin, &mut wi),
                tokio::io::copy(&mut ri, &mut stdout)
            );
        }
        Command::Proxy { id, port } => {
            handle_proxy(cli.base_url, id, port).await?;
        }
        Command::Browser { id } => {
            handle_browser(cli.base_url, id).await?;
        }
        Command::Start => {
            handle_server_start().await?;
        }
        Command::Stop => {
            handle_server_stop().await?;
        }
        Command::Restart => {
            handle_server_stop().await?;
            handle_server_start().await?;
        }
        Command::Status => {
            handle_server_status(&cli.base_url).await?;
        }
        Command::Auth(args) => match args.command {
            AuthCommand::Status => {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                let home_path = PathBuf::from(home);
                println!("Checking for authentication files in {}:", home_path.display());
                println!("{:<25} {:<50} {:<10}", "NAME", "PATH", "STATUS");
                println!("{}", "-".repeat(85));

                for def in AUTH_FILES {
                    let path = home_path.join(def.host_path);
                    let status = if path.exists() {
                        "\x1b[32mFound\x1b[0m"
                    } else {
                        "\x1b[90mMissing\x1b[0m"
                    };
                    println!("{:<25} {:<50} {}", def.name, def.host_path, status);
                }
            }
        },
        Command::Sandboxes(cmd) => match cmd {
            SandboxCommand::List => {
                let url = format!("{}/sandboxes", cli.base_url.trim_end_matches('/'));
                let response = client.get(url).send().await?;
                let sandboxes: Vec<SandboxSummary> = parse_response(response).await?;
                print_json(&sandboxes)?;
            }
            SandboxCommand::Create(args) => {
                let resolved_name = args.name.or(args.positional_name);
                let body = CreateSandboxRequest {
                    name: resolved_name,
                    workspace: args.workspace.map(|p| p.to_string_lossy().to_string()),
                    read_only_paths:
                        args.read_only_paths.iter().map(|p| p.to_string_lossy().to_string()).collect(),
                    tmpfs: args.tmpfs,
                    env: args.env,
                };

                let url = format!("{}/sandboxes", cli.base_url.trim_end_matches('/'));
                let response = client.post(url).json(&body).send().await?;
                let summary: SandboxSummary = parse_response(response).await?;
                print_json(&summary)?;
            }
            SandboxCommand::New(args) => {
                let body = CreateSandboxRequest {
                    name: Some("interactive".into()),
                    workspace: None,
                    read_only_paths: vec![],
                    tmpfs: vec![],
                    env: vec![],
                };
                let url = format!("{}/sandboxes", cli.base_url.trim_end_matches('/'));
                let response = client.post(url).json(&body).send().await?;
                let summary: SandboxSummary = parse_response(response).await?;
                eprintln!("Created sandbox {}", summary.id);

                // Upload directory
                eprintln!("Uploading directory: {}", args.path.display());
                let body = stream_directory(args.path.clone());
                let url = format!("{}/sandboxes/{}/files", cli.base_url.trim_end_matches('/'), summary.id);
                let response = client.post(url).body(body).send().await?;
                if !response.status().is_success() {
                     eprintln!("Failed to upload files: {}", response.status());
                } else {
                     eprintln!("Files uploaded.");
                }

                // Upload auth files
                if let Err(e) = upload_auth_files(&client, &cli.base_url, &summary.id.to_string()).await {
                    eprintln!("Warning: Failed to upload auth files: {}", e);
                }

                save_last_sandbox(&summary.id.to_string());
                if should_attach() {
                    handle_ssh(&cli.base_url, &summary.id.to_string()).await?;
                } else {
                    eprintln!("Skipping interactive shell attach (non-interactive environment detected).");
                }
            }
            SandboxCommand::Show { id } => {
                let url = format!("{}/sandboxes/{id}", cli.base_url.trim_end_matches('/'));
                let response = client.get(url).send().await?;
                let summary: SandboxSummary = parse_response(response).await?;
                print_json(&summary)?;
            }
            SandboxCommand::Exec(args) => {
                handle_exec_request(&client, &cli.base_url, args).await?;
            }
            SandboxCommand::Ssh { id } => {
                save_last_sandbox(&id);
                handle_ssh(&cli.base_url, &id).await?;
            }
            SandboxCommand::Delete { id } => {
                let url = format!("{}/sandboxes/{id}", cli.base_url.trim_end_matches('/'));
                let response = client.delete(url).send().await?;
                let summary: SandboxSummary = parse_response(response).await?;
                print_json(&summary)?;
            }
        },
    }

    Ok(())
}

struct RawModeGuard;

impl RawModeGuard {
    fn new() -> anyhow::Result<Self> {
        enable_raw_mode()?;
        Ok(Self)
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
    }
}

async fn handle_ssh(base_url: &str, id: &str) -> anyhow::Result<()> {
    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    let ws_url = base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .trim_end_matches('/')
        .to_string();
    let url = format!("{}/sandboxes/{}/attach?cols={}&rows={}", ws_url, id, cols, rows);

    let (ws_stream, _) = connect_async(url).await?;
    eprintln!("Connected to sandbox shell. Press Ctrl+D to exit.");

    let _guard = RawModeGuard::new()?;

    let (mut write, mut read) = ws_stream.split();
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut buf = [0u8; 1024];

    #[cfg(unix)]
    let mut sigwinch = signal(SignalKind::window_change())?;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                break;
            }
            _ = async {
                #[cfg(unix)]
                return sigwinch.recv().await;
                #[cfg(not(unix))]
                std::future::pending::<Option<()>>().await
            } => {
                if let Ok((cols, rows)) = crossterm::terminal::size() {
                    let msg = format!("resize:{}:{}", rows, cols);
                    write.send(Message::Text(msg)).await?;
                }
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        stdout.write_all(&data).await?;
                        stdout.flush().await?;
                    }
                    Some(Ok(Message::Text(text))) => {
                        stdout.write_all(text.as_bytes()).await?;
                        stdout.flush().await?;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        break;
                    }
                    _ => {}
                }
            }
            res = stdin.read(&mut buf) => {
                match res {
                    Ok(0) => break,
                    Ok(n) => {
                        write.send(Message::Binary(buf[..n].to_vec())).await?;
                    }
                    Err(_) => break,
                }
            }
        }
    }

    // Guard dropped here, disabling raw mode
    eprintln!();
    Ok(())
}

async fn parse_response<T>(response: reqwest::Response) -> anyhow::Result<T>
where
    T: for<'de> serde::Deserialize<'de>,
{
    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("unknown error"));
        return Err(anyhow::anyhow!("request failed: {status} - {text}"));
    }

    Ok(response.json::<T>().await?)
}

struct ChunkedWriter {
    sender: tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
}

impl std::io::Write for ChunkedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let data = buf.to_vec();
        // We use blocking_send because this runs in a spawn_blocking task
        match self.sender.blocking_send(Ok(data)) {
            Ok(_) => Ok(buf.len()),
            Err(_) => Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Channel closed")),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn stream_directory(path: PathBuf) -> reqwest::Body {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(10);

    tokio::task::spawn_blocking(move || {
        let writer = ChunkedWriter { sender: tx.clone() };
        let mut tar = Builder::new(writer);
        tar.follow_symlinks(false);

        let root = match path.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                let _ = tx.blocking_send(Err(std::io::Error::other(e)));
                return;
            }
        };

        let append_result = if let Some(paths) = git_list_files(&root) {
            append_paths(&root, paths, &mut tar).and_then(|_| append_git_dir(&root, &mut tar))
        } else {
            append_walked_paths(&root, &mut tar)
        };

        if let Err(e) = append_result {
            let _ = tx.blocking_send(Err(e));
            return;
        }

        if let Err(e) = tar.finish() {
             let _ = tx.blocking_send(Err(e));
        }
    });

    reqwest::Body::wrap_stream(futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|msg| (msg, rx))
    }))
}

fn append_paths(
    root: &Path,
    paths: Vec<PathBuf>,
    tar: &mut Builder<ChunkedWriter>,
) -> std::io::Result<()> {
    for relative_path in paths {
        append_path(root, &relative_path, tar)?;
    }
    Ok(())
}

fn append_path(
    root: &Path,
    relative_path: &Path,
    tar: &mut Builder<ChunkedWriter>,
) -> std::io::Result<()> {
    let entry_path = root.join(relative_path);
    let metadata = std::fs::symlink_metadata(&entry_path)?;
    let file_type = metadata.file_type();

    if file_type.is_dir() {
        tar.append_dir(relative_path, entry_path)?;
    } else {
        tar.append_path_with_name(entry_path, relative_path)?;
    }

    Ok(())
}

fn append_walked_paths(root: &Path, tar: &mut Builder<ChunkedWriter>) -> std::io::Result<()> {
    let walker = WalkBuilder::new(root).hidden(false).git_ignore(true).build();

    for result in walker {
        let entry = match result {
            Ok(entry) => entry,
            Err(err) => return Err(std::io::Error::other(err)),
        };
        let entry_path = entry.path();

        if entry_path == root {
            continue;
        }

        let relative_path = entry_path
            .strip_prefix(root)
            .map_err(std::io::Error::other)?;

        append_path(root, relative_path, tar)?;
    }

    Ok(())
}

fn git_list_files(root: &Path) -> Option<Vec<PathBuf>> {
    let is_repo = ProcessCommand::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .map(|output| output == "true")
        .unwrap_or(false);

    if !is_repo {
        return None;
    }

    let output = ProcessCommand::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            ".",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let mut paths = Vec::new();
    for raw in output.stdout.split(|b| *b == 0) {
        if raw.is_empty() {
            continue;
        }

        let path_str = String::from_utf8(raw.to_vec()).ok()?;
        paths.push(PathBuf::from(path_str));
    }

    Some(paths)
}

fn append_git_dir(root: &Path, tar: &mut Builder<ChunkedWriter>) -> std::io::Result<()> {
    let git_dir = root.join(".git");
    if !git_dir.exists() {
        return Ok(());
    }

    let walker = WalkBuilder::new(&git_dir)
        .hidden(false)
        .git_ignore(false)
        .build();

    for result in walker {
        let entry = match result {
            Ok(entry) => entry,
            Err(err) => return Err(std::io::Error::other(err)),
        };

        let entry_path = entry.path();
        if entry_path == git_dir {
            continue;
        }

        let relative_path = entry_path
            .strip_prefix(root)
            .map_err(std::io::Error::other)?;

        append_path(root, relative_path, tar)?;
    }

    Ok(())
}

fn should_attach() -> bool {
    if std::env::var(ENV_CMUX_NO_ATTACH).is_ok() {
        return false;
    }

    let stdin_tty = std::io::stdin().is_terminal();
    let stdout_tty = std::io::stdout().is_terminal();
    let stderr_tty = std::io::stderr().is_terminal();

    if std::env::var(ENV_CMUX_FORCE_ATTACH).is_ok() {
        return stdin_tty && stdout_tty && stderr_tty;
    }

    stdin_tty && stdout_tty && stderr_tty
}

fn print_json<T: Serialize>(value: &T) -> anyhow::Result<()> {
    let rendered = serde_json::to_string_pretty(value)?;
    println!("{rendered}");
    Ok(())
}

async fn handle_proxy(base_url: String, id: String, port: u16) -> anyhow::Result<()> {
    let ca = Arc::new(generate_ca()?);
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).await?;
    let local_addr = listener.local_addr()?;
    eprintln!("Proxy listening on http://{}", local_addr);

    loop {
        let (socket, _) = listener.accept().await?;
        let base_url = base_url.clone();
        let id = id.clone();
        let ca = ca.clone();
        
        tokio::spawn(async move {
            if let Err(_e) = handle_connection(socket, base_url, id, ca).await {
                // Ignore
            }
        });
    }
}

async fn handle_browser(base_url: String, id: String) -> anyhow::Result<()> {
    let ca = Arc::new(generate_ca()?);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    eprintln!("Proxy started on port {}", port);
    
    let base_url_c = base_url.clone();
    let id_c = id.clone();
    let ca_c = ca.clone();
    
    tokio::spawn(async move {
        loop {
            if let Ok((socket, _)) = listener.accept().await {
                 let b = base_url_c.clone();
                 let i = id_c.clone();
                 let c = ca_c.clone();
                 tokio::spawn(async move {
                     let _ = handle_connection(socket, b, i, c).await;
                 });
            }
        }
    });
    
    // Launch Chrome
    #[cfg(target_os = "macos")]
    let chrome_bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    #[cfg(target_os = "linux")]
    let chrome_bin = "google-chrome"; 
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let chrome_bin = "chrome";

    let user_data = std::env::temp_dir().join("cmux-chrome-profile");
    let _ = std::fs::create_dir_all(&user_data);

    eprintln!("Launching Chrome...");
    let mut child = tokio::process::Command::new(chrome_bin)
        .arg(format!("--proxy-server=http=127.0.0.1:{};https=127.0.0.1:{}", port, port))
        .arg("--proxy-bypass-list=<-loopback>")
        .arg("--ignore-certificate-errors")
        .arg(format!("--user-data-dir={}", user_data.display()))
        .arg("--no-first-run")
        .arg("http://localhost:8000") 
        .kill_on_drop(true)
        .spawn()?;

    child.wait().await?;
    Ok(())
}

fn generate_ca() -> anyhow::Result<rcgen::Certificate> {
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.distinguished_name.push(DnType::CommonName, "cmux-sandbox-ca");
    Ok(rcgen::Certificate::from_params(params)?)
}

async fn handle_server_start() -> anyhow::Result<()> {
    let container_name = std::env::var("CONTAINER_NAME").unwrap_or_else(|_| "cmux-sandbox-dev-run".into());
    let port = std::env::var("CMUX_SANDBOX_PORT").unwrap_or_else(|_| "46831".into());
    let image_name = std::env::var("IMAGE_NAME").unwrap_or_else(|_| "cmux-sandbox-dev".into());

    // Check if container is already running
    let output = tokio::process::Command::new("docker")
        .args(["ps", "--filter", &format!("name=^/{}$", container_name), "--format", "{{.Names}}"])
        .output()
        .await?;
    
    let output_str = String::from_utf8_lossy(&output.stdout);
    if output_str.trim() == container_name {
        eprintln!("Server container '{}' is already running.", container_name);
        return Ok(());
    }

    eprintln!("Starting server container '{}' on port {}...", container_name, port);

    // Force remove existing stopped container if any
    let _ = tokio::process::Command::new("docker")
        .args(["rm", "-f", &container_name])
        .output()
        .await;

    let status = tokio::process::Command::new("docker")
        .args([
            "run",
            "--privileged",
            "-d",
            "--name", &container_name,
            "--cgroupns=host",
            "--tmpfs", "/run",
            "--tmpfs", "/run/lock",
            "-v", "/sys/fs/cgroup:/sys/fs/cgroup:rw",
            "--dns", "1.1.1.1",
            "--dns", "8.8.8.8",
            "-e", &format!("CMUX_SANDBOX_PORT={}", port),
            "-p", &format!("{}:{}", port, port),
            "-v", "cmux-sandbox-docker:/var/lib/docker",
            "-v", "cmux-sandbox-data:/var/lib/cmux/sandboxes",
            "--entrypoint", "/usr/local/bin/bootstrap-dind.sh",
            &image_name,
            "/usr/local/bin/cmux-sandboxd",
            "--bind", "0.0.0.0",
            "--port", &port,
            "--data-dir", "/var/lib/cmux/sandboxes",
        ])
        .status()
        .await?;

    if !status.success() {
        return Err(anyhow::anyhow!("Failed to start container"));
    }

    eprintln!("Waiting for server to be ready...");
    for _ in 0..30 {
        if reqwest::get(format!("http://127.0.0.1:{}/healthz", port)).await.is_ok() {
            eprintln!("Server is up!");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Err(anyhow::anyhow!("Server failed to start within 15s"))
}

async fn handle_server_stop() -> anyhow::Result<()> {
    let container_name = std::env::var("CONTAINER_NAME").unwrap_or_else(|_| "cmux-sandbox-dev-run".into());
    eprintln!("Stopping server container '{}'...", container_name);
    let status = tokio::process::Command::new("docker")
        .args(["rm", "-f", &container_name])
        .status()
        .await?;
    
    if status.success() {
        eprintln!("Server stopped.");
    } else {
        eprintln!("Failed to stop server (maybe it wasn't running?)");
    }
    Ok(())
}

async fn handle_server_status(base_url: &str) -> anyhow::Result<()> {
    let container_name = std::env::var("CONTAINER_NAME").unwrap_or_else(|_| "cmux-sandbox-dev-run".into());
    
    println!("cmux CLI version: {}", env!("CARGO_PKG_VERSION"));
    println!("Server URL: {}", base_url);
    println!("----------------------------------------");

    // 1. Check Docker Container
    let output = tokio::process::Command::new("docker")
        .args(["inspect", "--format", "{{.State.Status}}", &container_name])
        .output()
        .await;

    let container_status = match output {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s == "running" {
                format!("✅ Running ({})", container_name)
            } else {
                format!("⚠️  State: {} ({})", s, container_name)
            }
        }
        _ => format!("❌ Not found / Stopped ({})", container_name),
    };
    println!("Container: {}", container_status);

    // 2. Check Server Health
    let client = Client::builder().timeout(Duration::from_secs(2)).build()?;
    let health_url = format!("{}/healthz", base_url.trim_end_matches('/'));
    let server_health = match client.get(&health_url).send().await {
        Ok(resp) if resp.status().is_success() => "✅ Healthy".to_string(),
        Ok(resp) => format!("⚠️  Unhealthy (Status: {})", resp.status()),
        Err(e) => format!("❌ Unreachable ({})", e),
    };
    println!("Server:    {}", server_health);

    // 3. Check Sandboxes (only if server is healthy)
    if server_health.contains("✅") {
        let sandboxes_url = format!("{}/sandboxes", base_url.trim_end_matches('/'));
        match client.get(&sandboxes_url).send().await {
            Ok(resp) => {
                if let Ok(sandboxes) = resp.json::<Vec<SandboxSummary>>().await {
                    println!("Sandboxes: {} active", sandboxes.len());
                    for s in sandboxes {
                        println!("  - [{}] {} ({:?})", s.id, s.name, s.status);
                    }
                } else {
                    println!("Sandboxes: ❓ Failed to parse response");
                }
            }
            Err(_) => println!("Sandboxes: ❓ Failed to fetch"),
        }
    } else {
        println!("Sandboxes: (server unreachable)");
    }

    Ok(())
}

async fn handle_connection(
    mut socket: tokio::net::TcpStream, 
    base_url: String, 
    id: String, 
    ca: Arc<rcgen::Certificate>
) -> anyhow::Result<()> {
    let mut buf = [0u8; 4096];
    let n = socket.peek(&mut buf).await?;
    if n == 0 { return Ok(()); }
    
    let header = String::from_utf8_lossy(&buf[..n]);
    
    if header.starts_with("CONNECT ") {
        let line = header.lines().next().unwrap_or("");
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 { return Ok(()); }
        let target = parts[1];
        let port = target.split(':').nth(1).unwrap_or("80").parse::<u16>().unwrap_or(80);
        
        let mut trash = [0u8; 4096];
        let mut total_read = 0;
        loop {
             let n_read = socket.read(&mut trash[total_read..]).await?;
             if n_read == 0 { return Ok(()); }
             total_read += n_read;
             if trash[..total_read].windows(4).any(|w| w == b"\r\n\r\n") {
                 break;
             }
             if total_read >= trash.len() { break; } 
        }

        socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
        
        let mut peek_buf = [0u8; 1];
        let n = socket.peek(&mut peek_buf).await?;
        if n > 0 && peek_buf[0] == 0x16 {
            let target_host = target.split(':').next().unwrap_or("localhost");
            
            let mut params = CertificateParams::new(vec![target_host.to_string()]);
            params.distinguished_name.push(DnType::CommonName, target_host);
            params.subject_alt_names = vec![SanType::DnsName(target_host.to_string())];
            
            let cert = rcgen::Certificate::from_params(params)?;
            let cert_der = cert.serialize_der_with_signer(&ca)?;
            let key_der = cert.serialize_private_key_der();
            
            let certs = vec![CertificateDer::from(cert_der)];
            let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der));
             
            let server_config = ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(certs, key)?;
                
            let acceptor = TlsAcceptor::from(Arc::new(server_config));
            let tls_stream = acceptor.accept(socket).await?;
            
            connect_and_tunnel(tls_stream, base_url, id, port, None).await?;
        } else {
            connect_and_tunnel(socket, base_url, id, port, None).await?;
        }
    } else if header.starts_with("GET ") || header.starts_with("POST ") || header.starts_with("PUT ") || header.starts_with("DELETE ") || header.starts_with("HEAD ") || header.starts_with("OPTIONS ") || header.starts_with("PATCH ") {
         // Read headers fully
         let mut header_buf = Vec::new();
         let mut buffer = [0u8; 1];
         let mut state = 0; // 0: normal, 1: \r, 2: \r\n, 3: \r\n\r
         
         loop {
             if socket.read_exact(&mut buffer).await.is_err() { break; }
             header_buf.push(buffer[0]);
             let b = buffer[0];
             if state == 0 && b == b'\r' { state = 1; }
             else if state == 1 && b == b'\n' { state = 2; }
             else if state == 2 && b == b'\r' { state = 3; }
             else if state == 3 && b == b'\n' { break; } // Found \r\n\r\n
             else if b != b'\r' { state = 0; } // Reset if char is not part of sequence
         }
         
         let header_str = String::from_utf8_lossy(&header_buf);
         let lines: Vec<&str> = header_str.lines().collect();
         
         if !lines.is_empty() {
             let request_line = lines[0];
             let parts: Vec<&str> = request_line.split_whitespace().collect();
             if parts.len() >= 2 {
                 let url = parts[1];
                 if let Some(host_start) = url.strip_prefix("http://") {
                     let path_start = host_start.find('/').unwrap_or(host_start.len());
                     let host_port = &host_start[..path_start];
                     let path = if path_start == host_start.len() { "/" } else { &host_start[path_start..] };
                     let port = host_port.split(':').nth(1).unwrap_or("80").parse::<u16>().unwrap_or(80);
                     
                     let method = parts[0];
                     let version = if parts.len() > 2 { parts[2] } else { "HTTP/1.1" };
                     
                     let new_req_line = format!("{} {} {}", method, path, version);
                     
                     // Rebuild headers with Connection: close
                     let mut new_headers = String::new();
                     new_headers.push_str(&new_req_line);
                     new_headers.push_str("\r\n");
                     
                     for line in lines.iter().skip(1) {
                         if line.to_lowercase().starts_with("connection:") || line.to_lowercase().starts_with("proxy-connection:") {
                             continue;
                         }
                         if line.trim().is_empty() { continue; }
                         new_headers.push_str(line);
                         new_headers.push_str("\r\n");
                     }
                     new_headers.push_str("Connection: close\r\n\r\n");
                     
                     connect_and_tunnel(socket, base_url, id, port, Some(new_headers.into_bytes())).await?;
                 }
             }
         }
    }
    
    Ok(())
}

async fn connect_and_tunnel<S>(socket: S, base_url: String, id: String, port: u16, initial_data: Option<Vec<u8>>) -> anyhow::Result<()> 
where S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin {
    let ws_url = base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .trim_end_matches('/')
        .to_string();
    let url = format!("{}/sandboxes/{}/proxy?port={}", ws_url, id, port);
    
    let (ws_stream, _) = connect_async(url).await?;
    let (mut ws_write, mut ws_read) = ws_stream.split();
    let (mut sock_read, mut sock_write) = tokio::io::split(socket);
    
    if let Some(data) = initial_data {
        ws_write.send(Message::Binary(data)).await?;
    }
    
    let mut buf = [0u8; 8192];
    
    loop {
        tokio::select! {
             res = sock_read.read(&mut buf) => {
                 match res {
                     Ok(0) => break,
                     Ok(n) => {
                         ws_write.send(Message::Binary(buf[..n].to_vec())).await?;
                     }
                     Err(_) => break,
                 }
             }
             msg = ws_read.next() => {
                 match msg {
                     Some(Ok(Message::Binary(data))) => {
                         sock_write.write_all(&data).await?;
                     }
                      Some(Ok(Message::Text(data))) => {
                         sock_write.write_all(data.as_bytes()).await?;
                     }
                     Some(Ok(Message::Close(_))) | None => break,
                     _ => {}
                 }
             }
        }
    }
    Ok(())
}
async fn upload_auth_files(client: &Client, base_url: &str, id: &str) -> anyhow::Result<()> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let home_path = PathBuf::from(home);
    let mut files_to_upload = Vec::new();

    for def in AUTH_FILES {
        let path = home_path.join(def.host_path);
        if path.exists() {
            files_to_upload.push((path, def.sandbox_path));
        }
    }

    if files_to_upload.is_empty() {
        return Ok(());
    }

    eprintln!("Uploading {} auth files...", files_to_upload.len());

    // Create a temporary directory structure for the tar
    // We'll upload to /workspace/__cmux_auth_temp and then move
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(10);

    tokio::task::spawn_blocking(move || {
        let writer = ChunkedWriter { sender: tx.clone() };
        let mut tar = Builder::new(writer);
        
        let temp_dir_name = "__cmux_auth_temp";

        for (host_path, sandbox_path_str) in files_to_upload {
            // sandbox_path is absolute, e.g. /root/.codex/auth.json
            // We want to put it in the tar as __cmux_auth_temp/root/.codex/auth.json
            // But tar paths shouldn't start with / usually if we want them relative to extraction point
            // The server extracts to /workspace.
            // So if we put it as "__cmux_auth_temp/...", it extracts to /workspace/__cmux_auth_temp/...
            
            // We need to strip the leading / from sandbox_path for the tar entry
            let sandbox_path = Path::new(sandbox_path_str);
            let rel_sandbox_path = sandbox_path.strip_prefix("/").unwrap_or(sandbox_path);
            
            let tar_path = Path::new(temp_dir_name).join(rel_sandbox_path);

            if let Err(e) = tar.append_path_with_name(&host_path, &tar_path) {
                let _ = tx.blocking_send(Err(e));
                return;
            }
        }
        
        if let Err(e) = tar.finish() {
             let _ = tx.blocking_send(Err(e));
        }
    });

    let body = reqwest::Body::wrap_stream(futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|msg| (msg, rx))
    }));

    let url = format!("{}/sandboxes/{}/files", base_url.trim_end_matches('/'), id);
    let response = client.post(url).body(body).send().await?;
    if !response.status().is_success() {
         return Err(anyhow::anyhow!("Failed to upload auth files: {}", response.status()));
    }

    // Now move files from temp dir to final destination
    // We uploaded to /workspace/__cmux_auth_temp/...
    // We want to move contents of /workspace/__cmux_auth_temp/root/* to /root/
    // and cleanup
    
    let move_script = r#"
        if [ -d /workspace/__cmux_auth_temp ]; then
            cp -r /workspace/__cmux_auth_temp/root/. /root/ 2>/dev/null || true
            rm -rf /workspace/__cmux_auth_temp
        fi
    "#;

    let exec_body = ExecRequest {
        command: vec!["/bin/sh".into(), "-c".into(), move_script.into()],
        workdir: None,
        env: Vec::new(),
    };
    
    let exec_url = format!("{}/sandboxes/{}/exec", base_url.trim_end_matches('/'), id);
    let exec_response = client.post(exec_url).json(&exec_body).send().await?;
    
    if !exec_response.status().is_success() {
        return Err(anyhow::anyhow!("Failed to execute move script: {}", exec_response.status()));
    }

    Ok(())
}

async fn handle_exec_request(client: &Client, base_url: &str, args: ExecArgs) -> anyhow::Result<()> {
    let command = if args.command.len() == 1 && args.command[0].contains(' ') {
        vec!["/bin/sh".into(), "-c".into(), args.command[0].clone()]
    } else {
        args.command
    };
    let body = ExecRequest {
        command,
        workdir: args.workdir,
        env: args.env,
    };
    let url = format!(
        "{}/sandboxes/{}/exec",
        base_url.trim_end_matches('/'),
        args.id
    );
    let response = client.post(url).json(&body).send().await?;
    let result: ExecResponse = parse_response(response).await?;
    print_json(&result)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_value() {
        let env = parse_env("KEY=value").unwrap();
        assert_eq!(env.key, "KEY");
        assert_eq!(env.value, "value");
    }

    #[test]
    fn rejects_invalid_env_value() {
        assert!(parse_env("INVALID").is_err());
    }

    #[test]
    fn exec_single_string_is_wrapped_in_shell() {
        let args = ExecArgs {
            id: "nil".to_string(),
            command: vec!["echo 123".into()],
            workdir: None,
            env: Vec::new(),
        };
        let built = ExecRequest {
            command: if args.command.len() == 1 && args.command[0].contains(' ') {
                vec!["/bin/sh".into(), "-c".into(), args.command[0].clone()]
            } else {
                args.command
            },
            workdir: args.workdir.clone(),
            env: args.env.clone(),
        };
        assert_eq!(built.command, vec!["/bin/sh", "-c", "echo 123"]);
    }
}
