use anyhow::Result;
use crossterm::{
    event::{
        DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, EventStream, KeyCode, KeyModifiers,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures::StreamExt;
use ratatui::{backend::CrosstermBackend, Terminal};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::mux::commands::MuxCommand;
use crate::mux::events::MuxEvent;
use crate::mux::state::{FocusArea, MuxApp};
use crate::mux::terminal::{
    connect_to_sandbox, create_and_connect_sandbox, create_terminal_manager,
};
use crate::mux::ui::ui;

/// Run the multiplexer TUI.
///
/// If `workspace_path` is provided, a new sandbox will be created and the directory
/// will be uploaded to it. Otherwise, it uses the default behavior.
pub async fn run_mux_tui(base_url: String, workspace_path: Option<PathBuf>) -> Result<()> {
    let mut stdout = std::io::stdout();
    execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    )?;
    enable_raw_mode()?;

    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let result = run_main_loop(&mut terminal, base_url, workspace_path).await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen,
        DisableBracketedPaste
    )?;
    terminal.show_cursor()?;

    result
}

async fn run_main_loop<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    base_url: String,
    workspace_path: Option<PathBuf>,
) -> Result<()> {
    let (event_tx, event_rx) = mpsc::unbounded_channel();

    let mut app = MuxApp::new(base_url.clone(), event_tx.clone());

    // Create terminal manager
    let terminal_manager = create_terminal_manager(base_url.clone(), event_tx.clone());
    app.set_terminal_manager(terminal_manager.clone());

    // Start background task to periodically refresh sandboxes
    let refresh_tx = event_tx.clone();
    let refresh_url = base_url.clone();
    tokio::spawn(async move {
        refresh_sandboxes_periodically(refresh_url, refresh_tx).await;
    });

    // Always create a new sandbox on startup with the current working directory
    let init_tx = event_tx.clone();
    let init_url = base_url.clone();
    let workspace = workspace_path
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    tokio::spawn(async move {
        // First refresh to populate sidebar
        let _ = refresh_sandboxes(&init_url, &init_tx).await;

        // Create a new sandbox
        let _ = init_tx.send(MuxEvent::Notification {
            message: "Creating new sandbox...".to_string(),
            level: crate::mux::events::NotificationLevel::Info,
        });

        // Get directory name for sandbox name
        let dir_name = workspace
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "workspace".to_string());

        // Create sandbox via API
        let client = reqwest::Client::new();
        let url = format!("{}/sandboxes", init_url.trim_end_matches('/'));
        let body = crate::models::CreateSandboxRequest {
            name: Some(dir_name.clone()),
            workspace: None,
            read_only_paths: vec![],
            tmpfs: vec![],
            env: vec![],
        };

        match client.post(&url).json(&body).send().await {
            Ok(response) if response.status().is_success() => {
                if let Ok(summary) = response.json::<crate::models::SandboxSummary>().await {
                    let sandbox_id = summary.id.to_string();

                    // Upload workspace directory
                    let _ = init_tx.send(MuxEvent::Notification {
                        message: format!("Uploading {}...", dir_name),
                        level: crate::mux::events::NotificationLevel::Info,
                    });

                    if let Err(e) =
                        upload_workspace(&client, &init_url, &sandbox_id, &workspace).await
                    {
                        let _ = init_tx.send(MuxEvent::Error(format!(
                            "Failed to upload workspace: {}",
                            e
                        )));
                    }

                    let _ = init_tx.send(MuxEvent::Notification {
                        message: format!("Created sandbox: {}", sandbox_id),
                        level: crate::mux::events::NotificationLevel::Info,
                    });

                    // Request connection to the new sandbox
                    let _ = init_tx.send(MuxEvent::ConnectToSandbox { sandbox_id });

                    // Refresh to show the new sandbox
                    let _ = refresh_sandboxes(&init_url, &init_tx).await;
                }
            }
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                let _ = init_tx.send(MuxEvent::Error(format!(
                    "Failed to create sandbox: {} - {}",
                    status, text
                )));
            }
            Err(e) => {
                let _ = init_tx.send(MuxEvent::Error(format!("Failed to create sandbox: {}", e)));
            }
        }
    });

    run_app(terminal, app, event_rx, terminal_manager).await
}

