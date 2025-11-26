use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct CreateSandboxRequest {
    pub name: Option<String>,
    /// Host path mounted into /workspace inside the sandbox
    #[schema(example = "/var/lib/cmux/sandboxes/workspaces/<id>")]
    pub workspace: Option<String>,
    #[serde(default)]
    pub read_only_paths: Vec<String>,
    #[serde(default)]
    pub tmpfs: Vec<String>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
pub enum SandboxStatus {
    Running,
    Exited,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct SandboxNetwork {
    pub host_interface: String,
    pub sandbox_interface: String,
    pub host_ip: String,
    pub sandbox_ip: String,
    pub cidr: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct SandboxSummary {
    pub id: Uuid,
    pub index: usize,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub workspace: String,
    pub status: SandboxStatus,
    pub network: SandboxNetwork,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct ExecRequest {
    /// Command arguments executed via nsenter inside the sandbox
    #[schema(example = "[\"/bin/sh\",\"-c\",\"pnpm dev\"]")]
    pub command: Vec<String>,
    #[schema(example = "/workspace")]
    pub workdir: Option<String>,
    #[serde(default)]
    pub env: Vec<EnvVar>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct ExecResponse {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
}

// ============================================================================
// Multiplexed WebSocket Protocol Messages
// ============================================================================

/// Unique identifier for a PTY session within a multiplexed connection.
/// This is a string to allow for flexible ID generation on the client side.
pub type PtySessionId = String;

/// Client-to-server messages for the multiplexed WebSocket protocol.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MuxClientMessage {
    /// Create a new sandbox.
    CreateSandbox {
        /// Optional name for the sandbox.
        #[serde(default)]
        name: Option<String>,
        /// Environment variables to inject into the sandbox.
        #[serde(default)]
        env: Vec<EnvVar>,
    },
    /// List all sandboxes.
    ListSandboxes,
    /// Attach to a sandbox's terminal, creating a new PTY session.
    Attach {
        session_id: PtySessionId,
        sandbox_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        command: Option<Vec<String>>,
        #[serde(default = "default_tty")]
        tty: bool,
    },
    /// Send input data to a PTY session.
    Input {
        session_id: PtySessionId,
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,
    },
    /// Resize a PTY session.
    Resize {
        session_id: PtySessionId,
        cols: u16,
        rows: u16,
    },
    /// Detach from a PTY session (close it).
    Detach { session_id: PtySessionId },
    /// Ping to keep connection alive.
    Ping { timestamp: u64 },
}

/// Server-to-client messages for the multiplexed WebSocket protocol.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MuxServerMessage {
    /// Sandbox was successfully created.
    SandboxCreated(SandboxSummary),
    /// List of all sandboxes.
    SandboxList { sandboxes: Vec<SandboxSummary> },
    /// PTY session was successfully attached.
    Attached { session_id: PtySessionId },
    /// Output data from a PTY session.
    Output {
        session_id: PtySessionId,
        #[serde(with = "base64_bytes")]
        data: Vec<u8>,
    },
    /// PTY session exited.
    Exited {
        session_id: PtySessionId,
        #[serde(default)]
        exit_code: Option<i32>,
    },
    /// Error occurred for a session.
    Error {
        session_id: Option<PtySessionId>,
        message: String,
    },
    /// Pong response to ping.
    Pong { timestamp: u64 },
    /// Request to open a URL on the client (host) machine.
    /// This is sent when a sandbox process calls xdg-open/open-url.
    OpenUrl { url: String },
}

fn default_tty() -> bool {
    true
}

/// Helper module for base64 encoding/decoding of byte vectors in JSON.
mod base64_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = STANDARD.encode(bytes);
        encoded.serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let encoded = String::deserialize(deserializer)?;
        STANDARD.decode(&encoded).map_err(serde::de::Error::custom)
    }
}
