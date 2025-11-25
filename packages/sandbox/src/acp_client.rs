use agent_client_protocol::{
    Agent, Client, ClientCapabilities, ClientSideConnection, ContentBlock, CreateTerminalRequest,
    CreateTerminalResponse, Error, FileSystemCapability, InitializeRequest,
    KillTerminalCommandRequest, KillTerminalCommandResponse, ModelId, NewSessionRequest,
    PermissionOptionId, Plan, PlanEntryPriority, PlanEntryStatus, PromptRequest,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SessionId,
    SessionModelState, SessionNotification, SessionUpdate, SetSessionModelRequest,
    TerminalOutputRequest, TerminalOutputResponse, TextContent, ToolCall, ToolCallStatus,
    ToolCallUpdate, ToolKind, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
    WriteTextFileRequest, WriteTextFileResponse, V1,
};
use anyhow::Result;
use clap::ValueEnum;

/// Available ACP (Agent Client Protocol) providers
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, ValueEnum)]
pub enum AcpProvider {
    /// OpenAI Codex CLI ACP - `codex-acp`
    #[default]
    Codex,
    /// OpenCode ACP - `opencode acp`
    Opencode,
    /// Claude Code ACP - `claude-code-acp`
    Claude,
    /// Gemini CLI ACP - `gemini --experimental-acp`
    Gemini,
}

impl AcpProvider {
    /// Get all available providers for display in the command palette
    pub fn all() -> &'static [AcpProvider] {
        &[
            AcpProvider::Codex,
            AcpProvider::Opencode,
            AcpProvider::Claude,
            AcpProvider::Gemini,
        ]
    }

    /// Get the display name for this provider
    pub fn display_name(&self) -> &'static str {
        match self {
            AcpProvider::Codex => "Codex CLI",
            AcpProvider::Opencode => "OpenCode",
            AcpProvider::Claude => "Claude Code",
            AcpProvider::Gemini => "Gemini CLI",
        }
    }

    /// Get the command to execute for this provider
    /// Commands are wrapped with stdbuf for unbuffered I/O
    pub fn command(&self) -> &'static str {
        match self {
            AcpProvider::Codex => {
                "/usr/bin/stdbuf -i0 -o0 -e0 /usr/local/bin/codex-acp -c approval_policy=\"never\" -c sandbox_mode=\"danger-full-access\" -c model=\"gpt-5.1-codex-max\""
            }
            AcpProvider::Opencode => "/usr/bin/stdbuf -i0 -o0 -e0 opencode acp",
            AcpProvider::Claude => "/usr/bin/stdbuf -i0 -o0 -e0 claude-code-acp",
            AcpProvider::Gemini => "/usr/bin/stdbuf -i0 -o0 -e0 gemini --experimental-acp",
        }
    }

    /// Get a short identifier for this provider
    pub fn short_name(&self) -> &'static str {
        match self {
            AcpProvider::Codex => "codex",
            AcpProvider::Opencode => "opencode",
            AcpProvider::Claude => "claude",
            AcpProvider::Gemini => "gemini",
        }
    }

    /// Parse a short name back to AcpProvider
    pub fn from_short_name(name: &str) -> Option<AcpProvider> {
        match name {
            "codex" => Some(AcpProvider::Codex),
            "opencode" => Some(AcpProvider::Opencode),
            "claude" => Some(AcpProvider::Claude),
            "gemini" => Some(AcpProvider::Gemini),
            _ => None,
        }
    }
}

use std::collections::HashMap;
use std::path::PathBuf;

/// Get the cmux config directory (~/.cmux)
fn get_config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".cmux")
}

/// Load the last used ACP provider from config
pub fn load_last_provider() -> Option<AcpProvider> {
    let path = get_config_dir().join("last_acp_provider");
    if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| AcpProvider::from_short_name(s.trim()))
    } else {
        None
    }
}

/// Save the last used ACP provider to config
fn save_last_provider(provider: AcpProvider) {
    let dir = get_config_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let path = dir.join("last_acp_provider");
    let _ = std::fs::write(path, provider.short_name());
}

/// Load the last used model ID for a specific provider
fn load_last_model(provider: AcpProvider) -> Option<String> {
    let path = get_config_dir().join(format!("last_model_{}", provider.short_name()));
    if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    }
}

/// Save the last used model ID for a specific provider
fn save_last_model(provider: AcpProvider, model_id: &str) {
    let dir = get_config_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let path = dir.join(format!("last_model_{}", provider.short_name()));
    let _ = std::fs::write(path, model_id);
}