async fn run_app<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    mut app: MuxApp<'_>,
    mut event_rx: mpsc::UnboundedReceiver<MuxEvent>,
    terminal_manager: crate::mux::terminal::SharedTerminalManager,
) -> Result<()> {
    let mut reader = EventStream::new();
    let base_url = app.base_url.clone();

    loop {
        terminal.draw(|f| ui(f, &mut app))?;

        tokio::select! {
            Some(event) = event_rx.recv() => {
                // Handle connect to sandbox request
                if let MuxEvent::ConnectToSandbox { ref sandbox_id } = event {
                    if let Some(pane_id) = app.active_pane_id() {
                        let manager = terminal_manager.clone();
                        let sandbox_id = sandbox_id.clone();
                        let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
                        let event_tx = app.event_tx.clone();

                        tokio::spawn(async move {
                            if let Err(e) = connect_to_sandbox(
                                manager,
                                pane_id,
                                sandbox_id.clone(),
                                cols,
                                rows,
                            ).await {
                                let _ = event_tx.send(MuxEvent::Error(format!(
                                    "Failed to connect to sandbox: {}",
                                    e
                                )));
                            }
                        });
                    }
                }
                // Handle sandbox creation request
                else if let MuxEvent::Notification { ref message, .. } = event {
                    if message.contains("Creating sandbox") {
                        // Spawn sandbox creation task
                        let manager = terminal_manager.clone();
                        let pane_id = app.active_pane_id();
                        let event_tx = app.event_tx.clone();
                        let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));

                        if let Some(pane_id) = pane_id {
                            tokio::spawn(async move {
                                match create_and_connect_sandbox(
                                    manager,
                                    pane_id,
                                    Some("interactive".to_string()),
                                    cols,
                                    rows,
                                ).await {
                                    Ok(sandbox_id) => {
                                        let _ = event_tx.send(MuxEvent::Notification {
                                            message: format!("Created sandbox: {}", sandbox_id),
                                            level: crate::mux::events::NotificationLevel::Info,
                                        });
                                        // Trigger refresh
                                        let _ = event_tx.send(MuxEvent::Notification {
                                            message: "Refreshing sandboxes...".to_string(),
                                            level: crate::mux::events::NotificationLevel::Info,
                                        });
                                    }
                                    Err(e) => {
                                        let _ = event_tx.send(MuxEvent::Error(format!(
                                            "Failed to create sandbox: {}",
                                            e
                                        )));
                                    }
                                }
                            });
                        }
                    } else if message.contains("Refreshing sandboxes") {
                        // Trigger a refresh
                        let url = base_url.clone();
                        let tx = app.event_tx.clone();
                        tokio::spawn(async move {
                            let _ = refresh_sandboxes(&url, &tx).await;
                        });
                    }
                }
                app.handle_event(event);
            }
            Some(Ok(event)) = reader.next() => {
                if handle_input(&mut app, event, &terminal_manager).await {
                    break;
                }
            }
        }
    }

    Ok(())
}

