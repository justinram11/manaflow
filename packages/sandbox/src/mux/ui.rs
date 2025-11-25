use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Tabs},
    Frame,
};

use crate::mux::commands::MuxCommand;
use crate::mux::layout::LayoutNode;
use crate::mux::palette::PaletteItem;
use crate::mux::sidebar::Sidebar;
use crate::mux::state::{FocusArea, MuxApp};

/// Main UI rendering function.
pub fn ui(f: &mut Frame, app: &mut MuxApp) {
    let area = f.area();

    // Main layout: sidebar | main area
    let main_chunks = if app.sidebar.visible {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(app.sidebar.width), Constraint::Min(1)])
            .split(area)
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Min(1)])
            .split(area)
    };

    // Render sidebar if visible
    let main_area = if app.sidebar.visible {
        render_sidebar(f, app, main_chunks[0]);
        main_chunks[1]
    } else {
        main_chunks[0]
    };

    // Main area layout: tabs | workspace | status
    let workspace_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // Tab bar
            Constraint::Min(1),    // Workspace
            Constraint::Length(1), // Status bar
        ])
        .split(main_area);

    render_tab_bar(f, app, workspace_chunks[0]);
    render_workspace(f, app, workspace_chunks[1]);
    render_status_bar(f, app, workspace_chunks[2]);

    // Render overlays
    if app.command_palette.visible {
        render_command_palette(f, app);
    }

    if app.show_help {
        render_help_overlay(f, app);
    }

    if app.renaming_tab {
        render_rename_dialog(f, app);
    }
}

/// Render the sidebar with sandbox list.
fn render_sidebar(f: &mut Frame, app: &MuxApp, area: Rect) {
    let is_focused = app.focus == FocusArea::Sidebar;

    let border_style = if is_focused {
        Style::default().fg(Color::Cyan)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let block = Block::default()
        .title(" Sandboxes ")
        .title_style(if is_focused {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::White)
        })
        .borders(Borders::ALL)
        .border_style(border_style);

    let inner_area = block.inner(area);
    f.render_widget(block, area);

    if app.sidebar.is_loading {
        let loading = Paragraph::new("Loading...").style(Style::default().fg(Color::Yellow));
        f.render_widget(loading, inner_area);
        return;
    }

    if let Some(error) = &app.sidebar.last_error {
        let error_text =
            Paragraph::new(format!("Error: {}", error)).style(Style::default().fg(Color::Red));
        f.render_widget(error_text, inner_area);
        return;
    }

    if app.sidebar.sandboxes.is_empty() {
        let empty_text = Paragraph::new("No sandboxes").style(Style::default().fg(Color::DarkGray));
        f.render_widget(empty_text, inner_area);
        return;
    }

    let mut lines: Vec<Line<'_>> = Vec::new();
    for (idx, sandbox) in app.sidebar.sandboxes.iter().enumerate() {
        let is_selected = idx == app.sidebar.selected_index;

        let status_icon = Sidebar::status_icon(&sandbox.status);
        let status_color = Sidebar::status_color(&sandbox.status);

        let prefix = if is_selected { "▶ " } else { "  " };
        let max_name_width = inner_area.width.saturating_sub(6) as usize;
        let name = Sidebar::format_name(sandbox, max_name_width);

        let style = if is_selected {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };

        lines.push(Line::from(vec![
            Span::styled(prefix, style),
            Span::styled(status_icon, Style::default().fg(status_color)),
            Span::raw(" "),
            Span::styled(name, style),
        ]));
    }

    let paragraph = Paragraph::new(lines);
    f.render_widget(paragraph, inner_area);
}

/// Render the tab bar.
fn render_tab_bar(f: &mut Frame, app: &MuxApp, area: Rect) {
    let tab_titles: Vec<Line<'_>> = app
        .workspace
        .tabs
        .iter()
        .enumerate()
        .map(|(idx, tab)| {
            let style = if idx == app.workspace.active_tab_index {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(Color::DarkGray)
            };
            Line::styled(format!(" {} ", tab.name), style)
        })
        .collect();

    let tabs = Tabs::new(tab_titles)
        .select(app.workspace.active_tab_index)
        .divider(Span::raw("│"))
        .highlight_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );

    f.render_widget(tabs, area);
}

