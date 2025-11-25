use tokio::sync::mpsc;

use crate::mux::commands::MuxCommand;
use crate::mux::events::MuxEvent;
use crate::mux::layout::{Direction, NavDirection, Pane, PaneId, Workspace};
use crate::mux::palette::CommandPalette;
use crate::mux::sidebar::Sidebar;
use crate::mux::terminal::{SharedTerminalManager, TerminalBuffer};

/// Which area of the UI has focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusArea {
    Sidebar,
    MainArea,
    CommandPalette,
}

/// The main application state for the multiplexer.
pub struct MuxApp<'a> {
    // Core state
    pub workspace: Workspace,
    pub sidebar: Sidebar,
    pub command_palette: CommandPalette<'a>,
    pub focus: FocusArea,

    // Zoom state
    pub zoomed_pane: Option<crate::mux::layout::PaneId>,

    // Help overlay
    pub show_help: bool,

    // Event channel
    pub event_tx: mpsc::UnboundedSender<MuxEvent>,

    // Base URL for API calls
    pub base_url: String,

    // Status message to display
    pub status_message: Option<(String, std::time::Instant)>,

    // Tab rename state
    pub renaming_tab: bool,
    pub rename_input: Option<tui_textarea::TextArea<'a>>,

    // Terminal manager for handling sandbox connections
    pub terminal_manager: Option<SharedTerminalManager>,

    // Currently selected sandbox ID (for terminal attachment)
    pub selected_sandbox_id: Option<String>,

    // Flag to indicate we need to create a sandbox on startup
    pub needs_initial_sandbox: bool,
}

impl<'a> MuxApp<'a> {
    pub fn new(base_url: String, event_tx: mpsc::UnboundedSender<MuxEvent>) -> Self {
        Self {
            workspace: Workspace::new(),
            sidebar: Sidebar::new(),
            command_palette: CommandPalette::new(),
            focus: FocusArea::MainArea,
            zoomed_pane: None,
            show_help: false,
            event_tx,
            base_url,
            status_message: None,
            renaming_tab: false,
            rename_input: None,
            terminal_manager: None,
            selected_sandbox_id: None,
            needs_initial_sandbox: false,
        }
    }

    /// Set the terminal manager
    pub fn set_terminal_manager(&mut self, manager: SharedTerminalManager) {
        self.terminal_manager = Some(manager);
    }

    /// Get the terminal buffer for a pane (blocking version for UI rendering)
    pub fn get_terminal_buffer(&self, pane_id: PaneId) -> Option<TerminalBuffer> {
        let manager = self.terminal_manager.as_ref()?;
        // We need to use try_lock for non-async context
        let guard = manager.try_lock().ok()?;
        guard.get_buffer(pane_id).cloned()
    }

    /// Get the active pane ID
    pub fn active_pane_id(&self) -> Option<PaneId> {
        self.workspace.active_tab().and_then(|tab| tab.active_pane)
    }

    /// Set a status message that will be displayed temporarily.
    pub fn set_status(&mut self, message: impl Into<String>) {
        self.status_message = Some((message.into(), std::time::Instant::now()));
    }

    /// Clear expired status messages.
    pub fn clear_expired_status(&mut self) {
        if let Some((_, time)) = &self.status_message {
            if time.elapsed() > std::time::Duration::from_secs(3) {
                self.status_message = None;
            }
        }
    }