/// Handle input events. Returns true if the app should quit.
async fn handle_input(
    app: &mut MuxApp<'_>,
    event: Event,
    terminal_manager: &crate::mux::terminal::SharedTerminalManager,
) -> bool {
    match event {
        Event::Key(key) => {
            // Handle tab rename mode
            if app.renaming_tab {
                match key.code {
                    KeyCode::Enter => {
                        app.finish_tab_rename(true);
                        return false;
                    }
                    KeyCode::Esc => {
                        app.finish_tab_rename(false);
                        return false;
                    }
                    _ => {
                        if let Some(input) = &mut app.rename_input {
                            input.input(key);
                        }
                        return false;
                    }
                }
            }

            // Handle command palette mode
            if app.focus == FocusArea::CommandPalette {
                match key.code {
                    KeyCode::Esc => {
                        app.close_command_palette();
                        return false;
                    }
                    KeyCode::Enter => {
                        if let Some(cmd) = app.command_palette.execute_selection() {
                            app.focus = FocusArea::MainArea;
                            if cmd == MuxCommand::Quit {
                                return true;
                            }
                            app.execute_command(cmd);
                        }
                        return false;
                    }
                    KeyCode::Up => {
                        app.command_palette.select_up();
                        return false;
                    }
                    KeyCode::Down => {
                        app.command_palette.select_down();
                        return false;
                    }
                    _ if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        match key.code {
                            KeyCode::Char('p') | KeyCode::Char('k') => {
                                app.command_palette.select_up();
                            }
                            KeyCode::Char('n') | KeyCode::Char('j') => {
                                app.command_palette.select_down();
                            }
                            KeyCode::Char('c') => {
                                app.close_command_palette();
                            }
                            _ => {
                                app.command_palette.handle_input(key);
                            }
                        }
                        return false;
                    }
                    _ => {
                        app.command_palette.handle_input(key);
                        return false;
                    }
                }
            }

            // Check for command keybindings first
            if let Some(cmd) = MuxCommand::from_key(key.modifiers, key.code) {
                if cmd == MuxCommand::Quit {
                    return true;
                }
                app.execute_command(cmd);
                return false;
            }

            // Handle focus-specific inputs
            match app.focus {
                FocusArea::Sidebar => {
                    match key.code {
                        KeyCode::Up | KeyCode::Char('k') => {
                            app.sidebar.select_previous();
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            app.sidebar.select_next();
                        }
                        KeyCode::Enter => {
                            // Select sandbox and connect terminal
                            if let Some(sandbox) = app.sidebar.selected_sandbox() {
                                let sandbox_id = sandbox.id.to_string();
                                let sandbox_name = sandbox.name.clone();
                                app.selected_sandbox_id = Some(sandbox_id.clone());
                                app.set_status(format!("Selected: {}", sandbox_name));

                                // Connect to the sandbox terminal
                                if let Some(pane_id) = app.active_pane_id() {
                                    let manager = terminal_manager.clone();
                                    let (cols, rows) =
                                        crossterm::terminal::size().unwrap_or((80, 24));
                                    let event_tx = app.event_tx.clone();

                                    tokio::spawn(async move {
                                        if let Err(e) = connect_to_sandbox(
                                            manager,
                                            pane_id,
                                            sandbox_id.clone(),
                                            cols,
                                            rows,
                                        )
                                        .await
                                        {
                                            let _ = event_tx.send(MuxEvent::Error(format!(
                                                "Failed to connect: {}",
                                                e
                                            )));
                                        }
                                    });
                                }
                            }
                            app.focus = FocusArea::MainArea;
                        }
                        KeyCode::Esc => {
                            app.focus = FocusArea::MainArea;
                        }
                        KeyCode::Tab => {
                            app.focus = FocusArea::MainArea;
                        }
                        _ => {}
                    }
                }
                FocusArea::MainArea => {
                    // Check if we should forward input to the terminal
                    let should_forward = if let Some(pane_id) = app.active_pane_id() {
                        let guard = terminal_manager.try_lock();
                        guard.map(|g| g.is_connected(pane_id)).unwrap_or(false)
                    } else {
                        false
                    };

                    if should_forward {
                        // Forward input to terminal
                        if let Some(pane_id) = app.active_pane_id() {
                            let input = key_to_terminal_input(key.modifiers, key.code);
                            if !input.is_empty() {
                                if let Ok(guard) = terminal_manager.try_lock() {
                                    guard.send_input(pane_id, input);
                                }
                            }
                        }
                    } else {
                        // Handle vim-style navigation when not connected
                        match key.code {
                            KeyCode::Char('h')
                                if !key.modifiers.contains(KeyModifiers::CONTROL) =>
                            {
                                if let Some(tab) = app.workspace.active_tab_mut() {
                                    tab.navigate(crate::mux::layout::NavDirection::Left);
                                }
                            }
                            KeyCode::Char('j')
                                if !key.modifiers.contains(KeyModifiers::CONTROL) =>
                            {
                                if let Some(tab) = app.workspace.active_tab_mut() {
                                    tab.navigate(crate::mux::layout::NavDirection::Down);
                                }
                            }
                            KeyCode::Char('k')
                                if !key.modifiers.contains(KeyModifiers::CONTROL) =>
                            {
                                if let Some(tab) = app.workspace.active_tab_mut() {
                                    tab.navigate(crate::mux::layout::NavDirection::Up);
                                }
                            }
                            KeyCode::Char('l')
                                if !key.modifiers.contains(KeyModifiers::CONTROL) =>
                            {
                                if let Some(tab) = app.workspace.active_tab_mut() {
                                    tab.navigate(crate::mux::layout::NavDirection::Right);
                                }
                            }
                            KeyCode::Tab => {
                                if app.sidebar.visible {
                                    app.focus = FocusArea::Sidebar;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                FocusArea::CommandPalette => {
                    // Already handled above
                }
            }
        }
        Event::Mouse(mouse_event) => {
            // Handle mouse events (scrolling, clicking)
            use crossterm::event::MouseEventKind;
            match mouse_event.kind {
                MouseEventKind::ScrollUp => {
                    if let Some(pane_id) = app.active_pane_id() {
                        if let Ok(mut guard) = terminal_manager.try_lock() {
                            if let Some(buffer) = guard.get_buffer_mut(pane_id) {
                                buffer.scroll_up(3);
                            }
                        }
                    }
                }
                MouseEventKind::ScrollDown => {
                    if let Some(pane_id) = app.active_pane_id() {
                        if let Ok(mut guard) = terminal_manager.try_lock() {
                            if let Some(buffer) = guard.get_buffer_mut(pane_id) {
                                buffer.scroll_down(3);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        Event::Paste(text) => {
            // Forward paste to active terminal
            if let Some(pane_id) = app.active_pane_id() {
                if let Ok(guard) = terminal_manager.try_lock() {
                    guard.send_input(pane_id, text.into_bytes());
                }
            }
        }
        Event::Resize(cols, rows) => {
            // Resize active terminal
            if let Some(pane_id) = app.active_pane_id() {
                if let Ok(mut guard) = terminal_manager.try_lock() {
                    guard.resize(pane_id, rows, cols);
                }
            }
        }
        _ => {}
    }

    false
}

/// Convert a key event to terminal input bytes
fn key_to_terminal_input(modifiers: KeyModifiers, code: KeyCode) -> Vec<u8> {
    match code {
        KeyCode::Char(c) => {
            if modifiers.contains(KeyModifiers::CONTROL) {
                // Ctrl+A = 0x01, Ctrl+B = 0x02, etc.
                let ctrl_code = (c.to_ascii_lowercase() as u8).saturating_sub(b'a' - 1);
                if (1..=26).contains(&ctrl_code) {
                    return vec![ctrl_code];
                }
            }
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            s.as_bytes().to_vec()
        }
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Up => vec![0x1b, b'[', b'A'],
        KeyCode::Down => vec![0x1b, b'[', b'B'],
        KeyCode::Right => vec![0x1b, b'[', b'C'],
        KeyCode::Left => vec![0x1b, b'[', b'D'],
        KeyCode::Home => vec![0x1b, b'[', b'H'],
        KeyCode::End => vec![0x1b, b'[', b'F'],
        KeyCode::PageUp => vec![0x1b, b'[', b'5', b'~'],
        KeyCode::PageDown => vec![0x1b, b'[', b'6', b'~'],
        KeyCode::Delete => vec![0x1b, b'[', b'3', b'~'],
        KeyCode::Insert => vec![0x1b, b'[', b'2', b'~'],
        KeyCode::F(n) => {
            // F1-F4 use different sequences than F5+
            match n {
                1 => vec![0x1b, b'O', b'P'],
                2 => vec![0x1b, b'O', b'Q'],
                3 => vec![0x1b, b'O', b'R'],
                4 => vec![0x1b, b'O', b'S'],
                5 => vec![0x1b, b'[', b'1', b'5', b'~'],
                6 => vec![0x1b, b'[', b'1', b'7', b'~'],
                7 => vec![0x1b, b'[', b'1', b'8', b'~'],
                8 => vec![0x1b, b'[', b'1', b'9', b'~'],
                9 => vec![0x1b, b'[', b'2', b'0', b'~'],
                10 => vec![0x1b, b'[', b'2', b'1', b'~'],
                11 => vec![0x1b, b'[', b'2', b'3', b'~'],
                12 => vec![0x1b, b'[', b'2', b'4', b'~'],
                _ => vec![],
            }
        }
        _ => vec![],
    }
}

/// Periodically refresh the sandbox list.
async fn refresh_sandboxes_periodically(base_url: String, tx: mpsc::UnboundedSender<MuxEvent>) {
    let mut interval = tokio::time::interval(Duration::from_secs(10));
    loop {
        interval.tick().await;
        if let Err(e) = refresh_sandboxes(&base_url, &tx).await {
            let _ = tx.send(MuxEvent::SandboxRefreshFailed(e.to_string()));
        }
    }
}

/// Refresh the sandbox list from the server.
async fn refresh_sandboxes(
    base_url: &str,
    tx: &mpsc::UnboundedSender<MuxEvent>,
) -> Result<Vec<crate::models::SandboxSummary>, anyhow::Error> {
    let client = reqwest::Client::new();
    let url = format!("{}/sandboxes", base_url.trim_end_matches('/'));

    let response = client
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "Failed to fetch sandboxes: {}",
            response.status()
        ));
    }

    let sandboxes: Vec<crate::models::SandboxSummary> = response.json().await?;
    let _ = tx.send(MuxEvent::SandboxesRefreshed(sandboxes.clone()));

    Ok(sandboxes)
}

/// Upload a workspace directory to a sandbox.
async fn upload_workspace(
    client: &reqwest::Client,
    base_url: &str,
    sandbox_id: &str,
    workspace: &std::path::Path,
) -> Result<(), anyhow::Error> {
    use std::io::Write;

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(10);

    // Clone workspace path for the blocking task
    let workspace_owned = workspace.to_path_buf();

    tokio::task::spawn_blocking(move || {
        struct ChunkedWriter {
            sender: tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>,
        }

        impl Write for ChunkedWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                let data = buf.to_vec();
                match self.sender.blocking_send(Ok(data)) {
                    Ok(_) => Ok(buf.len()),
                    Err(_) => Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "Channel closed",
                    )),
                }
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let writer = ChunkedWriter { sender: tx.clone() };
        let mut tar = tar::Builder::new(writer);
        tar.follow_symlinks(false);

        let root = match workspace_owned.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                let _ = tx.blocking_send(Err(std::io::Error::other(e)));
                return;
            }
        };

        // Use ignore crate to respect .gitignore
        let walker = ignore::WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .build();

        for result in walker {
            let entry = match result {
                Ok(entry) => entry,
                Err(err) => {
                    let _ = tx.blocking_send(Err(std::io::Error::other(err)));
                    return;
                }
            };

            let entry_path = entry.path();
            if entry_path == root {
                continue;
            }

            let relative_path = match entry_path.strip_prefix(&root) {
                Ok(p) => p,
                Err(err) => {
                    let _ = tx.blocking_send(Err(std::io::Error::other(err)));
                    return;
                }
            };

            let metadata = match std::fs::symlink_metadata(entry_path) {
                Ok(m) => m,
                Err(err) => {
                    let _ = tx.blocking_send(Err(err));
                    return;
                }
            };

            let file_type = metadata.file_type();

            let append_result = if file_type.is_dir() {
                tar.append_dir(relative_path, entry_path)
            } else {
                tar.append_path_with_name(entry_path, relative_path)
            };

            if let Err(e) = append_result {
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

    let url = format!(
        "{}/sandboxes/{}/files",
        base_url.trim_end_matches('/'),
        sandbox_id
    );
    let response = client.post(&url).body(body).send().await?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "Failed to upload workspace: {}",
            response.status()
        ));
    }

    Ok(())
}
