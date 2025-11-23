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

            // Upload current directory
            eprintln!("Uploading current directory...");
            let tarball = pack_current_dir()?;
            let url = format!("{}/sandboxes/{}/files", cli.base_url.trim_end_matches('/'), summary.id);
            let response = client.post(url).body(tarball).send().await?;
            if !response.status().is_success() {
                 eprintln!("Failed to upload files: {}", response.status());
            } else {
                 eprintln!("Files uploaded.");
            }

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

                // Upload current directory
                eprintln!("Uploading current directory...");
                let tarball = pack_current_dir()?;
                let url = format!("{}/sandboxes/{}/files", cli.base_url.trim_end_matches('/'), summary.id);
                let response = client.post(url).body(tarball).send().await?;
                if !response.status().is_success() {
                     eprintln!("Failed to upload files: {}", response.status());
                } else {
                     eprintln!("Files uploaded.");
                }

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

fn pack_current_dir() -> anyhow::Result<Vec<u8>> {
    let mut tar = Builder::new(Vec::new());
    let cwd = std::env::current_dir()?;
    
    let walker = WalkBuilder::new(&cwd).hidden(false).git_ignore(true).build();

    for result in walker {
        let entry = result?;
        let path = entry.path();
        
        if path == cwd {
            continue;
        }

        let relative_path = path.strip_prefix(&cwd)?;
        
        if path.is_dir() {
            tar.append_dir(relative_path, path)?;
        } else {
             tar.append_path_with_name(path, relative_path)?;
        }
    }
    
    tar.into_inner().map_err(|e| anyhow::anyhow!(e))
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