use crossterm::{
    event::{
        DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, EventStream, KeyCode, KeyModifiers, MouseEventKind,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::{SinkExt, StreamExt};
use pulldown_cmark::{Event as MdEvent, Options, Parser, Tag, TagEnd};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Terminal,
};
use std::borrow::Cow;
use std::sync::LazyLock;
use std::{fs::OpenOptions, io, io::Write, sync::Arc};
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use tokio::sync::mpsc;
use tui_textarea::TextArea;

// Use two-face's extended syntax set which includes TypeScript, Kotlin, Swift, etc.
static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(two_face::syntax::extra_newlines);
static THEME_SET: LazyLock<ThemeSet> = LazyLock::new(ThemeSet::load_defaults);

/// Detect if terminal is in dark mode (cached at startup)
static IS_DARK_MODE: LazyLock<bool> = LazyLock::new(|| {
    match terminal_light::luma() {
        Ok(luma) if luma > 0.5 => false, // Light background
        Ok(_) => true,                   // Dark background
        Err(_) => true,                  // Default to dark mode if detection fails
    }
});

/// Get background color for user messages based on terminal mode
fn user_message_bg_color() -> ratatui::style::Color {
    if *IS_DARK_MODE {
        ratatui::style::Color::Rgb(60, 60, 60) // Lighter gray for dark mode
    } else {
        ratatui::style::Color::Rgb(230, 230, 230) // Darker gray for light mode
    }
}

fn log_debug(msg: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/cmux-chat.log")
    {
        let _ = writeln!(file, "[{}] {}", chrono::Utc::now().to_rfc3339(), msg);
    }
}

struct AppClient {
    tx: mpsc::UnboundedSender<AppEvent>,
}

enum AppEvent {
    SessionUpdate(Box<SessionNotification>),
    DebugMessage {
        direction: String,
        message: String,
    },
    /// Provider switch completed successfully
    ProviderSwitchComplete {
        provider: AcpProvider,
        connection: Arc<ClientSideConnection>,
        session_id: SessionId,
        model_state: Option<SessionModelState>,
    },
    /// Provider switch failed
    ProviderSwitchFailed {
        provider: AcpProvider,
        error: String,
    },
    /// Model switch completed successfully
    ModelSwitchComplete {
        model_id: ModelId,
    },
    /// Model switch failed
    ModelSwitchFailed {
        error: String,
    },
    /// ACP request error (prompt, tool calls, etc.)
    RequestError {
        error: String,
    },
    /// Models loaded for a provider (for the model picker)
    ProviderModelsLoaded {
        provider: AcpProvider,
        /// List of (model_id, display_name) pairs
        models: Vec<(String, String)>,
    },
    /// Failed to load models for a provider
    ProviderModelsLoadFailed {
        provider: AcpProvider,
    },
}

#[async_trait::async_trait(?Send)]
impl Client for AppClient {
    async fn request_permission(
        &self,
        request: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse, Error> {
        log_debug(&format!("RequestPermission: {:?}", request));
        let option_id = request
            .options
            .first()
            .map(|o| o.id.clone())
            .unwrap_or(PermissionOptionId("allow".into()));

        Ok(RequestPermissionResponse {
            outcome: RequestPermissionOutcome::Selected { option_id },
            meta: None,
        })
    }

    async fn read_text_file(
        &self,
        request: ReadTextFileRequest,
    ) -> Result<ReadTextFileResponse, Error> {
        log_debug(&format!("ReadTextFile: {:?}", request.path));
        match tokio::fs::read_to_string(&request.path).await {
            Ok(content) => Ok(ReadTextFileResponse {
                content,
                meta: None,
            }),
            Err(e) => {
                log_debug(&format!("ReadTextFile Error: {}", e));
                Err(Error::internal_error().with_data(e.to_string()))
            }
        }
    }

    async fn write_text_file(
        &self,
        request: WriteTextFileRequest,
    ) -> Result<WriteTextFileResponse, Error> {
        log_debug(&format!("WriteTextFile: {:?}", request.path));
        match tokio::fs::write(&request.path, &request.content).await {
            Ok(_) => Ok(WriteTextFileResponse::default()),
            Err(e) => Err(Error::internal_error().with_data(e.to_string())),
        }
    }

    async fn create_terminal(
        &self,
        _request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, Error> {
        Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn terminal_output(
        &self,
        _request: TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, Error> {
        Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn release_terminal(
        &self,
        _request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, Error> {
        Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn wait_for_terminal_exit(
        &self,
        _request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, Error> {
        Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn kill_terminal_command(
        &self,
        _request: KillTerminalCommandRequest,
    ) -> Result<KillTerminalCommandResponse, Error> {
        Err(Error::internal_error().with_data("Terminal not supported yet"))
    }

    async fn session_notification(&self, notification: SessionNotification) -> Result<(), Error> {
        log_debug(&format!("SessionNotification: {:?}", notification));
        let _ = self
            .tx
            .send(AppEvent::SessionUpdate(Box::new(notification)));
        Ok(())
    }
}

/// Different types of chat entries displayed in the TUI
#[derive(Clone)]
enum ChatEntry {
    /// Text message from user, agent, or thought
    Message {
        role: String,
        text: String,
        normalized_markdown: Option<String>,
    },
    /// Tool call notification
    ToolCall {
        id: String,
        title: String,
        kind: ToolKind,
        status: ToolCallStatus,
    },
    /// Execution plan
    Plan(Plan),
}

/// Connection state for the ACP provider
#[derive(Clone, Copy, PartialEq, Eq)]
enum ConnectionState {
    /// Currently connecting to the provider (initial connection)
    Connecting,
    /// Connected and ready
    Connected,
    /// Switching to a new provider (background connection in progress)
    SwitchingProvider(AcpProvider),
}

/// UI mode for the application
#[derive(Clone, Copy, PartialEq, Eq)]
enum UiMode {
    /// Normal chat mode
    Chat,
    /// Main command palette (Ctrl+O) - searchable list of commands
    MainPalette,
    /// Unified provider/model selection palette (Ctrl+M)
    SwitchPalette,
}

/// Commands available in the main palette
#[derive(Clone, Copy, PartialEq, Eq)]
enum PaletteCommand {
    ToggleDebugMode,
    SwitchProviderModel,
}

impl PaletteCommand {
    fn all() -> &'static [PaletteCommand] {
        &[
            PaletteCommand::ToggleDebugMode,
            PaletteCommand::SwitchProviderModel,
        ]
    }

    fn label(&self) -> &'static str {
        match self {
            PaletteCommand::ToggleDebugMode => "Toggle Debug Mode",
            PaletteCommand::SwitchProviderModel => "Switch Provider / Model",
        }
    }

    fn description(&self) -> &'static str {
        match self {
            PaletteCommand::ToggleDebugMode => "Show/hide raw ACP protocol messages",
            PaletteCommand::SwitchProviderModel => "Change AI provider or model",
        }
    }

    fn matches(&self, query: &str) -> bool {
        if query.is_empty() {
            return true;
        }
        let query_lower = query.to_lowercase();
        self.label().to_lowercase().contains(&query_lower)
            || self.description().to_lowercase().contains(&query_lower)
    }
}

/// Item types in the unified switch palette
#[derive(Clone, PartialEq, Eq)]
enum SwitchPaletteItem {
    /// Section header (not selectable)
    Header(String),
    /// Provider option
    Provider(AcpProvider),
    /// Model option (provider, model_id, display_name)
    Model {
        provider: AcpProvider,
        id: String,
        name: String,
    },
    /// Loading indicator (not selectable)
    Loading(AcpProvider),
}

impl SwitchPaletteItem {
    fn is_selectable(&self) -> bool {
        !matches!(
            self,
            SwitchPaletteItem::Header(_) | SwitchPaletteItem::Loading(_)
        )
    }
}

struct App<'a> {
    history: Vec<ChatEntry>,
    textarea: TextArea<'a>,
    client_connection: Option<Arc<ClientSideConnection>>,
    session_id: Option<SessionId>,
    /// Scroll offset from the bottom in lines. 0 = at bottom, >0 = scrolled up.
    /// This is clamped during render, so scroll methods can freely modify it.
    scroll_offset_from_bottom: u16,
    /// Current ACP provider
    current_provider: AcpProvider,
    /// Current UI mode
    ui_mode: UiMode,
    /// Selected index in command palette
    palette_selection: usize,
    /// Palette search input (reused for both palettes)
    palette_input: TextArea<'a>,
    /// Connection state
    connection_state: ConnectionState,
    /// Debug mode - show raw ACP messages
    debug_mode: bool,
    /// Debug messages log
    debug_messages: Vec<String>,
    /// Event sender for async operations
    event_tx: mpsc::UnboundedSender<AppEvent>,
    /// Base URL for sandbox connections
    base_url: String,
    /// Sandbox ID for connections
    sandbox_id: String,
    /// Available models from the current provider (if supported)
    model_state: Option<SessionModelState>,
    /// Whether a model switch is in progress
    model_switching: bool,
    /// Cached models per provider for the model picker
    /// None = not loaded yet, Some(vec) = loaded (may be empty)
    provider_models: HashMap<AcpProvider, Option<Vec<(String, String)>>>,
    /// Providers currently being loaded for model discovery
    providers_loading: Vec<AcpProvider>,
    /// Pending model to switch to after provider switch completes
    pending_model_switch: Option<ModelId>,
}

impl<'a> App<'a> {
    fn new(
        provider: AcpProvider,
        event_tx: mpsc::UnboundedSender<AppEvent>,
        base_url: String,
        sandbox_id: String,
    ) -> Self {
        let mut textarea = TextArea::default();
        textarea.set_block(
            Block::default()
                .borders(Borders::TOP | Borders::BOTTOM)
                .border_style(ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray)),
        );
        textarea
            .set_placeholder_text("Type a message and press Enter to send. Ctrl+J for new line.");

        let mut palette_input = TextArea::default();
        palette_input.set_placeholder_text("Type to search...");
        palette_input.set_cursor_line_style(ratatui::style::Style::default());

        Self {
            history: vec![],
            textarea,
            client_connection: None,
            session_id: None,
            scroll_offset_from_bottom: 0,
            current_provider: provider,
            ui_mode: UiMode::Chat,
            palette_selection: 0,
            palette_input,
            connection_state: ConnectionState::Connecting,
            debug_mode: false,
            debug_messages: vec![],
            event_tx,
            base_url,
            sandbox_id,
            model_state: None,
            model_switching: false,
            provider_models: HashMap::new(),
            providers_loading: vec![],
            pending_model_switch: None,
        }
    }

    /// Add a debug message (only stored if debug mode is enabled)
    fn add_debug_message(&mut self, direction: &str, msg: &str) {
        if self.debug_mode {
            let timestamp = chrono::Utc::now().format("%H:%M:%S%.3f");
            self.debug_messages
                .push(format!("[{}] {} {}", timestamp, direction, msg));
            // Keep only last 100 messages
            if self.debug_messages.len() > 100 {
                self.debug_messages.remove(0);
            }
        }
    }

    /// Open the main command palette (Ctrl+O)
    fn open_main_palette(&mut self) {
        self.ui_mode = UiMode::MainPalette;
        self.palette_selection = 0;
        self.palette_input = TextArea::default();
        self.palette_input.set_placeholder_text("Type to search...");
        self.palette_input
            .set_cursor_line_style(ratatui::style::Style::default());
    }

    /// Open the unified switch palette (Ctrl+M) for providers and models
    fn open_switch_palette(&mut self) {
        self.ui_mode = UiMode::SwitchPalette;
        self.palette_input = TextArea::default();
        self.palette_input
            .set_placeholder_text("Type to filter providers/models...");
        self.palette_input
            .set_cursor_line_style(ratatui::style::Style::default());

        // Pre-select current provider or model
        let items = self.get_switch_palette_items();
        let selectable: Vec<_> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.is_selectable())
            .collect();

        // Try to find current model first, then current provider
        self.palette_selection = 0;
        if let Some(ref model_state) = self.model_state {
            let current_model_id = &model_state.current_model_id;
            if let Some(pos) = selectable.iter().position(|(_, item)| {
                matches!(item, SwitchPaletteItem::Model { id, .. } if id == &*current_model_id.0)
            }) {
                self.palette_selection = pos;
                return;
            }
        }
        // Fall back to current provider
        if let Some(pos) = selectable.iter().position(|(_, item)| {
            matches!(item, SwitchPaletteItem::Provider(p) if *p == self.current_provider)
        }) {
            self.palette_selection = pos;
        }
    }

    /// Get items for the unified switch palette
    /// Shows all providers and models from all providers
    fn get_switch_palette_items(&self) -> Vec<SwitchPaletteItem> {
        let search = self.palette_search();
        let search_lower = search.to_lowercase();
        let mut items = Vec::new();

        // Show each provider with its models underneath
        for provider in AcpProvider::all() {
            let provider_matches = search.is_empty()
                || provider
                    .display_name()
                    .to_lowercase()
                    .contains(&search_lower);

            // Get models for this provider
            let models = self.get_models_for_provider(*provider);

            // Check if any models match the search
            let matching_models: Vec<_> = models
                .iter()
                .filter(|(_, name)| {
                    search.is_empty() || name.to_lowercase().contains(&search_lower)
                })
                .collect();

            // Check if this provider is still loading
            let is_loading = self.providers_loading.contains(provider);

            // Include this section if provider matches or any models match
            if provider_matches || !matching_models.is_empty() || (search.is_empty() && is_loading)
            {
                // Add provider as header
                items.push(SwitchPaletteItem::Header(
                    provider.display_name().to_string(),
                ));
                items.push(SwitchPaletteItem::Provider(*provider));

                // Add models or loading indicator
                if is_loading && models.is_empty() {
                    items.push(SwitchPaletteItem::Loading(*provider));
                } else if !matching_models.is_empty() {
                    for (id, name) in matching_models {
                        items.push(SwitchPaletteItem::Model {
                            provider: *provider,
                            id: id.clone(),
                            name: name.clone(),
                        });
                    }
                }
            }
        }

        items
    }

    /// Get models for a specific provider
    fn get_models_for_provider(&self, provider: AcpProvider) -> Vec<(String, String)> {
        // First check cached models
        if let Some(Some(models)) = self.provider_models.get(&provider) {
            return models.clone();
        }

        // For current provider, use model_state if available
        if provider == self.current_provider {
            if let Some(ref model_state) = self.model_state {
                return model_state
                    .available_models
                    .iter()
                    .map(|m| (m.model_id.0.to_string(), m.name.clone()))
                    .collect();
            }
        }

        vec![]
    }

    /// Get the current model name (if available)
    fn current_model_name(&self) -> Option<&str> {
        self.model_state.as_ref().and_then(|s| {
            s.available_models
                .iter()
                .find(|m| m.model_id == s.current_model_id)
                .map(|m| m.name.as_str())
        })
    }

    /// Close any palette
    fn close_palette(&mut self) {
        self.ui_mode = UiMode::Chat;
    }

    /// Get the current search query from the palette input
    fn palette_search(&self) -> String {
        self.palette_input.lines().join("")
    }

    /// Get filtered selectable items count for current palette
    fn filtered_items_count(&self) -> usize {
        match self.ui_mode {
            UiMode::MainPalette => {
                let search = self.palette_search();
                PaletteCommand::all()
                    .iter()
                    .filter(|c| c.matches(&search))
                    .count()
            }
            UiMode::SwitchPalette => self
                .get_switch_palette_items()
                .iter()
                .filter(|item| item.is_selectable())
                .count(),
            UiMode::Chat => 0,
        }
    }

    /// Move selection up in palette
    fn palette_up(&mut self) {
        let len = self.filtered_items_count();
        if len > 0 {
            self.palette_selection = (self.palette_selection + len - 1) % len;
        }
    }

    /// Move selection down in palette
    fn palette_down(&mut self) {
        let len = self.filtered_items_count();
        if len > 0 {
            self.palette_selection = (self.palette_selection + 1) % len;
        }
    }

    /// Handle input in palette search and reset selection
    fn palette_handle_input(&mut self, input: impl Into<tui_textarea::Input>) {
        let old_search = self.palette_search();
        self.palette_input.input(input);
        let new_search = self.palette_search();
        if old_search != new_search {
            self.palette_selection = 0; // Reset selection on search change
        }
    }

    /// Execute selected command in main palette
    fn execute_main_palette_selection(&mut self) -> Option<PaletteCommand> {
        if self.ui_mode == UiMode::MainPalette {
            let search = self.palette_search();
            let filtered: Vec<_> = PaletteCommand::all()
                .iter()
                .filter(|c| c.matches(&search))
                .collect();
            if let Some(cmd) = filtered.get(self.palette_selection) {
                let cmd = **cmd;
                self.ui_mode = UiMode::Chat;
                return Some(cmd);
            }
        }
        self.ui_mode = UiMode::Chat;
        None
    }

    /// Execute selection in unified switch palette
    /// Initiates async provider or model switch based on selection
    fn execute_switch_palette_selection(&mut self) {
        if self.ui_mode != UiMode::SwitchPalette {
            return;
        }

        let items = self.get_switch_palette_items();
        let selectable: Vec<_> = items
            .into_iter()
            .filter(|item| item.is_selectable())
            .collect();

        if let Some(selected) = selectable.get(self.palette_selection) {
            match selected {
                SwitchPaletteItem::Provider(provider) => {
                    let provider = *provider;
                    self.ui_mode = UiMode::Chat;
                    if provider != self.current_provider {
                        // Start async provider switch
                        let old_provider = self.current_provider;
                        self.current_provider = provider;
                        self.connection_state = ConnectionState::SwitchingProvider(old_provider);
                        self.start_provider_switch(provider);
                        return;
                    }
                }
                SwitchPaletteItem::Model { provider, id, .. } => {
                    let model_id = ModelId::from(id.clone());
                    self.ui_mode = UiMode::Chat;

                    // If selecting a model from a different provider, switch provider first
                    if *provider != self.current_provider {
                        // Store the desired model to switch to after provider switch
                        let old_provider = self.current_provider;
                        self.current_provider = *provider;
                        self.connection_state = ConnectionState::SwitchingProvider(old_provider);
                        // The model switch will happen after provider switch completes
                        // We'll handle this by saving the target model
                        self.start_provider_switch_with_model(*provider, Some(model_id));
                        return;
                    }

                    // Same provider - just switch model
                    if let Some(ref model_state) = self.model_state {
                        if model_id != model_state.current_model_id {
                            self.model_switching = true;
                            self.start_model_switch(model_id);
                            return;
                        }
                    }
                }
                SwitchPaletteItem::Header(_) | SwitchPaletteItem::Loading(_) => {} // Not selectable
            }
        }
        self.ui_mode = UiMode::Chat;
    }

    /// Start connecting to a new provider in the background
    fn start_provider_switch(&mut self, provider: AcpProvider) {
        self.start_provider_switch_with_model(provider, None);
    }

    /// Start connecting to a new provider with an optional model to switch to after
    fn start_provider_switch_with_model(&mut self, provider: AcpProvider, model: Option<ModelId>) {
        self.pending_model_switch = model;
        let tx = self.event_tx.clone();
        let base_url = self.base_url.clone();
        let sandbox_id = self.sandbox_id.clone();

        tokio::task::spawn_local(async move {
            match connect_to_provider(&base_url, &sandbox_id, provider, tx.clone()).await {
                Ok((connection, session_id, model_state)) => {
                    let _ = tx.send(AppEvent::ProviderSwitchComplete {
                        provider,
                        connection,
                        session_id,
                        model_state,
                    });
                }
                Err(e) => {
                    log_debug(&format!("Provider switch failed: {}", e));
                    let _ = tx.send(AppEvent::ProviderSwitchFailed {
                        provider,
                        error: e.to_string(),
                    });
                }
            }
        });
    }

    /// Start switching to a new model in the background
    fn start_model_switch(&self, model_id: ModelId) {
        let tx = self.event_tx.clone();
        let conn = self.client_connection.clone();
        let session_id = self.session_id.clone();

        if let (Some(conn), Some(session_id)) = (conn, session_id) {
            let model_id_clone = model_id.clone();
            tokio::task::spawn_local(async move {
                let request = SetSessionModelRequest {
                    session_id,
                    model_id: model_id_clone.clone(),
                    meta: None,
                };

                match Agent::set_session_model(&*conn, request).await {
                    Ok(_) => {
                        let _ = tx.send(AppEvent::ModelSwitchComplete {
                            model_id: model_id_clone,
                        });
                    }
                    Err(e) => {
                        log_debug(&format!("Model switch failed: {}", e));
                        let _ = tx.send(AppEvent::ModelSwitchFailed {
                            error: e.to_string(),
                        });
                    }
                }
            });
        }
    }

    /// Toggle debug mode
    fn toggle_debug_mode(&mut self) {
        self.debug_mode = !self.debug_mode;
        if !self.debug_mode {
            self.debug_messages.clear();
        }
    }

    /// Scroll up by the given number of lines (increase offset from bottom)
    fn scroll_up(&mut self, lines: u16) {
        // No clamping here - render will clamp with fresh values
        self.scroll_offset_from_bottom = self.scroll_offset_from_bottom.saturating_add(lines);
    }

    /// Scroll down by the given number of lines (decrease offset from bottom)
    fn scroll_down(&mut self, lines: u16) {
        self.scroll_offset_from_bottom = self.scroll_offset_from_bottom.saturating_sub(lines);
    }

    /// Scroll to the very top
    fn scroll_to_top(&mut self) {
        // Use max value, render will clamp to actual max
        self.scroll_offset_from_bottom = u16::MAX;
    }

    /// Scroll to the very bottom
    fn scroll_to_bottom(&mut self) {
        self.scroll_offset_from_bottom = 0;
    }

    fn on_session_update(&mut self, notification: SessionNotification) {
        match notification.update {
            SessionUpdate::UserMessageChunk(chunk) => {
                if let ContentBlock::Text(text_content) = chunk.content {
                    self.append_message("User", &text_content.text);
                }
            }
            SessionUpdate::AgentMessageChunk(chunk) => {
                if let ContentBlock::Text(text_content) = chunk.content {
                    self.append_message("Agent", &text_content.text);
                }
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                if let ContentBlock::Text(text_content) = chunk.content {
                    self.append_message("Thought", &text_content.text);
                }
            }
            SessionUpdate::ToolCall(tool_call) => {
                self.add_tool_call(tool_call);
            }
            SessionUpdate::ToolCallUpdate(update) => {
                self.update_tool_call(update);
            }
            SessionUpdate::Plan(plan) => {
                self.update_plan(plan);
            }
            SessionUpdate::AvailableCommandsUpdate(_) | SessionUpdate::CurrentModeUpdate(_) => {
                // These don't need visual representation in chat
            }
        }
    }

    fn append_message(&mut self, role: &str, text: &str) {
        // Try to append to existing message of same role
        if let Some(ChatEntry::Message {
            role: last_role,
            text: last_text,
            normalized_markdown,
        }) = self.history.last_mut()
        {
            if last_role == role {
                last_text.push_str(text);
                if matches!(role, "Agent" | "Thought") {
                    *normalized_markdown = Some(normalize_code_fences(last_text));
                }
                return;
            }
        }
        let normalized_markdown = if matches!(role, "Agent" | "Thought") {
            Some(normalize_code_fences(text))
        } else {
            None
        };
        self.history.push(ChatEntry::Message {
            role: role.to_string(),
            text: text.to_string(),
            normalized_markdown,
        });
    }

    fn add_tool_call(&mut self, tool_call: ToolCall) {
        self.history.push(ChatEntry::ToolCall {
            id: tool_call.id.to_string(),
            title: tool_call.title,
            kind: tool_call.kind,
            status: tool_call.status,
        });
    }

    fn update_tool_call(&mut self, update: ToolCallUpdate) {
        let id_str = update.id.to_string();
        // Find and update existing tool call
        for entry in self.history.iter_mut().rev() {
            if let ChatEntry::ToolCall {
                id,
                title,
                kind,
                status,
            } = entry
            {
                if id == &id_str {
                    if let Some(new_title) = update.fields.title {
                        *title = new_title;
                    }
                    if let Some(new_kind) = update.fields.kind {
                        *kind = new_kind;
                    }
                    if let Some(new_status) = update.fields.status {
                        *status = new_status;
                    }
                    return;
                }
            }
        }
        // If not found, create from update if we have enough info
        if let Some(title) = update.fields.title {
            self.history.push(ChatEntry::ToolCall {
                id: id_str,
                title,
                kind: update.fields.kind.unwrap_or_default(),
                status: update.fields.status.unwrap_or_default(),
            });
        }
    }

    fn update_plan(&mut self, plan: Plan) {
        // Replace existing plan or add new one
        for entry in self.history.iter_mut().rev() {
            if matches!(entry, ChatEntry::Plan(_)) {
                *entry = ChatEntry::Plan(plan);
                return;
            }
        }
        self.history.push(ChatEntry::Plan(plan));
    }

    async fn send_message(&mut self) {
        // Clone connection and session_id early to drop the borrow of self
        let (conn, session_id, tx) =
            if let (Some(conn), Some(session_id)) = (&self.client_connection, &self.session_id) {
                (conn.clone(), session_id.clone(), self.event_tx.clone())
            } else {
                return;
            };

        let lines = self.textarea.lines();
        let text = lines.join("\n");
        if text.trim().is_empty() {
            return;
        }

        self.append_message("User", &text);

        // Clear input immediately
        self.textarea = TextArea::default();
        self.textarea.set_block(
            Block::default()
                .borders(Borders::TOP | Borders::BOTTOM)
                .border_style(ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray)),
        );
        self.textarea
            .set_placeholder_text("Type a message and press Enter to send. Ctrl+J for new line.");

        let request = PromptRequest {
            session_id,
            prompt: vec![ContentBlock::Text(TextContent {
                text,
                annotations: None,
                meta: None,
            })],
            meta: None,
        };

        tokio::task::spawn_local(async move {
            // Manually deref if needed, but method syntax should work if trait is in scope.
            // We are using `Agent` trait method `prompt`.
            if let Err(error) = Agent::prompt(&*conn, request).await {
                log_debug(&format!("Prompt failed: {}", error));
                let _ = tx.send(AppEvent::RequestError {
                    error: error.to_string(),
                });
            }
        });
    }
}

// Wrappers for AsyncRead/AsyncWrite
struct TokioCompatRead<T>(T);

impl<T: tokio::io::AsyncRead + Unpin> futures::io::AsyncRead for TokioCompatRead<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut [u8],
    ) -> std::task::Poll<io::Result<usize>> {
        let mut read_buf = tokio::io::ReadBuf::new(buf);
        futures::ready!(std::pin::Pin::new(&mut self.0).poll_read(cx, &mut read_buf))?;
        std::task::Poll::Ready(Ok(read_buf.filled().len()))
    }
}

struct TokioCompatWrite<T>(T);

impl<T: tokio::io::AsyncWrite + Unpin> futures::io::AsyncWrite for TokioCompatWrite<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_close(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

pub async fn run_chat_tui(
    base_url: String,
    sandbox_id: String,
    provider: AcpProvider,
) -> Result<()> {
    let mut stdout = io::stdout();
    // Enable mouse capture for scroll, and bracketed paste for multi-line paste
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    enable_raw_mode()?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let local = tokio::task::LocalSet::new();
    let res = local
        .run_until(run_main_loop(&mut terminal, base_url, sandbox_id, provider))
        .await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen,
        DisableBracketedPaste
    )?;
    terminal.show_cursor()?;

    // Surface errors to the user
    match res {
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("\n\x1b[31mError: {}\x1b[0m", e);
            // Also try to read the end of the log file to give more context if available
            if let Ok(logs) = std::fs::read_to_string("/tmp/cmux-chat.log") {
                let lines: Vec<&str> = logs.lines().rev().take(5).collect();
                if !lines.is_empty() {
                    eprintln!("\nRecent logs:");
                    for line in lines.iter().rev() {
                        eprintln!("  {}", line);
                    }
                }
            }
            Err(anyhow::anyhow!(e))
        }
    }
}