/// Render the main workspace area with panes.
fn render_workspace(f: &mut Frame, app: &mut MuxApp, area: Rect) {
    // First, calculate areas (needs mutable borrow)
    if let Some(tab) = app.workspace.active_tab_mut() {
        tab.layout.calculate_areas(area);
    }

    // Now get immutable references for rendering
    let Some(tab) = app.workspace.active_tab() else {
        return;
    };

    let is_main_focused = app.focus == FocusArea::MainArea;

    // If zoomed, only render the zoomed pane
    if let Some(zoomed_id) = app.zoomed_pane {
        if let Some(pane) = tab.layout.find_pane(zoomed_id) {
            let terminal_buffer = app.get_terminal_buffer(pane.id);
            render_pane(
                f,
                pane,
                area,
                true,
                is_main_focused,
                terminal_buffer.as_ref(),
            );
            return;
        }
    }

    // Render all panes
    let active_pane_id = tab.active_pane;
    let layout_clone = tab.layout.clone();
    render_layout_node(f, &layout_clone, active_pane_id, is_main_focused, app);
}

/// Recursively render layout nodes.
fn render_layout_node(
    f: &mut Frame,
    node: &LayoutNode,
    active_pane_id: Option<crate::mux::layout::PaneId>,
    is_main_focused: bool,
    app: &MuxApp,
) {
    match node {
        LayoutNode::Pane(pane) => {
            if let Some(area) = pane.area {
                let is_active = active_pane_id == Some(pane.id);
                let terminal_buffer = app.get_terminal_buffer(pane.id);
                render_pane(
                    f,
                    pane,
                    area,
                    is_active,
                    is_main_focused,
                    terminal_buffer.as_ref(),
                );
            }
        }
        LayoutNode::Split { first, second, .. } => {
            render_layout_node(f, first, active_pane_id, is_main_focused, app);
            render_layout_node(f, second, active_pane_id, is_main_focused, app);
        }
    }
}

/// Render a single pane.
fn render_pane(
    f: &mut Frame,
    pane: &crate::mux::layout::Pane,
    area: Rect,
    is_active: bool,
    is_main_focused: bool,
    terminal_buffer: Option<&crate::mux::terminal::TerminalBuffer>,
) {
    let border_style = if is_active && is_main_focused {
        Style::default().fg(Color::Cyan)
    } else if is_active {
        Style::default().fg(Color::White)
    } else {
        Style::default().fg(Color::DarkGray)
    };

    let title_style = if is_active && is_main_focused {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::White)
    };

    let block = Block::default()
        .title(format!(" {} ", pane.title()))
        .title_style(title_style)
        .borders(Borders::ALL)
        .border_style(border_style);

    let inner_area = block.inner(area);
    f.render_widget(block, area);

    // Render pane content
    match &pane.content {
        crate::mux::layout::PaneContent::Empty => {
            let text = Paragraph::new("Empty pane\n\nUse Alt+- or Alt+\\ to split")
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            f.render_widget(text, inner_area);
        }
        crate::mux::layout::PaneContent::Terminal { sandbox_id, .. } => {
            // Check if we have terminal output to display
            if let Some(buffer) = terminal_buffer {
                if buffer.has_content() {
                    // Render terminal output with proper styling
                    let height = inner_area.height as usize;
                    let visible_lines = buffer.visible_lines(height);
                    let paragraph = Paragraph::new(visible_lines);
                    f.render_widget(paragraph, inner_area);

                    // Set cursor position only if:
                    // 1. Pane is active
                    // 2. Main area is focused (not sidebar or command palette)
                    if is_active && is_main_focused {
                        if let Some((cursor_row, cursor_col)) = buffer.cursor_position() {
                            // Ensure cursor is within visible area
                            let cursor_x = inner_area.x + cursor_col;
                            let cursor_y = inner_area.y + cursor_row;
                            if cursor_x < inner_area.x + inner_area.width
                                && cursor_y < inner_area.y + inner_area.height
                            {
                                f.set_cursor_position((cursor_x, cursor_y));
                            }
                        }
                    }
                    return;
                }
            }

            // Show placeholder when no terminal output yet
            let sandbox_info = sandbox_id
                .as_ref()
                .map(|s| format!("Connected to: {}", s))
                .unwrap_or_else(|| "Not connected".to_string());

            let help_text = if sandbox_id.is_some() {
                "Waiting for output..."
            } else {
                "Select a sandbox from sidebar (Tab) or create one (Alt+N)"
            };

            let text = Paragraph::new(format!("Terminal\n\n{}\n\n{}", sandbox_info, help_text))
                .style(Style::default().fg(Color::DarkGray))
                .alignment(Alignment::Center);
            f.render_widget(text, inner_area);
        }
        crate::mux::layout::PaneContent::Chat {
            sandbox_id,
            provider,
        } => {
            let text = Paragraph::new(format!(
                "Chat with {}\n\nSandbox: {}\n\n(Chat integration coming soon)",
                provider, sandbox_id
            ))
            .style(Style::default().fg(Color::DarkGray))
            .alignment(Alignment::Center);
            f.render_widget(text, inner_area);
        }
    }
}

