use crate::models::SandboxSummary;

/// Events that can occur in the multiplexer.
#[derive(Debug, Clone)]
pub enum MuxEvent {
    /// Sandbox list was refreshed.
    SandboxesRefreshed(Vec<SandboxSummary>),
    /// Failed to refresh sandboxes.
    SandboxRefreshFailed(String),
    /// A sandbox was created.
    SandboxCreated(SandboxSummary),
    /// A sandbox was deleted.
    SandboxDeleted(String),
    /// Connection to a sandbox changed.
    SandboxConnectionChanged { sandbox_id: String, connected: bool },
    /// Terminal output received.
    TerminalOutput {
        pane_id: crate::mux::layout::PaneId,
        data: Vec<u8>,
    },
    /// An error occurred.
    Error(String),
    /// A system notification to display.
    Notification {
        message: String,
        level: NotificationLevel,
    },
    /// Request to connect to a sandbox (used for auto-connect on startup)
    ConnectToSandbox { sandbox_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationLevel {
    Info,
    Warning,
    Error,
}