/// WebSocket reader wrapper for ACP protocol
struct WsRead {
    stream: futures::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    tx: mpsc::UnboundedSender<AppEvent>,
}

/// WebSocket writer wrapper for ACP protocol
struct WsWrite {
    sink: futures::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        tokio_tungstenite::tungstenite::Message,
    >,
    tx: mpsc::UnboundedSender<AppEvent>,
}

impl tokio::io::AsyncRead for WsRead {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        loop {
            match futures::ready!(self.stream.poll_next_unpin(cx)) {
                Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(data))) => {
                    let msg = String::from_utf8_lossy(&data).to_string();
                    let _ = self.tx.send(AppEvent::DebugMessage {
                        direction: "←".to_string(),
                        message: msg,
                    });
                    buf.put_slice(&data);
                    return std::task::Poll::Ready(Ok(()));
                }
                Some(Ok(tokio_tungstenite::tungstenite::Message::Text(data))) => {
                    log_debug(&format!("RECV TEXT: {}", data));
                    let _ = self.tx.send(AppEvent::DebugMessage {
                        direction: "←".to_string(),
                        message: data.clone(),
                    });
                    buf.put_slice(data.as_bytes());
                    return std::task::Poll::Ready(Ok(()));
                }
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                    log_debug("RECV EOF");
                    return std::task::Poll::Ready(Ok(()));
                }
                Some(Err(e)) => {
                    log_debug(&format!("RECV Error: {}", e));
                    return std::task::Poll::Ready(Err(io::Error::other(e)));
                }
                _ => continue,
            }
        }
    }
}

impl tokio::io::AsyncWrite for WsWrite {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        let msg = String::from_utf8_lossy(buf).to_string();
        log_debug(&format!("SEND: {:?}", msg));
        let _ = self.tx.send(AppEvent::DebugMessage {
            direction: "→".to_string(),
            message: msg,
        });
        match self
            .sink
            .start_send_unpin(tokio_tungstenite::tungstenite::Message::Binary(
                buf.to_vec(),
            )) {
            Ok(_) => {
                match self.sink.poll_flush_unpin(cx) {
                    std::task::Poll::Ready(Ok(_)) => log_debug("Auto-flush success"),
                    std::task::Poll::Ready(Err(e)) => {
                        log_debug(&format!("Auto-flush error: {}", e))
                    }
                    std::task::Poll::Pending => log_debug("Auto-flush pending"),
                }
                std::task::Poll::Ready(Ok(buf.len()))
            }
            Err(e) => std::task::Poll::Ready(Err(io::Error::other(e))),
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        log_debug("FLUSH");
        self.sink.poll_flush_unpin(cx).map_err(io::Error::other)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        self.sink.poll_close_unpin(cx).map_err(io::Error::other)
    }
}

