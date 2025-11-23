use crate::errors::{SandboxError, SandboxResult};
use crate::ip_pool::{IpLease, IpPool};
use crate::models::{
    CreateSandboxRequest, ExecRequest, ExecResponse, SandboxNetwork, SandboxStatus, SandboxSummary,
};
use crate::service::SandboxService;
use async_trait::async_trait;
use axum::extract::ws::{Message, WebSocket};
use chrono::{DateTime, Utc};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;
use which::which;

const NETWORK_BASE: Ipv4Addr = Ipv4Addr::new(10, 201, 0, 0);
const HOST_IF_PREFIX: &str = "vethh";
const NS_IF_PREFIX: &str = "vethn";

#[derive(Deserialize)]
struct BwrapStatus {
    #[serde(rename = "child-pid")]
    child_pid: u32,
}

#[derive(Clone, Debug)]
struct SandboxHandle {
    id: Uuid,
    index: usize,
    name: String,
    workspace: PathBuf,
    network: SandboxNetwork,
    created_at: DateTime<Utc>,
    lease: IpLease,
}

#[derive(Clone)]
struct SandboxEntry {
    handle: SandboxHandle,
    child: Arc<Mutex<Child>>,
    inner_pid: u32,
}

pub struct BubblewrapService {
    sandboxes: Mutex<HashMap<Uuid, SandboxEntry>>,
    workspace_root: PathBuf,
    ip_pool: Mutex<IpPool>,
    bubblewrap_path: String,
    ip_path: String,
    iptables_path: String,
    nsenter_path: String,
    port: u16,
    next_index: AtomicUsize,
}

fn nsenter_args(pid: u32, workdir: Option<&str>, command: &[String]) -> Vec<String> {
    let mut args = vec![
        "--target".to_string(),
        pid.to_string(),
        "--mount".to_string(),
        "--uts".to_string(),
        "--ipc".to_string(),
        "--net".to_string(),
        "--pid".to_string(),
    ];

    if let Some(dir) = workdir {
        args.push(format!("--wd={}", dir));
    } else {
        args.push("--wd".to_string());
    }

    args.push("--".to_string());
    args.extend_from_slice(command);

    args
}

impl BubblewrapService {
    pub async fn new(workspace_root: PathBuf, port: u16) -> SandboxResult<Self> {
        if !workspace_root.exists() {
            fs::create_dir_all(&workspace_root).await?;
        }

        let bubblewrap_path = find_binary("bwrap")?;
        let ip_path = find_binary("ip")?;
        let iptables_path = find_binary("iptables")?;
        let nsenter_path = find_binary("nsenter")?;

        let service = Self {
            sandboxes: Mutex::new(HashMap::new()),
            workspace_root,
            ip_pool: Mutex::new(IpPool::new(NETWORK_BASE)),
            bubblewrap_path,
            ip_path,
            iptables_path,
            nsenter_path,
            port,
            next_index: AtomicUsize::new(0),
        };

        service.setup_host_network().await?;
        Ok(service)
    }

    async fn setup_host_network(&self) -> SandboxResult<()> {
        // Enable IP forwarding
        if let Err(e) = run_command("sysctl", &["-w", "net.ipv4.ip_forward=1"]).await {
            warn!("failed to enable ip forwarding (might be already enabled or permission denied): {}", e);
        }

        // Add MASQUERADE rule for sandbox subnet if it doesn't exist
        let subnet = format!("{}/16", NETWORK_BASE);
        
        // Check existence
        let check = run_command(
            &self.iptables_path,
            &["-t", "nat", "-C", "POSTROUTING", "-s", &subnet, "!", "-d", &subnet, "-j", "MASQUERADE"],
        ).await;

        if check.is_err() {
            run_command(
                &self.iptables_path,
                &["-t", "nat", "-A", "POSTROUTING", "-s", &subnet, "!", "-d", &subnet, "-j", "MASQUERADE"],
            ).await?;
        }

        Ok(())
    }

    fn default_name(id: &Uuid) -> String {
        let mut buffer = Uuid::encode_buffer();
        let encoded = id.as_simple().encode_lower(&mut buffer);
        let slug = encoded.get(0..8).unwrap_or("sandbox");
        format!("sandbox-{slug}")
    }