/// Render the status bar.
fn render_status_bar(f: &mut Frame, app: &mut MuxApp, area: Rect) {
    app.clear_expired_status();

    let mut spans = Vec::new();

    // Mode indicator
    let mode = match app.focus {
        FocusArea::Sidebar => "SIDEBAR",
        FocusArea::MainArea => "NORMAL",
        FocusArea::CommandPalette => "COMMAND",
    };
    spans.push(Span::styled(
        format!(" {} ", mode),
        Style::default()
            .fg(Color::Black)
            .bg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    ));
    spans.push(Span::raw(" "));

    // Pane info
    if let Some(tab) = app.workspace.active_tab() {
        let pane_count = tab.layout.pane_count();
        spans.push(Span::styled(
            format!(
                "{} pane{}",
                pane_count,
                if pane_count == 1 { "" } else { "s" }
            ),
            Style::default().fg(Color::DarkGray),
        ));
        spans.push(Span::raw(" │ "));
    }

    // Tab info
    spans.push(Span::styled(
        format!(
            "Tab {}/{}",
            app.workspace.active_tab_index + 1,
            app.workspace.tabs.len()
        ),
        Style::default().fg(Color::DarkGray),
    ));

    // Status message
    if let Some((msg, _)) = &app.status_message {
        spans.push(Span::raw(" │ "));
        spans.push(Span::styled(
            msg.clone(),
            Style::default().fg(Color::Yellow),
        ));
    }

    // Right side: keybinding hints
    let hints = " Ctrl+P: Commands │ Ctrl+\\: Sidebar │ Ctrl+Q: Quit ";
    let hints_width = hints.len() as u16;
    let left_width: u16 = spans.iter().map(|s| s.content.len() as u16).sum();
    let padding = area.width.saturating_sub(left_width + hints_width);

    spans.push(Span::raw(" ".repeat(padding as usize)));
    spans.push(Span::styled(hints, Style::default().fg(Color::DarkGray)));

    let line = Line::from(spans);
    let paragraph = Paragraph::new(line);
    f.render_widget(paragraph, area);
}