/// Connect to an ACP provider and return the connection, session ID, and model state.
/// This function can be called from background tasks for provider switching.
async fn connect_to_provider(
    base_url: &str,
    sandbox_id: &str,
    provider: AcpProvider,
    tx: mpsc::UnboundedSender<AppEvent>,
) -> Result<(
    Arc<ClientSideConnection>,
    SessionId,
    Option<SessionModelState>,
)> {
    log_debug(&format!(
        "Connecting to provider: {}",
        provider.display_name()
    ));

    let ws_url = base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .trim_end_matches('/')
        .to_string();

    let command = provider.command();
    let encoded_command =
        url::form_urlencoded::byte_serialize(command.as_bytes()).collect::<String>();

    let url = format!(
        "{}/sandboxes/{}/attach?cols=80&rows=24&tty=false&command={}",
        ws_url, sandbox_id, encoded_command
    );
    log_debug(&format!("Connecting to: {}", url));

    let (ws_stream, _) = tokio_tungstenite::connect_async(url).await?;
    log_debug("WebSocket connected");

    let (write, read) = ws_stream.split();

    let (client_conn, io_task) = ClientSideConnection::new(
        Arc::new(AppClient { tx: tx.clone() }),
        TokioCompatWrite(WsWrite {
            sink: write,
            tx: tx.clone(),
        }),
        TokioCompatRead(WsRead {
            stream: read,
            tx: tx.clone(),
        }),
        Box::new(|fut| {
            tokio::task::spawn_local(fut);
        }),
    );
    let client_conn = Arc::new(client_conn);

    tokio::task::spawn_local(async move {
        if let Err(e) = io_task.await {
            log_debug(&format!("IO Task Error: {}", e));
        } else {
            log_debug("IO Task Finished");
        }
    });

    log_debug("Sending Initialize...");
    client_conn
        .initialize(InitializeRequest {
            protocol_version: V1,
            client_capabilities: ClientCapabilities {
                fs: FileSystemCapability {
                    read_text_file: true,
                    write_text_file: true,
                    meta: None,
                },
                terminal: false,
                meta: None,
            },
            client_info: None,
            meta: None,
        })
        .await?;
    log_debug("Initialize complete");

    log_debug("Starting New Session...");
    let new_session_res = client_conn
        .new_session(NewSessionRequest {
            cwd: std::path::PathBuf::from("/workspace"),
            mcp_servers: vec![],
            meta: None,
        })
        .await?;
    log_debug(&format!(
        "New Session started, models: {:?}",
        new_session_res.models
    ));

    Ok((
        client_conn,
        new_session_res.session_id,
        new_session_res.models,
    ))
}

/// Fetch models from a provider without keeping the connection.
/// Used for background model discovery.
async fn fetch_provider_models(
    base_url: &str,
    sandbox_id: &str,
    provider: AcpProvider,
    tx: mpsc::UnboundedSender<AppEvent>,
) {
    log_debug(&format!(
        "Fetching models for provider: {}",
        provider.display_name()
    ));

    // Create a dummy tx for the connection (we don't care about debug messages)
    let dummy_tx = tx.clone();

    match connect_to_provider(base_url, sandbox_id, provider, dummy_tx).await {
        Ok((_connection, _session_id, model_state)) => {
            let models: Vec<(String, String)> = model_state
                .map(|state| {
                    state
                        .available_models
                        .into_iter()
                        .map(|m| (m.model_id.0.to_string(), m.name))
                        .collect()
                })
                .unwrap_or_default();

            log_debug(&format!(
                "Loaded {} models for {}",
                models.len(),
                provider.display_name()
            ));

            let _ = tx.send(AppEvent::ProviderModelsLoaded { provider, models });
            // Connection will be dropped here, closing the websocket
        }
        Err(e) => {
            log_debug(&format!(
                "Failed to fetch models for {}: {}",
                provider.display_name(),
                e
            ));
            let _ = tx.send(AppEvent::ProviderModelsLoadFailed { provider });
        }
    }
}

async fn run_main_loop<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    base_url: String,
    sandbox_id: String,
    initial_provider: AcpProvider,
) -> Result<()> {
    log_debug(&format!(
        "Starting run_main_loop with provider: {}",
        initial_provider.display_name()
    ));
    let (tx, rx) = mpsc::unbounded_channel();

    // Create app immediately in Connecting state
    let mut app = App::new(
        initial_provider,
        tx.clone(),
        base_url.clone(),
        sandbox_id.clone(),
    );
    // Start with Connecting state - UI shows immediately
    app.connection_state = ConnectionState::Connecting;

    // Mark all providers as loading
    for provider in AcpProvider::all() {
        app.providers_loading.push(*provider);
    }

    // Spawn connections to ALL providers in parallel
    // The initial_provider connection will be kept for the main session
    // Other providers are just for model discovery
    for provider in AcpProvider::all() {
        let tx_clone = tx.clone();
        let base_url_clone = base_url.clone();
        let sandbox_id_clone = sandbox_id.clone();
        let provider = *provider;

        if provider == initial_provider {
            // For the initial provider, keep the connection for the main session
            tokio::task::spawn_local(async move {
                match connect_to_provider(
                    &base_url_clone,
                    &sandbox_id_clone,
                    provider,
                    tx_clone.clone(),
                )
                .await
                {
                    Ok((connection, session_id, model_state)) => {
                        let _ = tx_clone.send(AppEvent::ProviderSwitchComplete {
                            provider,
                            connection,
                            session_id,
                            model_state,
                        });
                    }
                    Err(e) => {
                        log_debug(&format!("Initial provider connection failed: {}", e));
                        let _ = tx_clone.send(AppEvent::ProviderSwitchFailed {
                            provider,
                            error: e.to_string(),
                        });
                    }
                }
            });
        } else {
            // For other providers, just fetch models and close the connection
            tokio::task::spawn_local(async move {
                fetch_provider_models(&base_url_clone, &sandbox_id_clone, provider, tx_clone).await;
            });
        }
    }

    log_debug("Running App UI loop...");
    run_app(terminal, app, rx).await?;
    log_debug("App UI loop finished - exiting");
    Ok(())
}