    fn resolve_workspace(&self, request: &CreateSandboxRequest, id: &Uuid) -> PathBuf {
        if let Some(raw) = &request.workspace {
            let path = PathBuf::from(raw);
            if path.is_absolute() {
                return path;
            }

            return self.workspace_root.join(path);
        }

        self.workspace_root.join(id.to_string()).join("workspace")
    }

    async fn resolve_id(&self, id_str: &str) -> SandboxResult<Uuid> {
        // 1. Try parsing as full UUID
        if let Ok(uuid) = Uuid::parse_str(id_str) {
            return Ok(uuid);
        }

        // 2. Try parsing as integer index
        if let Ok(index) = id_str.parse::<usize>() {
            let guard = self.sandboxes.lock().await;
            for (uuid, entry) in guard.iter() {
                if entry.handle.index == index {
                    return Ok(*uuid);
                }
            }
        }

        // 3. Try searching by prefix
        let guard = self.sandboxes.lock().await;
        let mut matched = None;
        for (uuid, _) in guard.iter() {
            let simple = uuid.simple().to_string();
            if simple.starts_with(id_str) {
                if matched.is_some() {
                    return Err(SandboxError::InvalidRequest(format!(
                        "ambiguous short id: {id_str}"
                    )));
                }
                matched = Some(*uuid);
            }
        }

        matched.ok_or_else(|| SandboxError::InvalidRequest(format!("sandbox not found: {id_str}")))
    }

    async fn setup_dns(&self, etc_merged: &Path) -> SandboxResult<()> {
        let resolv_conf_path = etc_merged.join("resolv.conf");

        // Read host's resolv.conf (following symlinks/mounts)
        let content = match fs::read_to_string("/etc/resolv.conf").await {
            Ok(c) => c,
            Err(_) => "nameserver 8.8.8.8\nnameserver 1.1.1.1".to_string(),
        };

        // Filter out local resolvers that won't work in sandbox
        let filtered_lines: Vec<&str> = content
            .lines()
            .filter(|l| !l.contains("127.0.0.53") && !l.contains("127.0.0.1"))
            .collect();

        let final_content = if filtered_lines.is_empty() {
            "nameserver 8.8.8.8\nnameserver 1.1.1.1".to_string()
        } else {
            filtered_lines.join("\n")
        };

        fs::write(&resolv_conf_path, final_content).await?;
        Ok(())
    }

    async fn setup_hosts(&self, etc_merged: &Path, hostname: &str) -> SandboxResult<()> {
        let hosts_path = etc_merged.join("hosts");
        let content = format!("127.0.0.1\tlocalhost\n127.0.0.1\t{}\n", hostname);
        fs::write(&hosts_path, content).await?;
        Ok(())
    }

    async fn setup_apt(&self, etc_merged: &Path) -> SandboxResult<()> {
        let apt_conf_dir = etc_merged.join("apt/apt.conf.d");
        // Ensure directory exists (it might be a new directory in the upper layer if copy-up happens, 
        // or we might need to create it if it doesn't exist in lower, though it should)
        fs::create_dir_all(&apt_conf_dir).await?;
        
        let conf_path = apt_conf_dir.join("99sandbox");
        let content = "Acquire::PrivilegeDrop::User \"root\";\n";
        fs::write(&conf_path, content).await?;
        Ok(())
    }

