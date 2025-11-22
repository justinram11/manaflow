use clap::{Args, Parser, Subcommand};
use cmux_sandbox::models::{
    CreateSandboxRequest, EnvVar, ExecRequest, ExecResponse, SandboxSummary,
};
use cmux_sandbox::DEFAULT_HTTP_PORT;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use futures::{SinkExt, StreamExt};
use reqwest::Client;
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

#[derive(Parser, Debug)]
#[command(name = "cmux", about = "cmux sandbox controller")]
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
    New,
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
}

#[derive(Subcommand, Debug)]
enum SandboxCommand {
    /// List known sandboxes
    #[command(alias = "ls")]
    List,
    /// Create a new sandbox
    Create(CreateArgs),
    /// Create a new sandbox and attach to it immediately
    New,
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
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if std::env::var("CMUX_DEBUG").is_ok() {
        eprintln!("cmux base url: {}", cli.base_url);
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
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
        Command::New => {
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
            save_last_sandbox(&summary.id.to_string());
            handle_ssh(&cli.base_url, &summary.id.to_string()).await?;
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
            SandboxCommand::New => {
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
                save_last_sandbox(&summary.id.to_string());
                handle_ssh(&cli.base_url, &summary.id.to_string()).await?;
            }
            SandboxCommand::Show { id } => {
                let url = format!("{}/sandboxes/{id}", cli.base_url.trim_end_matches('/'));
                let response = client.get(url).send().await?;
                let summary: SandboxSummary = parse_response(response).await?;
                print_json(&summary)?;
            }
            SandboxCommand::Exec(args) => {
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
                    cli.base_url.trim_end_matches('/'),
                    args.id
                );
                let response = client.post(url).json(&body).send().await?;
                let result: ExecResponse = parse_response(response).await?;
                print_json(&result)?;
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
    let ws_url = base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .trim_end_matches('/')
        .to_string();
    let url = format!("{}/sandboxes/{}/attach", ws_url, id);

    let (ws_stream, _) = connect_async(url).await?;
    eprintln!("Connected to sandbox shell. Press Ctrl+D to exit, or ~. to disconnect.");

    let _guard = RawModeGuard::new()?;

    let (mut write, mut read) = ws_stream.split();
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut buf = [0u8; 1024];

    // State for escape sequence detection
    let mut newline = true;
    let mut tilde_seen = false;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                break;
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        stdout.write_all(&data).await?;
                        stdout.flush().await?;
                        // Simple heuristic: if we received a newline at the end, next input is start of line.
                        // This is imperfect because of local echo vs remote echo, but useful for ~ detection.
                        if let Some(&last) = data.last() {
                             newline = last == b'\r' || last == b'\n';
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        stdout.write_all(text.as_bytes()).await?;
                        stdout.flush().await?;
                        newline = text.ends_with('\r') || text.ends_with('\n');
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
                        let data = &buf[..n];
                        for &b in data {
                            if tilde_seen {
                                if b == b'.' {
                                    // ~. -> Disconnect
                                    // Restore terminal first (by dropping guard, which happens on return)
                                    // But we are in loop. simple break works.
                                    return Ok(());
                                } else {
                                    // Not a dot, so send the tilde and the current char
                                    write.send(Message::Binary(vec![b'~'])).await?;
                                    write.send(Message::Binary(vec![b])).await?;
                                    tilde_seen = false;
                                    newline = b == b'\r' || b == b'\n';
                                }
                            } else if newline && b == b'~' {
                                tilde_seen = true;
                            } else {
                                write.send(Message::Binary(vec![b])).await?;
                                newline = b == b'\r' || b == b'\n';
                            }
                        }
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

fn print_json<T: Serialize>(value: &T) -> anyhow::Result<()> {
    let rendered = serde_json::to_string_pretty(value)?;
    println!("{rendered}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

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