async fn run_app<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    mut app: App<'_>,
    mut rx: mpsc::UnboundedReceiver<AppEvent>,
) -> io::Result<()> {
    let mut reader = EventStream::new();

    loop {
        terminal.draw(|f| ui(f, &mut app))?;

        tokio::select! {
            Some(event) = rx.recv() => {
                match event {
                    AppEvent::SessionUpdate(notification) => app.on_session_update(*notification),
                    AppEvent::DebugMessage { direction, message } => {
                        app.add_debug_message(&direction, &message);
                    }
                    AppEvent::ProviderSwitchComplete { provider, connection, session_id, model_state } => {
                        log_debug(&format!("Provider switch complete: {}", provider.display_name()));
                        let was_initial_connection = app.connection_state == ConnectionState::Connecting;
                        app.current_provider = provider;
                        app.client_connection = Some(connection);
                        app.session_id = Some(session_id);
                        app.model_state = model_state.clone();
                        app.connection_state = ConnectionState::Connected;

                        // Cache models for this provider and remove from loading list
                        if let Some(ref state) = model_state {
                            let models: Vec<(String, String)> = state
                                .available_models
                                .iter()
                                .map(|m| (m.model_id.0.to_string(), m.name.clone()))
                                .collect();
                            app.provider_models.insert(provider, Some(models));
                        }
                        app.providers_loading.retain(|p| *p != provider);

                        // Clear history for provider switch (but not initial connection)
                        if !was_initial_connection {
                            app.history.clear();
                        }

                        // Save last used provider
                        save_last_provider(provider);

                        // Check if there's a pending model switch
                        if let Some(pending_model) = app.pending_model_switch.take() {
                            app.model_switching = true;
                            app.start_model_switch(pending_model);
                        } else {
                            // Try to restore last used model for this provider
                            if let Some(ref state) = model_state {
                                if let Some(last_model_id) = load_last_model(provider) {
                                    // Check if the model is still available
                                    if state.available_models.iter().any(|m| *m.model_id.0 == last_model_id) {
                                        // Switch to the last used model if it's different from current
                                        if *state.current_model_id.0 != last_model_id {
                                            app.model_switching = true;
                                            app.start_model_switch(ModelId::from(last_model_id));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    AppEvent::ProviderSwitchFailed { provider, error } => {
                        log_debug(&format!("Provider switch failed for {}: {}", provider.display_name(), error));
                        let was_initial_connection = app.connection_state == ConnectionState::Connecting;
                        // Revert to old provider (stored in SwitchingProvider state)
                        if let ConnectionState::SwitchingProvider(old_provider) = app.connection_state {
                            app.current_provider = old_provider;
                            app.connection_state = ConnectionState::Connected;
                        } else if was_initial_connection {
                            // Initial connection failed - stay in a failed state but allow retrying
                            app.connection_state = ConnectionState::Connected;
                        }
                        // Remove from loading list and mark as failed (empty models)
                        app.providers_loading.retain(|p| *p != provider);
                        app.provider_models.insert(provider, Some(vec![]));
                        // Clear pending model switch
                        app.pending_model_switch = None;
                        // Add error message to chat (only for the current provider, not background loads)
                        if provider == app.current_provider {
                            app.history.push(ChatEntry::Message {
                                role: "System".to_string(),
                                text: format!("Failed to connect to {}: {}", provider.display_name(), error),
                                normalized_markdown: None,
                            });
                        }
                    }
                    AppEvent::ModelSwitchComplete { model_id } => {
                        log_debug(&format!("Model switch complete: {}", model_id));
                        app.model_switching = false;
                        // Update current model in state
                        if let Some(ref mut model_state) = app.model_state {
                            model_state.current_model_id = model_id.clone();
                        }
                        // Save last used model for this provider
                        save_last_model(app.current_provider, &model_id.0);
                    }
                    AppEvent::ModelSwitchFailed { error } => {
                        log_debug(&format!("Model switch failed: {}", error));
                        app.model_switching = false;
                        // Add error message to chat
                        app.history.push(ChatEntry::Message {
                            role: "System".to_string(),
                            text: format!("Failed to switch model: {}", error),
                            normalized_markdown: None,
                        });
                    }
                    AppEvent::RequestError { error } => {
                        log_debug(&format!("Request error: {}", error));
                        // Add error message to chat
                        app.history.push(ChatEntry::Message {
                            role: "Error".to_string(),
                            text: error,
                            normalized_markdown: None,
                        });
                    }
                    AppEvent::ProviderModelsLoaded { provider, models } => {
                        log_debug(&format!("Loaded {} models for {}", models.len(), provider.display_name()));
                        // Cache the models for this provider
                        app.provider_models.insert(provider, Some(models));
                        // Remove from loading list
                        app.providers_loading.retain(|p| *p != provider);
                    }
                    AppEvent::ProviderModelsLoadFailed { provider } => {
                        log_debug(&format!("Failed to load models for {}", provider.display_name()));
                        // Mark as loaded but with empty list
                        app.provider_models.insert(provider, Some(vec![]));
                        // Remove from loading list
                        app.providers_loading.retain(|p| *p != provider);
                    }
                }
            }
            Some(Ok(event)) = reader.next() => {
                match app.ui_mode {
                    UiMode::MainPalette => {
                        // Handle main command palette input
                        if let Event::Key(key) = event {
                            if key.modifiers.contains(KeyModifiers::CONTROL) {
                                match key.code {
                                    // Navigation
                                    KeyCode::Char('p') | KeyCode::Char('k') => app.palette_up(),
                                    KeyCode::Char('n') | KeyCode::Char('j') => app.palette_down(),
                                    // Close palette
                                    KeyCode::Char('c') | KeyCode::Char('g') => app.close_palette(),
                                    KeyCode::Char('o') => app.close_palette(), // Toggle: close if already open
                                    // Safe to pass through: Ctrl+U (undo), Ctrl+R (redo),
                                    // Ctrl+W (delete word), Ctrl+A (start), Ctrl+E (end),
                                    // Ctrl+H (backspace), Ctrl+D (delete char)
                                    KeyCode::Char('u') | KeyCode::Char('r') |
                                    KeyCode::Char('w') | KeyCode::Char('a') | KeyCode::Char('e') |
                                    KeyCode::Char('h') | KeyCode::Char('d') => {
                                        app.palette_handle_input(key);
                                    }
                                    // Ignore other Ctrl combinations to avoid conflicts
                                    _ => {}
                                }
                            } else {
                                match key.code {
                                    KeyCode::Esc => app.close_palette(),
                                    KeyCode::Up => app.palette_up(),
                                    KeyCode::Down => app.palette_down(),
                                    KeyCode::Enter => {
                                        if let Some(cmd) = app.execute_main_palette_selection() {
                                            match cmd {
                                                PaletteCommand::ToggleDebugMode => {
                                                    app.toggle_debug_mode();
                                                }
                                                PaletteCommand::SwitchProviderModel => {
                                                    app.open_switch_palette();
                                                }
                                            }
                                        }
                                    }
                                    _ => { app.palette_handle_input(key); }
                                }
                            }
                        }
                    }
                    UiMode::SwitchPalette => {
                        // Handle unified provider/model palette input
                        if let Event::Key(key) = event {
                            if key.modifiers.contains(KeyModifiers::CONTROL) {
                                match key.code {
                                    // Navigation
                                    KeyCode::Char('p') | KeyCode::Char('k') => app.palette_up(),
                                    KeyCode::Char('n') | KeyCode::Char('j') => app.palette_down(),
                                    // Close palette
                                    KeyCode::Char('c') | KeyCode::Char('g') => app.close_palette(),
                                    KeyCode::Char('m') => app.close_palette(), // Toggle: close if already open
                                    // Safe to pass through editing shortcuts
                                    KeyCode::Char('u') | KeyCode::Char('r') |
                                    KeyCode::Char('w') | KeyCode::Char('a') | KeyCode::Char('e') |
                                    KeyCode::Char('h') | KeyCode::Char('d') => {
                                        app.palette_handle_input(key);
                                    }
                                    _ => {}
                                }
                            } else {
                                match key.code {
                                    KeyCode::Esc => app.close_palette(),
                                    KeyCode::Up => app.palette_up(),
                                    KeyCode::Down => app.palette_down(),
                                    KeyCode::Enter => {
                                        app.execute_switch_palette_selection();
                                    }
                                    _ => { app.palette_handle_input(key); }
                                }
                            }
                        }
                    }
                    UiMode::Chat => {
                        match event {
                            Event::Key(key) => {
                                if key.modifiers.contains(KeyModifiers::CONTROL) {
                                    match key.code {
                                        KeyCode::Char('q') | KeyCode::Char('c') | KeyCode::Char('d') => {
                                            return Ok(());
                                        }
                                        KeyCode::Char('j') => { app.textarea.insert_newline(); },
                                        KeyCode::Char('m') => { app.open_switch_palette(); },
                                        KeyCode::Char('o') => { app.open_main_palette(); },
                                        _ => { app.textarea.input(key); }
                                    }
                                } else {
                                    match key.code {
                                        KeyCode::Enter => {
                                            // Only send if connected
                                            if app.connection_state == ConnectionState::Connected {
                                                app.send_message().await;
                                            }
                                        }
                                        KeyCode::PageUp => {
                                            app.scroll_up(10);
                                        }
                                        KeyCode::PageDown => {
                                            app.scroll_down(10);
                                        }
                                        KeyCode::Home => {
                                            app.scroll_to_top();
                                        }
                                        KeyCode::End => {
                                            app.scroll_to_bottom();
                                        }
                                        _ => {
                                            app.textarea.input(key);
                                        }
                                    }
                                }
                            }
                            Event::Paste(text) => {
                                // Handle multi-line paste by inserting the text directly
                                app.textarea.insert_str(&text);
                            }
                            Event::Mouse(mouse_event) => {
                                match mouse_event.kind {
                                    MouseEventKind::ScrollUp => {
                                        app.scroll_up(1);
                                    }
                                    MouseEventKind::ScrollDown => {
                                        app.scroll_down(1);
                                    }
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

fn ui(f: &mut ratatui::Frame, app: &mut App) {
    // Calculate dynamic height based on line count
    // +2 accounts for top and bottom borders
    // Clamp between 3 (1 line) and 12 (10 lines)
    let line_count = app.textarea.lines().len() as u16;
    let input_height = (line_count + 2).clamp(3, 12);

    // Status bar showing current provider (1 line) - below input
    let status_height = 1u16;

    // Debug panel height (if enabled)
    let debug_height = if app.debug_mode { 8u16 } else { 0u16 };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(
            [
                Constraint::Min(1),                // Chat history
                Constraint::Length(debug_height),  // Debug panel (if enabled)
                Constraint::Length(input_height),  // Input area
                Constraint::Length(status_height), // Status bar
            ]
            .as_ref(),
        )
        .split(f.area());

    let history_area = chunks[0];
    let debug_area = chunks[1];
    let input_area = chunks[2];
    let status_area = chunks[3];

    let area_width = history_area.width as usize;
    let mut lines: Vec<Line<'_>> = Vec::new();

    for (i, entry) in app.history.iter().enumerate() {
        if i > 0 {
            lines.push(Line::from("")); // Spacing
        }
        match entry {
            ChatEntry::Message {
                role,
                text,
                normalized_markdown,
            } => {
                render_message(
                    &mut lines,
                    role,
                    text,
                    normalized_markdown.as_deref(),
                    area_width,
                );
            }
            ChatEntry::ToolCall {
                title,
                kind,
                status,
                ..
            } => {
                render_tool_call(&mut lines, title, kind, status);
            }
            ChatEntry::Plan(plan) => {
                render_plan(&mut lines, plan);
            }
        }
    }

    // Calculate scroll offset
    let total_lines = lines.len() as u16;
    let view_height = history_area.height;
    let max_scroll = total_lines.saturating_sub(view_height);

    // Clamp offset to valid range and update stored value
    let offset_from_bottom = app.scroll_offset_from_bottom.min(max_scroll);
    app.scroll_offset_from_bottom = offset_from_bottom;

    // Convert offset-from-bottom to offset-from-top for rendering
    let scroll_offset = max_scroll.saturating_sub(offset_from_bottom);

    // Note: Don't use Wrap with scroll - they don't work correctly together in ratatui
    // Long lines will be truncated at the terminal edge
    let history_paragraph = Paragraph::new(lines).scroll((scroll_offset, 0));

    f.render_widget(history_paragraph, history_area);

    // Render debug panel if enabled
    if app.debug_mode && debug_height > 0 {
        let debug_lines: Vec<Line<'_>> = app
            .debug_messages
            .iter()
            .rev()
            .take(debug_height as usize - 2) // -2 for borders
            .rev()
            .map(|s| {
                Line::styled(
                    s.clone(),
                    ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray),
                )
            })
            .collect();

        let debug_block = Block::default()
            .title(" Debug (ACP Messages) ")
            .title_style(
                ratatui::style::Style::default()
                    .fg(ratatui::style::Color::Yellow)
                    .add_modifier(ratatui::style::Modifier::BOLD),
            )
            .borders(Borders::ALL)
            .border_style(ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray));

        let debug_paragraph = Paragraph::new(debug_lines).block(debug_block);
        f.render_widget(debug_paragraph, debug_area);
    }

    f.render_widget(&app.textarea, input_area);

    // Render status bar at the bottom (no background highlighting)
    let provider_style = ratatui::style::Style::default()
        .fg(ratatui::style::Color::Cyan)
        .add_modifier(ratatui::style::Modifier::BOLD);
    let hint_style = ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray);
    let connecting_style = ratatui::style::Style::default()
        .fg(ratatui::style::Color::Yellow)
        .add_modifier(ratatui::style::Modifier::BOLD);
    let debug_indicator_style = ratatui::style::Style::default().fg(ratatui::style::Color::Yellow);

    let mut status_spans = vec![Span::styled(
        app.current_provider.display_name(),
        provider_style,
    )];

    // Show current model if available
    if let Some(model_name) = app.current_model_name() {
        let model_style = ratatui::style::Style::default().fg(ratatui::style::Color::Magenta);
        status_spans.push(Span::styled(" / ", hint_style));
        status_spans.push(Span::styled(model_name.to_string(), model_style));
    }

    // Show connection state
    match &app.connection_state {
        ConnectionState::Connecting => {
            status_spans.push(Span::styled(" (connecting...)", connecting_style));
        }
        ConnectionState::Connected => {
            if app.model_switching {
                status_spans.push(Span::styled(" (switching model...)", connecting_style));
            }
        }
        ConnectionState::SwitchingProvider(_) => {
            status_spans.push(Span::styled(" (loading...)", connecting_style));
        }
    }

    // Show debug indicator
    if app.debug_mode {
        status_spans.push(Span::styled(" [DEBUG]", debug_indicator_style));
    }

    // Show hints
    status_spans.push(Span::styled(" │ ^O: commands │ ^M: switch", hint_style));

    let status_line = Line::from(status_spans);
    let status_paragraph = Paragraph::new(status_line);
    f.render_widget(status_paragraph, status_area);

    // Render palette overlay if active
    match app.ui_mode {
        UiMode::MainPalette => {
            let search = app.palette_search();
            render_searchable_palette(
                f,
                " Commands ",
                &app.palette_input,
                app.palette_selection,
                PaletteCommand::all()
                    .iter()
                    .filter(|c| c.matches(&search))
                    .map(|c| PaletteItem::Simple {
                        label: c.label().to_string(),
                        description: Some(c.description().to_string()),
                        is_current: false,
                    })
                    .collect(),
            );
        }
        UiMode::SwitchPalette => {
            let items = app.get_switch_palette_items();
            let palette_items: Vec<_> = items
                .iter()
                .map(|item| match item {
                    SwitchPaletteItem::Header(text) => PaletteItem::Header(text.clone()),
                    SwitchPaletteItem::Provider(p) => PaletteItem::Simple {
                        label: format!("Switch to {}", p.display_name()),
                        description: None,
                        is_current: *p == app.current_provider,
                    },
                    SwitchPaletteItem::Model { provider, id, name } => {
                        let is_current = *provider == app.current_provider
                            && app
                                .model_state
                                .as_ref()
                                .is_some_and(|s| &*s.current_model_id.0 == id);
                        PaletteItem::Simple {
                            label: format!("  {}", name),
                            description: None,
                            is_current,
                        }
                    }
                    SwitchPaletteItem::Loading(_) => PaletteItem::Loading,
                })
                .collect();
            render_searchable_palette(
                f,
                " Switch Provider / Model ",
                &app.palette_input,
                app.palette_selection,
                palette_items,
            );
        }
        UiMode::Chat => {}
    }
}

/// Item types for palette rendering
enum PaletteItem {
    /// Section header (not selectable)
    Header(String),
    /// Normal selectable item
    Simple {
        label: String,
        description: Option<String>,
        is_current: bool,
    },
    /// Loading indicator (not selectable)
    Loading,
}

/// Render a searchable palette overlay with scrolling support
fn render_searchable_palette(
    f: &mut ratatui::Frame,
    title: &str,
    search_input: &TextArea<'_>,
    selection: usize, // Index into selectable items only
    items: Vec<PaletteItem>,
) {
    use ratatui::widgets::Clear;

    let area = f.area();

    // Calculate palette dimensions - cap at reasonable size for scrolling
    let palette_width = 70u16.min(area.width.saturating_sub(4));
    let max_items_height = 15u16; // Max visible items
    let palette_height = (items.len() as u16 + 7)
        .min(max_items_height + 7)
        .min(area.height.saturating_sub(4));

    // Center the palette
    let x = (area.width.saturating_sub(palette_width)) / 2;
    let y = (area.height.saturating_sub(palette_height)) / 2;

    let palette_area = ratatui::layout::Rect::new(x, y, palette_width, palette_height);

    // Clear the area behind the palette
    f.render_widget(Clear, palette_area);

    // Split palette area into: search input (1 line), spacing, items, help text
    let inner_area = ratatui::layout::Rect::new(
        palette_area.x + 1,
        palette_area.y + 1,
        palette_area.width.saturating_sub(2),
        palette_area.height.saturating_sub(2),
    );

    let search_area = ratatui::layout::Rect::new(inner_area.x, inner_area.y, inner_area.width, 1);

    let items_start_y = inner_area.y + 2; // +2 for search and spacing
    let items_height = inner_area.height.saturating_sub(4); // -4 for search, spacing, and help lines

    // Render the outer block first
    let palette_block = Block::default()
        .title(title)
        .title_style(
            ratatui::style::Style::default()
                .fg(ratatui::style::Color::Cyan)
                .add_modifier(ratatui::style::Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(ratatui::style::Style::default().fg(ratatui::style::Color::Cyan));
    f.render_widget(palette_block, palette_area);

    // Render search input with ">" prefix
    let search_prefix = Paragraph::new(Line::from(Span::styled(
        ">",
        ratatui::style::Style::default().fg(ratatui::style::Color::Cyan),
    )));
    let prefix_area = ratatui::layout::Rect::new(search_area.x, search_area.y, 2, 1);
    f.render_widget(search_prefix, prefix_area);

    // Render the TextArea input
    let input_area =
        ratatui::layout::Rect::new(search_area.x + 2, search_area.y, search_area.width - 2, 1);
    f.render_widget(search_input, input_area);

    // Build item lines and track which line index corresponds to the selected item
    let mut palette_lines: Vec<Line<'_>> = Vec::new();
    let mut selectable_index = 0usize;
    let mut selected_line_index: Option<usize> = None;

    for item in items.iter() {
        match item {
            PaletteItem::Header(text) => {
                // Header style - dimmed, not selectable
                palette_lines.push(Line::styled(
                    format!("─ {} ─", text),
                    ratatui::style::Style::default()
                        .fg(ratatui::style::Color::DarkGray)
                        .add_modifier(ratatui::style::Modifier::BOLD),
                ));
            }
            PaletteItem::Loading => {
                // Loading indicator - dimmed, not selectable
                palette_lines.push(Line::styled(
                    "    Loading...",
                    ratatui::style::Style::default()
                        .fg(ratatui::style::Color::Yellow)
                        .add_modifier(ratatui::style::Modifier::ITALIC),
                ));
            }
            PaletteItem::Simple {
                label,
                description,
                is_current,
            } => {
                let is_selected = selectable_index == selection;
                if is_selected {
                    selected_line_index = Some(palette_lines.len());
                }

                let prefix = if is_selected { "▶ " } else { "  " };
                let suffix = if *is_current { " ●" } else { "" };

                let style = if is_selected {
                    ratatui::style::Style::default()
                        .fg(ratatui::style::Color::Cyan)
                        .add_modifier(ratatui::style::Modifier::BOLD)
                } else if *is_current {
                    ratatui::style::Style::default().fg(ratatui::style::Color::Green)
                } else {
                    ratatui::style::Style::default()
                };

                let mut spans = vec![Span::styled(
                    format!("{}{}{}", prefix, label, suffix),
                    style,
                )];

                // Add description if present
                if let Some(desc) = description {
                    spans.push(Span::styled(
                        format!("  {}", desc),
                        ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray),
                    ));
                }

                palette_lines.push(Line::from(spans));
                selectable_index += 1;
            }
        }
    }

    if items.is_empty() {
        palette_lines.push(Line::styled(
            "  No matches",
            ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray),
        ));
    }

    // Calculate scroll offset to keep selected item visible
    let total_lines = palette_lines.len() as u16;
    let view_height = items_height;
    let scroll_offset = if let Some(selected_idx) = selected_line_index {
        let selected_idx = selected_idx as u16;
        if selected_idx >= view_height {
            // Scroll so selected item is at the bottom of the view
            (selected_idx + 1).saturating_sub(view_height)
        } else {
            0
        }
    } else {
        0
    };

    // Show scroll indicators if needed
    let needs_scroll_up = scroll_offset > 0;
    let needs_scroll_down = scroll_offset + view_height < total_lines;

    // Render items with scroll
    let items_area =
        ratatui::layout::Rect::new(inner_area.x, items_start_y, inner_area.width, items_height);
    let items_paragraph = Paragraph::new(palette_lines).scroll((scroll_offset, 0));
    f.render_widget(items_paragraph, items_area);

    // Render scroll indicators on the right edge
    if needs_scroll_up {
        let up_indicator = Paragraph::new("▲")
            .style(ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray));
        let up_area =
            ratatui::layout::Rect::new(items_area.x + items_area.width - 1, items_area.y, 1, 1);
        f.render_widget(up_indicator, up_area);
    }
    if needs_scroll_down {
        let down_indicator = Paragraph::new("▼")
            .style(ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray));
        let down_area = ratatui::layout::Rect::new(
            items_area.x + items_area.width - 1,
            items_area.y + items_area.height - 1,
            1,
            1,
        );
        f.render_widget(down_indicator, down_area);
    }

    // Render help text at the bottom
    let help_y = palette_area.y + palette_area.height - 2;
    let help_area = ratatui::layout::Rect::new(inner_area.x, help_y, inner_area.width, 1);
    let help_text = Paragraph::new(Line::styled(
        "↑↓: navigate │ Enter: select │ Esc: cancel",
        ratatui::style::Style::default().fg(ratatui::style::Color::DarkGray),
    ));
    f.render_widget(help_text, help_area);
}

fn render_message<'a>(
    lines: &mut Vec<Line<'a>>,
    role: &str,
    text: &'a str,
    normalized_markdown: Option<&'a str>,
    area_width: usize,
) {
    match role {
        "User" => {
            // User messages have a contrasting background with padding lines above and below
            let bg_style = ratatui::style::Style::default().bg(user_message_bg_color());
            // Empty padding line with background
            lines.push(Line::styled(" ".repeat(area_width), bg_style));
            for line in text.lines() {
                // Pad the line to fill the full width with background
                let padded = format!("{:width$}", line, width = area_width);
                lines.push(Line::styled(padded, bg_style));
            }
            // Empty padding line with background
            lines.push(Line::styled(" ".repeat(area_width), bg_style));
        }
        "Agent" | "Thought" => {
            // Add padding line above
            lines.push(Line::raw(""));
            let prefix_style =
                ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::BOLD);
            render_markdown_message(lines, role, text, normalized_markdown, prefix_style);
            // Add padding line below
            lines.push(Line::raw(""));
        }
        "Error" => {
            // Add padding line above
            lines.push(Line::raw(""));
            // Red styling for errors
            let prefix_style = ratatui::style::Style::default()
                .fg(ratatui::style::Color::Red)
                .add_modifier(ratatui::style::Modifier::BOLD);
            let text_style = ratatui::style::Style::default().fg(ratatui::style::Color::Red);
            let prefix = "Error: ";
            let mut first = true;
            for text_line in text.lines() {
                if first {
                    lines.push(Line::from(vec![
                        Span::styled(prefix.to_string(), prefix_style),
                        Span::styled(text_line.to_owned(), text_style),
                    ]));
                    first = false;
                } else {
                    lines.push(Line::styled(text_line.to_owned(), text_style));
                }
            }
            if first {
                lines.push(Line::from(vec![Span::styled(
                    prefix.to_string(),
                    prefix_style,
                )]));
            }
            // Add padding line below
            lines.push(Line::raw(""));
        }
        "System" => {
            // Add padding line above
            lines.push(Line::raw(""));
            // Yellow/warning styling for system messages
            let prefix_style = ratatui::style::Style::default()
                .fg(ratatui::style::Color::Yellow)
                .add_modifier(ratatui::style::Modifier::BOLD);
            let text_style = ratatui::style::Style::default().fg(ratatui::style::Color::Yellow);
            let prefix = "System: ";
            let mut first = true;
            for text_line in text.lines() {
                if first {
                    lines.push(Line::from(vec![
                        Span::styled(prefix.to_string(), prefix_style),
                        Span::styled(text_line.to_owned(), text_style),
                    ]));
                    first = false;
                } else {
                    lines.push(Line::styled(text_line.to_owned(), text_style));
                }
            }
            if first {
                lines.push(Line::from(vec![Span::styled(
                    prefix.to_string(),
                    prefix_style,
                )]));
            }
            // Add padding line below
            lines.push(Line::raw(""));
        }
        _ => {
            // Add padding line above
            lines.push(Line::raw(""));
            let prefix = format!("{}: ", role);
            let prefix_style =
                ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::BOLD);
            let mut first = true;
            for text_line in text.lines() {
                if first {
                    lines.push(Line::from(vec![
                        Span::styled(prefix.clone(), prefix_style),
                        Span::raw(text_line.to_owned()),
                    ]));
                    first = false;
                } else {
                    lines.push(Line::from(text_line.to_owned()));
                }
            }
            if first {
                lines.push(Line::from(vec![Span::styled(prefix, prefix_style)]));
            }
            // Add padding line below
            lines.push(Line::raw(""));
        }
    }
}

fn render_tool_call<'a>(
    lines: &mut Vec<Line<'a>>,
    title: &str,
    kind: &ToolKind,
    status: &ToolCallStatus,
) {
    let icon = match kind {
        ToolKind::Read => "📖",
        ToolKind::Edit => "✏️",
        ToolKind::Delete => "🗑️",
        ToolKind::Move => "📦",
        ToolKind::Search => "🔍",
        ToolKind::Execute => "▶️",
        ToolKind::Think => "💭",
        ToolKind::Fetch => "🌐",
        ToolKind::SwitchMode => "🔄",
        ToolKind::Other => "🔧",
    };

    let status_indicator = match status {
        ToolCallStatus::Pending => ("⏳", ratatui::style::Color::Yellow),
        ToolCallStatus::InProgress => ("⚙️", ratatui::style::Color::Cyan),
        ToolCallStatus::Completed => ("✓", ratatui::style::Color::Green),
        ToolCallStatus::Failed => ("✗", ratatui::style::Color::Red),
    };

    let tool_style = ratatui::style::Style::default().fg(ratatui::style::Color::Cyan);
    let status_style = ratatui::style::Style::default().fg(status_indicator.1);

    lines.push(Line::from(vec![
        Span::raw(format!("{} ", icon)),
        Span::styled(title.to_owned(), tool_style),
        Span::raw(" "),
        Span::styled(status_indicator.0.to_owned(), status_style),
    ]));
}

fn render_plan<'a>(lines: &mut Vec<Line<'a>>, plan: &Plan) {
    let header_style = ratatui::style::Style::default()
        .fg(ratatui::style::Color::Magenta)
        .add_modifier(ratatui::style::Modifier::BOLD);
    lines.push(Line::styled("📋 Plan", header_style));

    for entry in &plan.entries {
        let (status_icon, status_color) = match entry.status {
            PlanEntryStatus::Pending => ("○", ratatui::style::Color::DarkGray),
            PlanEntryStatus::InProgress => ("◐", ratatui::style::Color::Yellow),
            PlanEntryStatus::Completed => ("●", ratatui::style::Color::Green),
        };

        let status_style = ratatui::style::Style::default().fg(status_color);
        let content_style = ratatui::style::Style::default();

        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(status_icon.to_owned(), status_style),
            Span::raw(" "),
            Span::styled(entry.content.clone(), content_style),
        ]));
    }
}

fn render_markdown_message(
    lines: &mut Vec<Line<'_>>,
    role: &str,
    text: &str,
    normalized_markdown: Option<&str>,
    prefix_style: ratatui::style::Style,
) {
    let source = normalized_markdown.unwrap_or(text);
    let mut result_lines = markdown_to_lines(source);

    // Add role prefix to first line
    if let Some(first_line) = result_lines.first_mut() {
        let mut spans = vec![Span::styled(format!("{}: ", role), prefix_style)];
        spans.append(&mut first_line.spans);
        *first_line = Line::from(spans);
    } else {
        result_lines.push(Line::from(vec![Span::styled(
            format!("{}: ", role),
            prefix_style,
        )]));
    }

    lines.extend(result_lines);
}

/// Convert markdown text to ratatui Lines with syntax highlighting for code blocks
fn markdown_to_lines(source: &str) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut current_spans: Vec<Span<'static>> = Vec::new();

    let parser = Parser::new_ext(source, Options::all());

    let mut in_code_block = false;
    let mut code_lang: Option<String> = None;
    let mut code_content = String::new();

    for event in parser {
        match event {
            MdEvent::Start(Tag::CodeBlock(kind)) => {
                // Flush current line
                if !current_spans.is_empty() {
                    lines.push(Line::from(std::mem::take(&mut current_spans)));
                }
                // Add spacing before code block
                lines.push(Line::from(""));
                in_code_block = true;
                code_lang = match kind {
                    pulldown_cmark::CodeBlockKind::Fenced(lang) => {
                        let lang_str = lang.to_string();
                        if lang_str.is_empty() {
                            None
                        } else {
                            Some(canonical_language_token(&lang_str).into_owned())
                        }
                    }
                    pulldown_cmark::CodeBlockKind::Indented => None,
                };
                code_content.clear();
            }
            MdEvent::End(TagEnd::CodeBlock) => {
                // Highlight and add code block
                let highlighted_lines = highlight_code(&code_content, code_lang.as_deref());
                lines.extend(highlighted_lines);
                // Add spacing after code block
                lines.push(Line::from(""));
                in_code_block = false;
                code_lang = None;
                code_content.clear();
            }
            MdEvent::Text(text) => {
                if in_code_block {
                    code_content.push_str(&text);
                } else {
                    // Handle regular text - split by newlines
                    let text_str = text.to_string();
                    let mut parts = text_str.split('\n').peekable();
                    while let Some(part) = parts.next() {
                        if !part.is_empty() {
                            current_spans.push(Span::raw(part.to_owned()));
                        }
                        if parts.peek().is_some() {
                            lines.push(Line::from(std::mem::take(&mut current_spans)));
                        }
                    }
                }
            }
            MdEvent::Code(code) => {
                // Inline code
                let code_style = ratatui::style::Style::default()
                    .fg(ratatui::style::Color::Yellow)
                    .add_modifier(ratatui::style::Modifier::BOLD);
                current_spans.push(Span::styled(format!("`{}`", code), code_style));
            }
            MdEvent::Start(Tag::Strong) => {
                // We'll handle this by tracking state, but for simplicity just continue
            }
            MdEvent::End(TagEnd::Strong) => {}
            MdEvent::Start(Tag::Emphasis) => {}
            MdEvent::End(TagEnd::Emphasis) => {}
            MdEvent::Start(Tag::Paragraph) => {}
            MdEvent::End(TagEnd::Paragraph) => {
                if !current_spans.is_empty() {
                    lines.push(Line::from(std::mem::take(&mut current_spans)));
                }
            }
            MdEvent::SoftBreak | MdEvent::HardBreak => {
                if !current_spans.is_empty() {
                    lines.push(Line::from(std::mem::take(&mut current_spans)));
                }
            }
            MdEvent::Start(Tag::Heading { level, .. }) => {
                let prefix = "#".repeat(level as usize);
                let header_style = ratatui::style::Style::default()
                    .fg(ratatui::style::Color::Cyan)
                    .add_modifier(ratatui::style::Modifier::BOLD);
                current_spans.push(Span::styled(format!("{} ", prefix), header_style));
            }
            MdEvent::End(TagEnd::Heading(_)) => {
                if !current_spans.is_empty() {
                    lines.push(Line::from(std::mem::take(&mut current_spans)));
                }
            }
            MdEvent::Start(Tag::List(_)) => {}
            MdEvent::End(TagEnd::List(_)) => {}
            MdEvent::Start(Tag::Item) => {
                current_spans.push(Span::raw("• ".to_owned()));
            }
            MdEvent::End(TagEnd::Item) => {
                if !current_spans.is_empty() {
                    lines.push(Line::from(std::mem::take(&mut current_spans)));
                }
            }
            _ => {}
        }
    }

    // Flush remaining spans
    if !current_spans.is_empty() {
        lines.push(Line::from(current_spans));
    }

    lines
}

/// Highlight code using syntect with two-face's extended syntax set
fn highlight_code(code: &str, lang: Option<&str>) -> Vec<Line<'static>> {
    let mut lines = Vec::new();

    // Try to find syntax for the language
    let syntax = lang
        .and_then(|l| SYNTAX_SET.find_syntax_by_token(l))
        .unwrap_or_else(|| SYNTAX_SET.find_syntax_plain_text());

    let theme = &THEME_SET.themes["base16-ocean.dark"];
    let mut highlighter = HighlightLines::new(syntax, theme);

    for line in LinesWithEndings::from(code) {
        match highlighter.highlight_line(line, &SYNTAX_SET) {
            Ok(ranges) => {
                let spans: Vec<Span<'static>> = ranges
                    .into_iter()
                    .map(|(style, text)| {
                        let fg = ratatui::style::Color::Rgb(
                            style.foreground.r,
                            style.foreground.g,
                            style.foreground.b,
                        );
                        let mut ratatui_style = ratatui::style::Style::default().fg(fg);
                        if style
                            .font_style
                            .contains(syntect::highlighting::FontStyle::BOLD)
                        {
                            ratatui_style =
                                ratatui_style.add_modifier(ratatui::style::Modifier::BOLD);
                        }
                        if style
                            .font_style
                            .contains(syntect::highlighting::FontStyle::ITALIC)
                        {
                            ratatui_style =
                                ratatui_style.add_modifier(ratatui::style::Modifier::ITALIC);
                        }
                        Span::styled(text.trim_end_matches('\n').to_owned(), ratatui_style)
                    })
                    .collect();
                lines.push(Line::from(spans));
            }
            Err(_) => {
                // Fallback to plain text
                lines.push(Line::from(line.trim_end_matches('\n').to_owned()));
            }
        }
    }

    lines
}