    async fn setup_bashrc(&self, root_merged: &Path) -> SandboxResult<()> {
        let root_home = root_merged.join("root");
        fs::create_dir_all(&root_home).await?;
        
        let bashrc = root_home.join(".bashrc");
        let content = r#"
# ~/.bashrc: executed by bash(1) for non-login shells.

# If not running interactively, don't do anything
[ -z "$PS1" ] && return

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize

# set a fancy prompt (non-color, unless we know we "want" color)
case "$TERM" in
    xterm-color|*-256color) color_prompt=yes;;
esac

if [ "$color_prompt" = yes ]; then
    PS1='${debian_chroot:+($debian_chroot)}\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]# '
else
    PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w# '
fi
unset color_prompt force_color_prompt

# enable color support of ls and also add handy aliases
if [ -x /usr/bin/dircolors ]; then
    test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
    alias ls='ls --color=auto'
    alias grep='grep --color=auto'
    alias fgrep='fgrep --color=auto'
    alias egrep='egrep --color=auto'
fi

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

alias g=git
"#;
        fs::write(&bashrc, content).await?;
        Ok(())
    }

    async fn spawn_bubblewrap(
        &self,
        request: &CreateSandboxRequest,
        workspace: &Path,
        _id: &Uuid,
        lease: &IpLease,
        index: usize,
    ) -> SandboxResult<(Child, u32)> {
        // Prepare system directories for the sandbox
        let system_dir = workspace.join(".system");
        fs::create_dir_all(&system_dir).await?;

        // Setup overlays
        let usr_merged = mount_overlay(&system_dir, "usr", "/usr").await?;
        let etc_merged = mount_overlay(&system_dir, "etc", "/etc").await?;
        let var_merged = mount_overlay(&system_dir, "var", "/var").await?;
        
        let root_merged = system_dir.join("root-merged");
        fs::create_dir_all(&root_merged).await?;
        self.setup_bashrc(&root_merged).await?;

        // Ensure we have valid DNS and hosts file in the overlay
        self.setup_dns(&etc_merged).await?;
        self.setup_hosts(&etc_merged, &format!("sandbox-{}", index)).await?;
        self.setup_apt(&etc_merged).await?;

        let workspace_str = workspace
            .to_str()
            .ok_or_else(|| {
                SandboxError::InvalidRequest("workspace path is not valid UTF-8".into())
            })?
            .to_owned();

        let mut command = Command::new(&self.bubblewrap_path);
        command.kill_on_drop(true);
        command.stdout(Stdio::piped());
        command.args([
            "--die-with-parent",
            "--unshare-net",
            "--unshare-pid",
            "--unshare-uts",
            "--unshare-ipc",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--perms",
            "1777",
            "--tmpfs",
            "/tmp",
            "--perms",
            "1777",
            "--tmpfs",
            "/var/tmp",
            "--tmpfs",
            "/run",
            "--bind",
            &workspace_str,
            "/workspace",
            "--chdir",
            "/workspace",
            "--hostname",
            &format!("sandbox-{}", index),
            "--json-status-fd",
            "1",
        ]);

        // Bind overlays
        command.args(["--bind", usr_merged.to_str().unwrap(), "/usr"]);
        command.args(["--bind", etc_merged.to_str().unwrap(), "/etc"]);
        command.args(["--bind", var_merged.to_str().unwrap(), "/var"]);
        
        // Note: setup_bashrc wrote to root-merged/root/.bashrc
        command.args(["--bind", root_merged.join("root").to_str().unwrap(), "/root"]);

        // Hide sensitive host paths exposed via /var overlay
        command.args(["--tmpfs", "/var/lib/docker"]);
        command.args(["--tmpfs", "/var/lib/cmux"]);

        for path_str in ["/bin", "/sbin", "/lib", "/lib64"] {
            let path = Path::new(path_str);
            if !path.exists() {
                continue;
            }

            match fs::symlink_metadata(path).await {
                Ok(meta) if meta.file_type().is_symlink() => {
                    if let Ok(target) = fs::read_link(path).await {
                        command.args(["--symlink", &target.to_string_lossy(), path_str]);
                    }
                }
                Ok(_) => {
                    command.args(["--ro-bind", path_str, path_str]);
                }
                Err(_) => {}
            }
        }

        for path in &request.read_only_paths {
            command.args(["--ro-bind", path, path]);
        }

        for mount in &request.tmpfs {
            command.args(["--tmpfs", mount]);
        }

        for env in &request.env {
            command.env(&env.key, &env.value);
        }

        command.env(
            "CMUX_SANDBOX_URL",
            format!("http://{}:{}", lease.host, self.port),
        );

        command.args(["--", "/bin/sh", "-c", "ip link set lo up && sleep infinity"]);

        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SandboxError::Internal("failed to capture bwrap stdout".into()))?;

        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).await?;

        let status: BwrapStatus = serde_json::from_str(&line).map_err(|e| {
            SandboxError::Internal(format!("failed to parse bwrap status: {e}, line: {line}"))
        })?;

        Ok((child, status.child_pid))
    }

    async fn configure_network(
        &self,
        pid: u32,
        lease: &IpLease,
        id: &Uuid,
    ) -> SandboxResult<SandboxNetwork> {
        let formatted_pid = pid.to_string();
        let (host_if, ns_if) = make_interface_names(id);
        let host_cidr = format!("{}/{}", lease.host, lease.cidr);
        let sandbox_cidr = format!("{}/{}", lease.sandbox, lease.cidr);

        run_command(
            &self.ip_path,
            &[
                "link", "add", &host_if, "type", "veth", "peer", "name", &ns_if,
            ],
        )
        .await?;
        run_command(&self.ip_path, &["addr", "add", &host_cidr, "dev", &host_if]).await?;
        run_command(&self.ip_path, &["link", "set", &host_if, "up"]).await?;
        run_command(
            &self.ip_path,
            &["link", "set", &ns_if, "netns", &formatted_pid],
        )
        .await?;

        run_command(
            &self.nsenter_path,
            &[
                "--target",
                &formatted_pid,
                "--net",
                "--",
                "ip",
                "addr",
                "add",
                &sandbox_cidr,
                "dev",
                &ns_if,
            ],
        )
        .await?;

        run_command(
            &self.nsenter_path,
            &[
                "--target",
                &formatted_pid,
                "--net",
                "--",
                "ip",
                "link",
                "set",
                &ns_if,
                "up",
            ],
        )
        .await?;
        run_command(
            &self.nsenter_path,
            &[
                "--target",
                &formatted_pid,
                "--net",
                "--",
                "ip",
                "link",
                "set",
                "lo",
                "up",
            ],
        )
        .await?;
        run_command(
            &self.nsenter_path,
            &[
                "--target",
                &formatted_pid,
                "--net",
                "--",
                "ip",
                "route",
                "replace",
                "default",
                "via",
                &lease.host.to_string(),
            ],
        )
        .await?;

        Ok(SandboxNetwork {
            host_interface: host_if,
            sandbox_interface: ns_if,
            host_ip: lease.host.to_string(),
            sandbox_ip: lease.sandbox.to_string(),
            cidr: lease.cidr,
        })
    }

    async fn teardown_network(&self, network: &SandboxNetwork) {
        let delete_result =
            run_command(&self.ip_path, &["link", "del", &network.host_interface]).await;
        if let Err(error) = delete_result {
            warn!(
                "failed to delete interface {}: {error}",
                network.host_interface
            );
        }
    }

    async fn workspace_summary(
        entry: &SandboxEntry,
        child: &mut Child,
    ) -> SandboxResult<SandboxSummary> {
        let status = match child.try_wait()? {
            None => SandboxStatus::Running,
            Some(exit_status) => {
                if exit_status.success() {
                    SandboxStatus::Exited
                } else {
                    SandboxStatus::Failed
                }
            }
        };

        Ok(entry.handle.to_summary(status))
    }
}

