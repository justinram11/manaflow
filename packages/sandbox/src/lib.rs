pub mod acp_client;
pub mod api;
pub mod bubblewrap;
pub mod errors;
pub mod ip_pool;
pub mod models;
pub mod mux;
pub mod service;

pub use acp_client::{
    load_last_provider, run_chat_tui, run_chat_tui_with_workspace_status, run_demo_tui,
    AcpProvider, WorkspaceSyncStatus,
};
pub use api::build_router;
pub use bubblewrap::BubblewrapService;
pub use mux::run_mux_tui;

pub const DEFAULT_HTTP_PORT: u16 = 46831;
pub const DEFAULT_WS_PORT: u16 = 46832;