fn normalize_code_fences(content: &str) -> String {
    let mut normalized = String::with_capacity(content.len());
    for line in content.split_inclusive('\n') {
        let (body, newline) = match line.strip_suffix('\n') {
            Some(stripped) => (stripped, "\n"),
            None => (line, ""),
        };

        if let Some(lang) = body.strip_prefix("```") {
            let lang = lang.trim();
            normalized.push_str("```");
            if !lang.is_empty() {
                let canonical = canonical_language_token(lang);
                normalized.push_str(canonical.as_ref());
            }
        } else {
            normalized.push_str(body);
        }

        normalized.push_str(newline);
    }
    normalized
}

/// Normalize code fence language tokens to syntect-compatible format.
/// Uses two-face's extended syntax set which includes TypeScript, Kotlin, Swift, etc.
/// Run the chat TUI in demo mode with fake conversation data for visual testing
pub async fn run_demo_tui() -> Result<()> {
    let mut stdout = io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    enable_raw_mode()?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let res = run_demo_loop(&mut terminal).await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen,
        DisableBracketedPaste
    )?;
    terminal.show_cursor()?;

    res
}

async fn run_demo_loop<B: ratatui::backend::Backend>(terminal: &mut Terminal<B>) -> Result<()> {
    // Create a dummy channel for demo mode (not used)
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut app = App::new(AcpProvider::default(), tx, String::new(), String::new());
    app.connection_state = ConnectionState::Connected;
    app.history = create_demo_chat_entries();

    let mut reader = EventStream::new();

    loop {
        terminal.draw(|f| ui(f, &mut app))?;

        // Wait for at least one event
        if let Some(Ok(event)) = reader.next().await {
            // Track scroll delta for batched processing
            let mut scroll_delta: i32 = 0;

            if let Some(exit) = process_demo_event(&mut app, event, &mut scroll_delta) {
                if exit {
                    return Ok(());
                }
            }

            // Drain any additional pending events to batch scroll operations
            // This prevents jank when mouse wheel momentum generates many events
            while let Ok(Some(Ok(event))) =
                tokio::time::timeout(std::time::Duration::from_millis(5), reader.next()).await
            {
                if let Some(exit) = process_demo_event(&mut app, event, &mut scroll_delta) {
                    if exit {
                        return Ok(());
                    }
                }
            }

            // Apply accumulated scroll
            if scroll_delta > 0 {
                app.scroll_up(scroll_delta as u16);
            } else if scroll_delta < 0 {
                app.scroll_down((-scroll_delta) as u16);
            }
        }
    }
}