    /// Execute a command.
    pub fn execute_command(&mut self, cmd: MuxCommand) {
        match cmd {
            // Navigation
            MuxCommand::FocusLeft => {
                if self.focus == FocusArea::MainArea {
                    if let Some(tab) = self.workspace.active_tab_mut() {
                        tab.navigate(NavDirection::Left);
                    }
                }
            }
            MuxCommand::FocusRight => {
                if self.focus == FocusArea::MainArea {
                    if let Some(tab) = self.workspace.active_tab_mut() {
                        tab.navigate(NavDirection::Right);
                    }
                }
            }
            MuxCommand::FocusUp => {
                if self.focus == FocusArea::MainArea {
                    if let Some(tab) = self.workspace.active_tab_mut() {
                        tab.navigate(NavDirection::Up);
                    }
                } else if self.focus == FocusArea::Sidebar {
                    self.sidebar.select_previous();
                }
            }
            MuxCommand::FocusDown => {
                if self.focus == FocusArea::MainArea {
                    if let Some(tab) = self.workspace.active_tab_mut() {
                        tab.navigate(NavDirection::Down);
                    }
                } else if self.focus == FocusArea::Sidebar {
                    self.sidebar.select_next();
                }
            }
            MuxCommand::FocusSidebar => {
                if self.sidebar.visible {
                    self.focus = FocusArea::Sidebar;
                }
            }
            MuxCommand::FocusMainArea => {
                self.focus = FocusArea::MainArea;
            }
            MuxCommand::NextPane => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.next_pane();
                }
            }
            MuxCommand::PrevPane => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.prev_pane();
                }
            }
            MuxCommand::NextTab => self.workspace.next_tab(),
            MuxCommand::PrevTab => self.workspace.prev_tab(),
            MuxCommand::GoToTab1 => self.workspace.go_to_tab(0),
            MuxCommand::GoToTab2 => self.workspace.go_to_tab(1),
            MuxCommand::GoToTab3 => self.workspace.go_to_tab(2),
            MuxCommand::GoToTab4 => self.workspace.go_to_tab(3),
            MuxCommand::GoToTab5 => self.workspace.go_to_tab(4),
            MuxCommand::GoToTab6 => self.workspace.go_to_tab(5),
            MuxCommand::GoToTab7 => self.workspace.go_to_tab(6),
            MuxCommand::GoToTab8 => self.workspace.go_to_tab(7),
            MuxCommand::GoToTab9 => self.workspace.go_to_tab(8),

            // Pane management
            MuxCommand::SplitHorizontal => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.split(Direction::Horizontal, Pane::terminal(None, "Terminal"));
                    self.set_status("Split horizontally");
                }
            }
            MuxCommand::SplitVertical => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.split(Direction::Vertical, Pane::terminal(None, "Terminal"));
                    self.set_status("Split vertically");
                }
            }
            MuxCommand::ClosePane => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    if tab.close_active_pane() {
                        self.set_status("Pane closed");
                    }
                }
            }
            MuxCommand::ToggleZoom => {
                if let Some(tab) = self.workspace.active_tab() {
                    if self.zoomed_pane.is_some() {
                        self.zoomed_pane = None;
                        self.set_status("Zoom off");
                    } else if let Some(pane_id) = tab.active_pane {
                        self.zoomed_pane = Some(pane_id);
                        self.set_status("Zoom on");
                    }
                }
            }
            MuxCommand::SwapPaneLeft
            | MuxCommand::SwapPaneRight
            | MuxCommand::SwapPaneUp
            | MuxCommand::SwapPaneDown => {
                self.set_status("Pane swapping not yet implemented");
            }
            MuxCommand::ResizeLeft => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.resize(NavDirection::Left, 0.05);
                }
            }
            MuxCommand::ResizeRight => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.resize(NavDirection::Right, 0.05);
                }
            }
            MuxCommand::ResizeUp => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.resize(NavDirection::Up, 0.05);
                }
            }
            MuxCommand::ResizeDown => {
                if let Some(tab) = self.workspace.active_tab_mut() {
                    tab.resize(NavDirection::Down, 0.05);
                }
            }

            // Tab management
            MuxCommand::NewTab => {
                self.workspace.new_tab();
                self.set_status("New tab created");
            }
            MuxCommand::CloseTab => {
                if self.workspace.close_active_tab() {
                    self.set_status("Tab closed");
                }
            }
            MuxCommand::RenameTab => {
                self.start_tab_rename();
            }
            MuxCommand::MoveTabLeft => {
                self.workspace.move_tab_left();
            }
            MuxCommand::MoveTabRight => {
                self.workspace.move_tab_right();
            }

            // Sidebar - Ctrl+S toggles focus between sidebar and main area
            MuxCommand::ToggleSidebar => {
                // Ensure sidebar is visible
                if !self.sidebar.visible {
                    self.sidebar.visible = true;
                }
                // Toggle focus
                if self.focus == FocusArea::Sidebar {
                    self.focus = FocusArea::MainArea;
                } else {
                    self.focus = FocusArea::Sidebar;
                }
            }
            MuxCommand::SelectSandbox => {
                if self.focus == FocusArea::Sidebar {
                    if let Some(sandbox) = self.sidebar.selected_sandbox() {
                        self.selected_sandbox_id = Some(sandbox.id.to_string());
                        self.set_status(format!("Selected: {}", sandbox.name));
                        // Switch to main area after selection
                        self.focus = FocusArea::MainArea;
                    }
                }
            }

            // Sandbox management
            MuxCommand::NewSandbox => {
                self.set_status("Creating new sandbox...");
                let _ = self.event_tx.send(MuxEvent::Notification {
                    message: "Creating sandbox...".to_string(),
                    level: crate::mux::events::NotificationLevel::Info,
                });
            }
            MuxCommand::DeleteSandbox => {
                if let Some(sandbox) = self.sidebar.selected_sandbox() {
                    self.set_status(format!("Deleting sandbox: {}", sandbox.name));
                } else {
                    self.set_status("No sandbox selected");
                }
            }
            MuxCommand::RefreshSandboxes => {
                self.set_status("Refreshing sandboxes...");
            }

            // Session
            MuxCommand::NewSession => {
                self.set_status("Creating new session...");
            }
            MuxCommand::AttachSandbox => {
                if let Some(sandbox_id) = &self.selected_sandbox_id {
                    self.set_status(format!("Attaching to sandbox: {}", sandbox_id));
                } else if let Some(sandbox) = self.sidebar.selected_sandbox() {
                    self.selected_sandbox_id = Some(sandbox.id.to_string());
                    self.set_status(format!("Attaching to sandbox: {}", sandbox.name));
                } else {
                    self.set_status("No sandbox selected");
                }
            }
            MuxCommand::DetachSandbox => {
                self.set_status("Detaching from sandbox...");
                self.selected_sandbox_id = None;
            }

            // UI
            MuxCommand::OpenCommandPalette => {
                self.command_palette.open();
                self.focus = FocusArea::CommandPalette;
            }
            MuxCommand::ToggleHelp => {
                self.show_help = !self.show_help;
            }
            MuxCommand::Quit => {
                // Handled by the runner
            }

            // Scrolling (handled in pane content)
            MuxCommand::ScrollUp
            | MuxCommand::ScrollDown
            | MuxCommand::ScrollPageUp
            | MuxCommand::ScrollPageDown
            | MuxCommand::ScrollToTop
            | MuxCommand::ScrollToBottom => {
                // TODO: Forward to active pane
            }
        }
    }

    /// Close the command palette.
    pub fn close_command_palette(&mut self) {
        self.command_palette.close();
        self.focus = FocusArea::MainArea;
    }

    /// Start tab rename mode.
    fn start_tab_rename(&mut self) {
        if let Some(tab) = self.workspace.active_tab() {
            let mut input = tui_textarea::TextArea::default();
            input.insert_str(&tab.name);
            self.rename_input = Some(input);
            self.renaming_tab = true;
        }
    }

    /// Finish tab rename.
    pub fn finish_tab_rename(&mut self, apply: bool) {
        if apply {
            if let Some(input) = &self.rename_input {
                let new_name = input.lines().join("");
                if !new_name.is_empty() {
                    self.workspace.rename_active_tab(new_name);
                }
            }
        }
        self.rename_input = None;
        self.renaming_tab = false;
    }

    /// Handle an event.
    pub fn handle_event(&mut self, event: MuxEvent) {
        match event {
            MuxEvent::SandboxesRefreshed(sandboxes) => {
                self.sidebar.set_sandboxes(sandboxes);
            }
            MuxEvent::SandboxRefreshFailed(error) => {
                self.sidebar.set_error(error.clone());
                self.set_status(format!("Error: {}", error));
            }
            MuxEvent::SandboxCreated(sandbox) => {
                self.set_status(format!("Created sandbox: {}", sandbox.name));
            }
            MuxEvent::SandboxDeleted(id) => {
                self.set_status(format!("Deleted sandbox: {}", id));
            }
            MuxEvent::SandboxConnectionChanged {
                sandbox_id,
                connected,
            } => {
                let state = if connected {
                    "connected"
                } else {
                    "disconnected"
                };
                self.set_status(format!("Sandbox {}: {}", sandbox_id, state));
            }
            MuxEvent::TerminalOutput { .. } => {
                // TODO: Forward to appropriate pane
            }
            MuxEvent::Error(msg) => {
                self.set_status(format!("Error: {}", msg));
            }
            MuxEvent::Notification { message, .. } => {
                self.set_status(message);
            }
            MuxEvent::ConnectToSandbox { sandbox_id } => {
                // This is handled in the runner, just update status here
                self.selected_sandbox_id = Some(sandbox_id.clone());
                self.set_status(format!("Connecting to sandbox: {}", sandbox_id));
            }
        }
    }
}