fn find_binary(name: &str) -> SandboxResult<String> {
    let binary_path = which(name)
        .map_err(|_| SandboxError::MissingBinary(name.to_owned()))?
        .to_string_lossy()
        .to_string();
    Ok(binary_path)
}

fn make_interface_names(id: &Uuid) -> (String, String) {
    let mut buffer = Uuid::encode_buffer();
    let encoded = id.as_simple().encode_lower(&mut buffer);
    let short = encoded.get(0..8).unwrap_or("ns");
    (
        format!("{HOST_IF_PREFIX}-{short}"),
        format!("{NS_IF_PREFIX}-{short}"),
    )
}

#[async_trait]
impl SandboxService for BubblewrapService {
    async fn create(&self, request: CreateSandboxRequest) -> SandboxResult<SandboxSummary> {
        let id = Uuid::new_v4();
        let index = self.next_index.fetch_add(1, Ordering::Relaxed);
        let name = request
            .name
            .clone()
            .unwrap_or_else(|| Self::default_name(&id));
        let workspace = self.resolve_workspace(&request, &id);
        fs::create_dir_all(&workspace).await?;

        let lease = {
            let mut pool = self.ip_pool.lock().await;
            pool.allocate()?
        };

        let (mut child, inner_pid) = match self
            .spawn_bubblewrap(&request, &workspace, &id, &lease, index)
            .await
        {
            Ok(res) => res,
            Err(error) => {
                cleanup_overlays(&workspace).await;
                let mut pool = self.ip_pool.lock().await;
                pool.release(&lease);
                return Err(error);
            }
        };

        let network = match self.configure_network(inner_pid, &lease, &id).await {
            Ok(net) => net,
            Err(error) => {
                let _ = child.kill().await;
                cleanup_overlays(&workspace).await;
                {
                    let mut pool = self.ip_pool.lock().await;
                    pool.release(&lease);
                }
                return Err(error);
            }
        };

        let handle = SandboxHandle {
            id,
            index,
            name,
            workspace,
            network,
            created_at: Utc::now(),
            lease,
        };

        let entry = SandboxEntry {
            handle,
            child: Arc::new(Mutex::new(child)),
            inner_pid,
        };

        let summary = {
            let mut child = entry.child.lock().await;
            Self::workspace_summary(&entry, &mut child).await?
        };

        let mut sandboxes = self.sandboxes.lock().await;
        sandboxes.insert(id, entry);
        info!("created sandbox {id}");
        Ok(summary)
    }