/// Process a single event. Returns Some(true) to exit, Some(false) to continue, None for scroll events.
/// Scroll events accumulate into scroll_delta for batched processing.
fn process_demo_event(app: &mut App, event: Event, scroll_delta: &mut i32) -> Option<bool> {
    match event {
        Event::Key(key) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                match key.code {
                    KeyCode::Char('q') | KeyCode::Char('c') | KeyCode::Char('d') => {
                        return Some(true);
                    }
                    _ => {}
                }
            } else {
                match key.code {
                    KeyCode::PageUp => app.scroll_up(10),
                    KeyCode::PageDown => app.scroll_down(10),
                    KeyCode::Home => app.scroll_to_top(),
                    KeyCode::End => app.scroll_to_bottom(),
                    KeyCode::Char('q') => return Some(true),
                    _ => {}
                }
            }
            Some(false)
        }
        Event::Mouse(mouse_event) => {
            match mouse_event.kind {
                MouseEventKind::ScrollUp => *scroll_delta += 1,
                MouseEventKind::ScrollDown => *scroll_delta -= 1,
                _ => {}
            }
            None // Scroll events are batched, don't signal exit
        }
        _ => Some(false),
    }
}

fn create_demo_chat_entries() -> Vec<ChatEntry> {
    vec![
        // User message
        ChatEntry::Message {
            role: "User".to_string(),
            text: "Can you help me build a web server with authentication?".to_string(),
            normalized_markdown: None,
        },
        // Agent message with comprehensive markdown
        ChatEntry::Message {
            role: "Agent".to_string(),
            text: DEMO_MARKDOWN_CONTENT.to_string(),
            normalized_markdown: Some(normalize_code_fences(DEMO_MARKDOWN_CONTENT)),
        },
        // Thought message
        ChatEntry::Message {
            role: "Thought".to_string(),
            text: "Let me analyze the requirements...\n\nI should:\n1. Check existing code structure\n2. Plan the authentication flow\n3. Implement secure password hashing".to_string(),
            normalized_markdown: Some("Let me analyze the requirements...\n\nI should:\n1. Check existing code structure\n2. Plan the authentication flow\n3. Implement secure password hashing".to_string()),
        },
        // Plan with all statuses
        ChatEntry::Plan(Plan {
            entries: vec![
                agent_client_protocol::PlanEntry {
                    content: "Research authentication patterns".to_string(),
                    priority: PlanEntryPriority::High,
                    status: PlanEntryStatus::Completed,
                    meta: None,
                },
                agent_client_protocol::PlanEntry {
                    content: "Implement JWT token generation".to_string(),
                    priority: PlanEntryPriority::High,
                    status: PlanEntryStatus::Completed,
                    meta: None,
                },
                agent_client_protocol::PlanEntry {
                    content: "Add password hashing with bcrypt".to_string(),
                    priority: PlanEntryPriority::Medium,
                    status: PlanEntryStatus::InProgress,
                    meta: None,
                },
                agent_client_protocol::PlanEntry {
                    content: "Create login/logout endpoints".to_string(),
                    priority: PlanEntryPriority::Medium,
                    status: PlanEntryStatus::Pending,
                    meta: None,
                },
                agent_client_protocol::PlanEntry {
                    content: "Write integration tests".to_string(),
                    priority: PlanEntryPriority::Low,
                    status: PlanEntryStatus::Pending,
                    meta: None,
                },
            ],
            meta: None,
        }),
        // All tool types with different statuses
        // Read - Completed
        ChatEntry::ToolCall {
            id: "tool-1".to_string(),
            title: "Read src/auth/mod.rs".to_string(),
            kind: ToolKind::Read,
            status: ToolCallStatus::Completed,
        },
        // Edit - InProgress
        ChatEntry::ToolCall {
            id: "tool-2".to_string(),
            title: "Edit src/auth/jwt.rs - add token validation".to_string(),
            kind: ToolKind::Edit,
            status: ToolCallStatus::InProgress,
        },
        // Delete - Completed
        ChatEntry::ToolCall {
            id: "tool-3".to_string(),
            title: "Delete src/auth/deprecated.rs".to_string(),
            kind: ToolKind::Delete,
            status: ToolCallStatus::Completed,
        },
        // Move - Completed
        ChatEntry::ToolCall {
            id: "tool-4".to_string(),
            title: "Move src/utils/hash.rs → src/auth/hash.rs".to_string(),
            kind: ToolKind::Move,
            status: ToolCallStatus::Completed,
        },
        // Search - Completed
        ChatEntry::ToolCall {
            id: "tool-5".to_string(),
            title: "Search for \"password\" in src/".to_string(),
            kind: ToolKind::Search,
            status: ToolCallStatus::Completed,
        },
        // Execute - Failed
        ChatEntry::ToolCall {
            id: "tool-6".to_string(),
            title: "Execute: cargo test auth::tests".to_string(),
            kind: ToolKind::Execute,
            status: ToolCallStatus::Failed,
        },
        // Think - Completed
        ChatEntry::ToolCall {
            id: "tool-7".to_string(),
            title: "Analyzing authentication flow".to_string(),
            kind: ToolKind::Think,
            status: ToolCallStatus::Completed,
        },
        // Fetch - Pending
        ChatEntry::ToolCall {
            id: "tool-8".to_string(),
            title: "Fetch https://docs.rs/jsonwebtoken".to_string(),
            kind: ToolKind::Fetch,
            status: ToolCallStatus::Pending,
        },
        // SwitchMode - Completed
        ChatEntry::ToolCall {
            id: "tool-9".to_string(),
            title: "Switch to code-review mode".to_string(),
            kind: ToolKind::SwitchMode,
            status: ToolCallStatus::Completed,
        },
        // Other - InProgress
        ChatEntry::ToolCall {
            id: "tool-10".to_string(),
            title: "Custom: generate-schema".to_string(),
            kind: ToolKind::Other,
            status: ToolCallStatus::InProgress,
        },
        // Another user message
        ChatEntry::Message {
            role: "User".to_string(),
            text: "Great progress! Can you also add rate limiting?".to_string(),
            normalized_markdown: None,
        },
        // Agent response with more code examples
        ChatEntry::Message {
            role: "Agent".to_string(),
            text: DEMO_CODE_EXAMPLES.to_string(),
            normalized_markdown: Some(normalize_code_fences(DEMO_CODE_EXAMPLES)),
        },
    ]
}