/// Render the command palette overlay.
fn render_command_palette(f: &mut Frame, app: &MuxApp) {
    let area = f.area();

    let palette_width = 70u16.min(area.width.saturating_sub(4));
    let max_height = 20u16.min(area.height.saturating_sub(4));
    let palette_height = (app.command_palette.filtered_count() as u16 + 6).min(max_height);

    let x = (area.width.saturating_sub(palette_width)) / 2;
    let y = area.height / 6; // Place towards the top

    let palette_area = Rect::new(x, y, palette_width, palette_height);
    f.render_widget(Clear, palette_area);

    let block = Block::default()
        .title(" Command Palette ")
        .title_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner_area = block.inner(palette_area);
    f.render_widget(block, palette_area);

    // Search input
    let search_area = Rect::new(inner_area.x, inner_area.y, inner_area.width, 1);
    let search_prefix = Paragraph::new(Span::styled(">", Style::default().fg(Color::Cyan)));
    f.render_widget(search_prefix, Rect::new(search_area.x, search_area.y, 2, 1));
    f.render_widget(
        &app.command_palette.search_input,
        Rect::new(search_area.x + 2, search_area.y, search_area.width - 2, 1),
    );

    // Commands list
    let items_area = Rect::new(
        inner_area.x,
        inner_area.y + 2,
        inner_area.width,
        inner_area.height.saturating_sub(4),
    );

    let mut lines: Vec<Line<'_>> = Vec::new();
    let mut current_category: Option<&str> = None;

    for item in app.command_palette.get_items() {
        match item {
            PaletteItem::Header(text) => {
                if current_category.is_some() {
                    lines.push(Line::raw("")); // Spacing between categories
                }
                lines.push(Line::styled(
                    format!("─ {} ─", text),
                    Style::default()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::BOLD),
                ));
                current_category = Some(Box::leak(text.into_boxed_str()));
            }
            PaletteItem::Command {
                command,
                is_highlighted,
            } => {
                let prefix = if is_highlighted { "▶ " } else { "  " };
                let keybinding = command.keybinding_str();

                let style = if is_highlighted {
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default()
                };

                let kb_style = Style::default().fg(Color::Yellow);

                // Calculate padding for right-aligned keybinding
                let label = command.label();
                let kb_width = keybinding.len();
                let label_width = items_area.width as usize - kb_width - 4;

                let mut spans = vec![
                    Span::styled(prefix, style),
                    Span::styled(format!("{:<width$}", label, width = label_width), style),
                ];

                if !keybinding.is_empty() {
                    spans.push(Span::styled(keybinding, kb_style));
                }

                lines.push(Line::from(spans));
            }
        }
    }

    // Handle scrolling
    let visible_lines = items_area.height as usize;
    let scroll_offset = if app.command_palette.selected_index >= visible_lines {
        app.command_palette.selected_index - visible_lines + 1
    } else {
        0
    };

    let paragraph = Paragraph::new(lines).scroll((scroll_offset as u16, 0));
    f.render_widget(paragraph, items_area);

    // Help text at bottom
    let help_area = Rect::new(
        inner_area.x,
        inner_area.y + inner_area.height - 1,
        inner_area.width,
        1,
    );
    let help = Paragraph::new(Line::styled(
        "↑↓: navigate │ Enter: execute │ Esc: cancel",
        Style::default().fg(Color::DarkGray),
    ));
    f.render_widget(help, help_area);
}

/// Render help overlay showing all keybindings.
fn render_help_overlay(f: &mut Frame, _app: &MuxApp) {
    let area = f.area();

    let help_width = 60u16.min(area.width.saturating_sub(4));
    let help_height = 30u16.min(area.height.saturating_sub(4));

    let x = (area.width.saturating_sub(help_width)) / 2;
    let y = (area.height.saturating_sub(help_height)) / 2;

    let help_area = Rect::new(x, y, help_width, help_height);
    f.render_widget(Clear, help_area);

    let block = Block::default()
        .title(" Keyboard Shortcuts ")
        .title_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner_area = block.inner(help_area);
    f.render_widget(block, help_area);

    let mut lines: Vec<Line<'_>> = Vec::new();
    let mut current_category: Option<&str> = None;

    for cmd in MuxCommand::all() {
        let category = cmd.category();
        if current_category != Some(category) {
            if current_category.is_some() {
                lines.push(Line::raw(""));
            }
            lines.push(Line::styled(
                category,
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ));
            current_category = Some(category);
        }

        let keybinding = cmd.keybinding_str();
        if !keybinding.is_empty() {
            let kb_width = 16;
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    format!("{:<width$}", keybinding, width = kb_width),
                    Style::default().fg(Color::Cyan),
                ),
                Span::raw(cmd.label()),
            ]));
        }
    }

    let paragraph = Paragraph::new(lines);
    f.render_widget(paragraph, inner_area);
}

/// Render tab rename dialog.
fn render_rename_dialog(f: &mut Frame, app: &MuxApp) {
    let area = f.area();

    let dialog_width = 40u16.min(area.width.saturating_sub(4));
    let dialog_height = 5u16;

    let x = (area.width.saturating_sub(dialog_width)) / 2;
    let y = (area.height.saturating_sub(dialog_height)) / 2;

    let dialog_area = Rect::new(x, y, dialog_width, dialog_height);
    f.render_widget(Clear, dialog_area);

    let block = Block::default()
        .title(" Rename Tab ")
        .title_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    let inner_area = block.inner(dialog_area);
    f.render_widget(block, dialog_area);

    if let Some(input) = &app.rename_input {
        let input_area = Rect::new(inner_area.x, inner_area.y + 1, inner_area.width, 1);
        f.render_widget(input, input_area);
    }

    let help_area = Rect::new(
        inner_area.x,
        inner_area.y + inner_area.height - 1,
        inner_area.width,
        1,
    );
    let help = Paragraph::new(Line::styled(
        "Enter: confirm │ Esc: cancel",
        Style::default().fg(Color::DarkGray),
    ));
    f.render_widget(help, help_area);
}