    async fn list(&self) -> SandboxResult<Vec<SandboxSummary>> {
        let entries: Vec<SandboxEntry> = {
            let guard = self.sandboxes.lock().await;
            guard.values().cloned().collect()
        };

        let mut results = Vec::with_capacity(entries.len());
        for entry in entries {
            let mut child = entry.child.lock().await;
            results.push(Self::workspace_summary(&entry, &mut child).await?);
        }
        
        // Sort by index to keep stable order
        results.sort_by_key(|s| s.index);

        Ok(results)
    }

    async fn get(&self, id_str: String) -> SandboxResult<Option<SandboxSummary>> {
        let id = match self.resolve_id(&id_str).await {
            Ok(id) => id,
            Err(_) => return Ok(None),
        };

        let entry = {
            let sandboxes = self.sandboxes.lock().await;
            sandboxes.get(&id).cloned()
        };

        if let Some(entry) = entry {
            let mut child = entry.child.lock().await;
            let summary = Self::workspace_summary(&entry, &mut child).await?;
            return Ok(Some(summary));
        }

        Ok(None)
    }

    async fn exec(&self, id_str: String, exec: ExecRequest) -> SandboxResult<ExecResponse> {
        let id = self.resolve_id(&id_str).await?;

        if exec.command.is_empty() {
            return Err(SandboxError::InvalidRequest(
                "exec.command must not be empty".into(),
            ));
        }

        let entry = {
            let sandboxes = self.sandboxes.lock().await;
            sandboxes.get(&id).cloned()
        }
        .ok_or(SandboxError::NotFound(id))?;

        let mut command = Command::new(&self.nsenter_path);
        for env in &exec.env {
            command.env(&env.key, &env.value);
        }

        command.args(nsenter_args(
            entry.inner_pid,
            exec.workdir.as_deref(),
            &exec.command,
        ));

        command.kill_on_drop(true);
        let output = command.output().await?;
        let exit_code = output.status.code().unwrap_or_default();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(ExecResponse {
            exit_code,
            stdout,
            stderr,
        })
    }

    async fn attach(&self, id_str: String, mut socket: WebSocket, initial_size: Option<(u16, u16)>) -> SandboxResult<()> {
        let id = self.resolve_id(&id_str).await?;
        let entry = {
            let sandboxes = self.sandboxes.lock().await;
            sandboxes.get(&id).cloned()
        }
        .ok_or(SandboxError::NotFound(id))?;

        let (cols, rows) = initial_size.unwrap_or((80, 24));

        let system = NativePtySystem::default();
        let pair = system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| SandboxError::Internal(format!("failed to open pty: {e}")))?;