const DEMO_MARKDOWN_CONTENT: &str = r#"# Authentication System Design

I'll help you build a secure authentication system. Here's my plan:

## Overview

This implementation will use **JWT tokens** for stateless authentication with `bcrypt` for password hashing.

### Key Components

- **Token Service**: Handles JWT creation and validation
- **Password Hasher**: Secure bcrypt-based hashing
- **Middleware**: Request authentication layer

## Implementation

Here's the core token generation code:

```rust
use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
    iat: usize,
}

fn generate_token(user_id: &str, secret: &[u8]) -> Result<String, Error> {
    let claims = Claims {
        sub: user_id.to_owned(),
        exp: (chrono::Utc::now() + chrono::Duration::hours(24)).timestamp() as usize,
        iat: chrono::Utc::now().timestamp() as usize,
    };

    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret))
}
```

### Password Hashing

```python
import bcrypt

def hash_password(password: str) -> bytes:
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode(), salt)

def verify_password(password: str, hashed: bytes) -> bool:
    return bcrypt.checkpw(password.encode(), hashed)
```

## Configuration

Add these to your `config.toml`:

```toml
[auth]
jwt_secret = "your-secret-key-here"
token_expiry_hours = 24
bcrypt_rounds = 12
```

## API Endpoints

The following endpoints will be created:

• `POST /auth/register` - Create new user account
• `POST /auth/login` - Authenticate and receive token
• `POST /auth/logout` - Invalidate current token
• `GET /auth/me` - Get current user info

### Example Request

```json
{
  "username": "johndoe",
  "password": "secure_password_123",
  "email": "john@example.com"
}
```

## Security Notes

1. Always use HTTPS in production
2. Store secrets in environment variables
3. Implement rate limiting on auth endpoints
4. Use secure cookie settings for token storage

Let me start implementing this now."#;

const DEMO_CODE_EXAMPLES: &str = r#"## Rate Limiting Implementation

I'll add rate limiting using a token bucket algorithm. Here are examples in multiple languages:

### TypeScript Implementation

```typescript
interface RateLimiter {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number;
}

function createRateLimiter(maxTokens: number, refillRate: number): RateLimiter {
  return {
    tokens: maxTokens,
    lastRefill: Date.now(),
    maxTokens,
    refillRate,
  };
}

function tryConsume(limiter: RateLimiter): boolean {
  const now = Date.now();
  const elapsed = (now - limiter.lastRefill) / 1000;
  limiter.tokens = Math.min(limiter.maxTokens, limiter.tokens + elapsed * limiter.refillRate);
  limiter.lastRefill = now;

  if (limiter.tokens >= 1) {
    limiter.tokens -= 1;
    return true;
  }
  return false;
}
```

### Go Implementation

```go
package ratelimit

import (
    "sync"
    "time"
)

type Limiter struct {
    mu         sync.Mutex
    tokens     float64
    maxTokens  float64
    refillRate float64
    lastRefill time.Time
}

func NewLimiter(maxTokens, refillRate float64) *Limiter {
    return &Limiter{
        tokens:     maxTokens,
        maxTokens:  maxTokens,
        refillRate: refillRate,
        lastRefill: time.Now(),
    }
}

func (l *Limiter) Allow() bool {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()
    elapsed := now.Sub(l.lastRefill).Seconds()
    l.tokens = min(l.maxTokens, l.tokens+elapsed*l.refillRate)
    l.lastRefill = now

    if l.tokens >= 1 {
        l.tokens--
        return true
    }
    return false
}
```

### SQL Schema

```sql
CREATE TABLE rate_limits (
    id SERIAL PRIMARY KEY,
    client_id VARCHAR(255) NOT NULL,
    tokens DECIMAL(10, 2) NOT NULL,
    last_refill TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(client_id)
);

CREATE INDEX idx_rate_limits_client ON rate_limits(client_id);
```

### Shell Script for Testing

```bash
#!/bin/bash
# Test rate limiting endpoint

for i in {1..20}; do
    response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/test)
    echo "Request $i: HTTP $response"
    sleep 0.1
done
```

### YAML Configuration

```yaml
rate_limiting:
  enabled: true
  default_limits:
    requests_per_minute: 60
    burst_size: 10
  endpoints:
    /auth/login:
      requests_per_minute: 5
      burst_size: 2
    /api/heavy:
      requests_per_minute: 10
      burst_size: 3
```

The rate limiter is now ready to use with your authentication system!"#;

fn canonical_language_token(lang: &str) -> Cow<'static, str> {
    let trimmed = lang.trim_start_matches('.');
    let lower = trimmed.to_ascii_lowercase();
    match lower.as_str() {
        // JavaScript variants
        "js" | "javascript" | "node" => Cow::Borrowed("javascript"),
        "jsx" => Cow::Borrowed("jsx"),
        // TypeScript variants (two-face includes TypeScript support)
        "ts" | "typescript" => Cow::Borrowed("typescript"),
        "tsx" => Cow::Borrowed("tsx"),
        // Python
        "py" | "python" => Cow::Borrowed("python"),
        // Ruby
        "rb" | "ruby" => Cow::Borrowed("ruby"),
        // Rust
        "rs" | "rust" => Cow::Borrowed("rust"),
        // Go
        "go" | "golang" => Cow::Borrowed("go"),
        // Java
        "java" => Cow::Borrowed("java"),
        // Kotlin
        "kt" | "kotlin" => Cow::Borrowed("kotlin"),
        // Swift
        "swift" => Cow::Borrowed("swift"),
        // PHP
        "php" => Cow::Borrowed("php"),
        // Shell variants
        "sh" | "bash" | "shell" => Cow::Borrowed("bash"),
        "zsh" => Cow::Borrowed("zsh"),
        "ps" | "ps1" | "powershell" => Cow::Borrowed("powershell"),
        // C family
        "c" => Cow::Borrowed("c"),
        "cpp" | "c++" | "cxx" => Cow::Borrowed("cpp"),
        "cs" | "csharp" | "c#" => Cow::Borrowed("cs"),
        // Objective-C
        "objc" | "objective-c" | "objectivec" => Cow::Borrowed("objective-c"),
        // Data formats
        "json" => Cow::Borrowed("json"),
        "yaml" | "yml" => Cow::Borrowed("yaml"),
        "toml" => Cow::Borrowed("toml"),
        "xml" => Cow::Borrowed("xml"),
        // SQL
        "sql" => Cow::Borrowed("sql"),
        // Web
        "html" | "htm" => Cow::Borrowed("html"),
        "css" => Cow::Borrowed("css"),
        "scss" => Cow::Borrowed("scss"),
        "less" => Cow::Borrowed("less"),
        // Other languages
        "elixir" | "ex" | "exs" => Cow::Borrowed("elixir"),
        "dart" => Cow::Borrowed("dart"),
        "scala" => Cow::Borrowed("scala"),
        "clojure" | "clj" => Cow::Borrowed("clojure"),
        "haskell" | "hs" => Cow::Borrowed("haskell"),
        "lua" => Cow::Borrowed("lua"),
        "perl" | "pl" => Cow::Borrowed("perl"),
        "r" => Cow::Borrowed("r"),
        "julia" | "jl" => Cow::Borrowed("julia"),
        "erlang" | "erl" => Cow::Borrowed("erlang"),
        "groovy" => Cow::Borrowed("groovy"),
        // Markup
        "markdown" | "md" => Cow::Borrowed("markdown"),
        "tex" | "latex" => Cow::Borrowed("latex"),
        "rst" | "restructuredtext" => Cow::Borrowed("restructuredtext"),
        // Config files
        "ini" | "cfg" => Cow::Borrowed("ini"),
        "dockerfile" | "docker" => Cow::Borrowed("dockerfile"),
        "makefile" | "make" => Cow::Borrowed("makefile"),
        // Default: pass through as-is (lowercase)
        _ => Cow::Owned(lower),
    }
}