        let mut cmd = CommandBuilder::new(&self.nsenter_path);
        cmd.args(nsenter_args(
            entry.inner_pid,
            None,
            &["/bin/bash".to_string(), "-i".to_string()],
        ));
        cmd.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| SandboxError::Internal(format!("failed to spawn pty command: {e}")))?;
        // Release slave so it closes when child exits
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| SandboxError::Internal(format!("failed to clone pty reader: {e}")))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| SandboxError::Internal(format!("failed to take pty writer: {e}")))?;

        let (tx_out, mut rx_out) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
        let (tx_in, mut rx_in) = tokio::sync::mpsc::channel::<Vec<u8>>(32);

        // Reader thread
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx_out.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Writer thread
        std::thread::spawn(move || {
            while let Some(data) = rx_in.blocking_recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(100));

        // WebSocket bridge
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Ok(Some(_)) = child.try_wait() {
                        break;
                    }
                }
                msg = socket.recv() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if text.starts_with("resize:") {
                                let parts: Vec<&str> = text.split(':').collect();
                                if parts.len() == 3 {
                                    if let (Ok(rows), Ok(cols)) = (parts[1].parse::<u16>(), parts[2].parse::<u16>()) {
                                        let _ = pair.master.resize(PtySize {
                                            rows,
                                            cols,
                                            pixel_width: 0,
                                            pixel_height: 0,
                                        });
                                    }
                                }
                            } else if tx_in.send(text.as_bytes().to_vec()).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Binary(data))) => {
                            if tx_in.send(data.into()).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        _ => {}
                    }
                }
                data = rx_out.recv() => {
                    match data {
                        Some(d) => {
                            if socket.send(Message::Binary(d.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
        }

        // Kill child on exit
        let _ = child.kill();
        let _ = child.wait();

        Ok(())
    }

    async fn proxy(&self, id_str: String, port: u16, mut socket: WebSocket) -> SandboxResult<()> {
        let id = self.resolve_id(&id_str).await?;
        let entry = {
            let sandboxes = self.sandboxes.lock().await;
            sandboxes.get(&id).cloned()
        }
        .ok_or(SandboxError::NotFound(id))?;

        let target_address = format!("127.0.0.1:{}", port);
        
        let mut command = Command::new(&self.nsenter_path);
        command.args(nsenter_args(
            entry.inner_pid,
            None,
            &["cmux".to_string(), "_internal-proxy".to_string(), target_address],
        ));
        
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::inherit()); 
        
        command.kill_on_drop(true);
        
        let mut child = command.spawn()?;
        
        let mut stdin = child.stdin.take().ok_or(SandboxError::Internal("failed to open stdin".into()))?;
        let mut stdout = child.stdout.take().ok_or(SandboxError::Internal("failed to open stdout".into()))?;
        
        let mut buf = [0u8; 8192];

        loop {
            tokio::select! {
                res = stdout.read(&mut buf) => {
                    match res {
                        Ok(0) => break, 
                        Ok(n) => {
                            if socket.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                msg = socket.recv() => {
                    match msg {
                        Some(Ok(Message::Binary(data))) => {
                            if stdin.write_all(&data).await.is_err() { break; }
                            if stdin.flush().await.is_err() { break; }
                        }
                        Some(Ok(Message::Text(text))) => {
                            if stdin.write_all(text.as_bytes()).await.is_err() { break; }
                            if stdin.flush().await.is_err() { break; }
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        _ => {}
                    }
                }
            }
        }
        
        let _ = child.kill().await;
        Ok(())
    }

    async fn upload_archive(&self, id_str: String, archive: Vec<u8>) -> SandboxResult<()> {
        let id = self.resolve_id(&id_str).await?;
        let entry = {
            let sandboxes = self.sandboxes.lock().await;
            sandboxes.get(&id).cloned()
        }
        .ok_or(SandboxError::NotFound(id))?;

        let workspace = entry.handle.workspace;
        
        tokio::task::spawn_blocking(move || {
            let mut ar = tar::Archive::new(&archive[..]);
            ar.unpack(&workspace).map_err(|e| SandboxError::Internal(format!("failed to unpack archive: {e}")))
        })
        .await
        .map_err(|e| SandboxError::Internal(format!("join error: {e}")))?
    }

    async fn delete(&self, id_str: String) -> SandboxResult<Option<SandboxSummary>> {
        let id = self.resolve_id(&id_str).await?;
        let entry = {
            let mut sandboxes = self.sandboxes.lock().await;
            sandboxes.remove(&id)
        };

        if let Some(entry) = entry {
            {
                let mut pool = self.ip_pool.lock().await;
                pool.release(&entry.handle.lease);
            }

            self.teardown_network(&entry.handle.network).await;

            let mut child = entry.child.lock().await;
            let observed_status = match child.try_wait()? {
                None => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    SandboxStatus::Exited
                }
                Some(exit) => {
                    if exit.success() {
                        SandboxStatus::Exited
                    } else {
                        SandboxStatus::Failed
                    }
                }
            };

            let summary = entry.handle.to_summary(observed_status);
            
            cleanup_overlays(&entry.handle.workspace).await;

            if entry.handle.workspace.starts_with(&self.workspace_root) {
                if let Err(error) = fs::remove_dir_all(&entry.handle.workspace).await {
                    warn!(
                        "failed to remove workspace {}: {error}",
                        entry.handle.workspace.display()
                    );
                }
            }

            info!("removed sandbox {id}");
            return Ok(Some(summary));
        }

        Ok(None)
    }
}

impl SandboxHandle {
    fn to_summary(&self, status: SandboxStatus) -> SandboxSummary {
        SandboxSummary {
            id: self.id,
            index: self.index,
            name: self.name.clone(),
            created_at: self.created_at,
            workspace: self.workspace.to_string_lossy().to_string(),
            status,
            network: self.network.clone(),
        }
    }
}

async fn run_command(binary: &str, args: &[&str]) -> SandboxResult<()> {
    let output = Command::new(binary).args(args).output().await?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Err(SandboxError::CommandFailed {
        command: format!("{binary} {}", args.join(" ")),
        message: stderr,
    })
}

async fn mount_overlay(
    system_dir: &Path,
    name: &str,
    lower: &str,
) -> SandboxResult<PathBuf> {
    let upper = system_dir.join(format!("{}-upper", name));
    let work = system_dir.join(format!("{}-work", name));
    let merged = system_dir.join(format!("{}-merged", name));

    fs::create_dir_all(&upper).await?;
    fs::create_dir_all(&work).await?;
    fs::create_dir_all(&merged).await?;

    let opts = format!(
        "lowerdir={},upperdir={},workdir={}",
        lower,
        upper.to_string_lossy(),
        work.to_string_lossy()
    );

    run_command(
        "mount",
        &[
            "-t",
            "overlay",
            "overlay",
            "-o",
            &opts,
            merged.to_str().unwrap(),
        ],
    )
    .await?;

    Ok(merged)
}

async fn cleanup_overlays(workspace: &Path) {
    let system_dir = workspace.join(".system");
    let _ = run_command("umount", &[system_dir.join("var-merged").to_string_lossy().as_ref()]).await;
    let _ = run_command("umount", &[system_dir.join("etc-merged").to_string_lossy().as_ref()]).await;
    let _ = run_command("umount", &[system_dir.join("usr-merged").to_string_lossy().as_ref()]).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interface_names_are_short() {
        let id = Uuid::new_v4();
        let (host_if, ns_if) = make_interface_names(&id);
        assert!(host_if.len() <= 15);
        assert!(ns_if.len() <= 15);
    }

    #[test]
    fn nsenter_args_defaults() {
        let args = nsenter_args(123, None, &["ls".to_string()]);
        assert!(args.contains(&"--target".to_string()));
        assert!(args.contains(&"123".to_string()));
        assert!(args.contains(&"--wd".to_string()));

        // Verify structure: --target 123 ... --wd -- ls
        let wd_idx = args.iter().position(|s| s == "--wd").unwrap();
        let double_dash_idx = args.iter().position(|s| s == "--").unwrap();
        let ls_idx = args.iter().position(|s| s == "ls").unwrap();

        assert!(wd_idx < double_dash_idx);
        assert!(double_dash_idx < ls_idx);
    }

    #[test]
    fn nsenter_args_custom_workdir() {
        let args = nsenter_args(123, Some("/custom"), &["ls".to_string()]);
        assert!(args.contains(&"--wd=/custom".to_string()));

        let wd_idx = args.iter().position(|s| s == "--wd=/custom").unwrap();
        let double_dash_idx = args.iter().position(|s| s == "--").unwrap();

        assert!(wd_idx < double_dash_idx);
    }
}