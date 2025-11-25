use futures::{SinkExt, StreamExt};
use ratatui::style::{Color, Modifier, Style};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use vte::{Params, Parser, Perform};

use crate::mux::events::MuxEvent;
use crate::mux::layout::PaneId;

/// A single cell in the terminal grid
#[derive(Debug, Clone)]
pub struct Cell {
    pub c: char,
    pub style: Style,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            c: ' ',
            style: Style::default(),
        }
    }
}

/// Virtual terminal that properly handles ANSI escape sequences
#[derive(Debug, Clone)]
pub struct VirtualTerminal {
    /// Grid of cells (rows x cols)
    pub grid: Vec<Vec<Cell>>,
    /// Number of rows
    pub rows: usize,
    /// Number of columns
    pub cols: usize,
    /// Cursor row (0-indexed)
    pub cursor_row: usize,
    /// Cursor column (0-indexed)
    pub cursor_col: usize,
    /// Current style for new characters
    pub current_style: Style,
    /// Scroll offset for viewing history
    pub scroll_offset: usize,
    /// Scrollback buffer (lines that scrolled off top)
    pub scrollback: Vec<Vec<Cell>>,
    /// Maximum scrollback lines
    pub max_scrollback: usize,
    /// Saved cursor position and style
    saved_cursor: Option<SavedCursor>,
    /// Scroll region (top, bottom) - 0-indexed, inclusive
    scroll_region: (usize, usize),
    /// Cursor visible
    pub cursor_visible: bool,
    /// Insert mode (IRM) - when true, characters shift right instead of overwriting
    insert_mode: bool,
    /// Alternate screen buffer
    alternate_screen: Option<Box<AlternateScreen>>,
    /// Origin mode (DECOM) - cursor positioning relative to scroll region
    origin_mode: bool,
    /// Auto-wrap mode (DECAWM)
    auto_wrap: bool,
    /// Pending wrap - cursor is at the edge and next char will wrap
    pending_wrap: bool,
    /// Tab stops (columns where tabs stop)
    tab_stops: Vec<usize>,
    /// Current charset (0 = G0, 1 = G1)
    charset_index: usize,
    /// G0 charset mode (false = normal, true = line drawing)
    g0_charset_line_drawing: bool,
    /// G1 charset mode (false = normal, true = line drawing)
    g1_charset_line_drawing: bool,
    /// Application cursor keys mode (affects arrow key output)
    pub application_cursor_keys: bool,
    /// Application keypad mode (affects numpad output)
    pub application_keypad: bool,
    /// Bracketed paste mode
    pub bracketed_paste: bool,
    /// Bell triggered flag (for UI notification)
    pub bell_pending: bool,
    /// Window title (set via OSC)
    pub title: Option<String>,
    /// Last printed character (for REP - repeat)
    last_printed_char: Option<char>,
}

/// Saved cursor state (DECSC/DECRC)
#[derive(Debug, Clone)]
struct SavedCursor {
    row: usize,
    col: usize,
    style: Style,
    origin_mode: bool,
    auto_wrap: bool,
    charset_index: usize,
    g0_charset_line_drawing: bool,
    g1_charset_line_drawing: bool,
}

/// Saved state for alternate screen buffer
#[derive(Debug, Clone)]
struct AlternateScreen {
    grid: Vec<Vec<Cell>>,
    cursor_row: usize,
    cursor_col: usize,
    current_style: Style,
}

/// Line drawing character mapping (DEC Special Graphics)
fn line_drawing_char(c: char) -> char {
    match c {
        'j' => '┘', // Lower right corner
        'k' => '┐', // Upper right corner
        'l' => '┌', // Upper left corner
        'm' => '└', // Lower left corner
        'n' => '┼', // Crossing lines
        'q' => '─', // Horizontal line
        't' => '├', // Left tee
        'u' => '┤', // Right tee
        'v' => '┴', // Bottom tee
        'w' => '┬', // Top tee
        'x' => '│', // Vertical line
        'a' => '▒', // Checker board
        'f' => '°', // Degree symbol
        'g' => '±', // Plus/minus
        'y' => '≤', // Less than or equal
        'z' => '≥', // Greater than or equal
        '{' => 'π', // Pi
        '|' => '≠', // Not equal
        '}' => '£', // Pound sign
        '~' => '·', // Middle dot
        _ => c,
    }
}

impl VirtualTerminal {
    pub fn new(rows: usize, cols: usize) -> Self {
        let grid = vec![vec![Cell::default(); cols]; rows];
        // Initialize default tab stops every 8 columns
        let tab_stops: Vec<usize> = (0..cols).filter(|&c| c % 8 == 0 && c > 0).collect();
        Self {
            grid,
            rows,
            cols,
            cursor_row: 0,
            cursor_col: 0,
            current_style: Style::default(),
            scroll_offset: 0,
            scrollback: Vec::new(),
            max_scrollback: 10000,
            saved_cursor: None,
            scroll_region: (0, rows.saturating_sub(1)),
            cursor_visible: true,
            insert_mode: false,
            alternate_screen: None,
            origin_mode: false,
            auto_wrap: true,
            pending_wrap: false,
            tab_stops,
            charset_index: 0,
            g0_charset_line_drawing: false,
            g1_charset_line_drawing: false,
            application_cursor_keys: false,
            application_keypad: false,
            bracketed_paste: false,
            bell_pending: false,
            title: None,
            last_printed_char: None,
        }
    }

    /// Initialize default tab stops (every 8 columns)
    #[allow(dead_code)]
    fn reset_tab_stops(&mut self) {
        self.tab_stops = (0..self.cols).filter(|&c| c % 8 == 0 && c > 0).collect();
    }

    /// Clear all tab stops
    fn clear_all_tab_stops(&mut self) {
        self.tab_stops.clear();
    }

    /// Clear tab stop at current column
    fn clear_tab_stop_at_cursor(&mut self) {
        self.tab_stops.retain(|&c| c != self.cursor_col);
    }

    /// Set tab stop at current column
    fn set_tab_stop_at_cursor(&mut self) {
        if !self.tab_stops.contains(&self.cursor_col) {
            self.tab_stops.push(self.cursor_col);
            self.tab_stops.sort();
        }
    }

    /// Move cursor to next tab stop
    fn tab_forward(&mut self) {
        if let Some(&next_tab) = self.tab_stops.iter().find(|&&c| c > self.cursor_col) {
            self.cursor_col = next_tab.min(self.cols - 1);
        } else {
            // No more tab stops, go to end of line
            self.cursor_col = self.cols - 1;
        }
        self.pending_wrap = false;
    }

    /// Move cursor to previous tab stop (CBT)
    fn tab_backward(&mut self, n: usize) {
        for _ in 0..n {
            if let Some(&prev_tab) = self.tab_stops.iter().rev().find(|&&c| c < self.cursor_col) {
                self.cursor_col = prev_tab;
            } else {
                self.cursor_col = 0;
            }
        }
        self.pending_wrap = false;
    }

    /// Save cursor position and attributes (DECSC)
    fn save_cursor(&mut self) {
        self.saved_cursor = Some(SavedCursor {
            row: self.cursor_row,
            col: self.cursor_col,
            style: self.current_style,
            origin_mode: self.origin_mode,
            auto_wrap: self.auto_wrap,
            charset_index: self.charset_index,
            g0_charset_line_drawing: self.g0_charset_line_drawing,
            g1_charset_line_drawing: self.g1_charset_line_drawing,
        });
    }

    /// Restore cursor position and attributes (DECRC)
    fn restore_cursor(&mut self) {
        if let Some(saved) = &self.saved_cursor {
            self.cursor_row = saved.row.min(self.rows.saturating_sub(1));
            self.cursor_col = saved.col.min(self.cols.saturating_sub(1));
            self.current_style = saved.style;
            self.origin_mode = saved.origin_mode;
            self.auto_wrap = saved.auto_wrap;
            self.charset_index = saved.charset_index;
            self.g0_charset_line_drawing = saved.g0_charset_line_drawing;
            self.g1_charset_line_drawing = saved.g1_charset_line_drawing;
        }
        self.pending_wrap = false;
    }

    /// Resize the terminal
    pub fn resize(&mut self, new_rows: usize, new_cols: usize) {
        if new_rows == self.rows && new_cols == self.cols {
            return;
        }

        // Create new grid
        let mut new_grid = vec![vec![Cell::default(); new_cols]; new_rows];

        // Copy existing content
        for (row_idx, row) in self.grid.iter().enumerate() {
            if row_idx >= new_rows {
                break;
            }
            for (col_idx, cell) in row.iter().enumerate() {
                if col_idx >= new_cols {
                    break;
                }
                new_grid[row_idx][col_idx] = cell.clone();
            }
        }

        self.grid = new_grid;
        self.rows = new_rows;
        self.cols = new_cols;
        self.cursor_row = self.cursor_row.min(new_rows.saturating_sub(1));
        self.cursor_col = self.cursor_col.min(new_cols.saturating_sub(1));
        self.scroll_region = (0, new_rows.saturating_sub(1));
        // Update tab stops for new width
        self.tab_stops.retain(|&c| c < new_cols);
    }

    /// Process raw terminal data
    pub fn process(&mut self, data: &[u8]) {
        let mut parser = Parser::new();
        parser.advance(self, data);
    }

    /// Scroll the screen up by one line within the scroll region
    fn scroll_up(&mut self) {
        let (top, bottom) = self.scroll_region;
        if top < self.rows && bottom < self.rows && top <= bottom {
            // Save the top line to scrollback if scrolling the whole screen
            if top == 0 {
                let line = self.grid[0].clone();
                self.scrollback.push(line);
                if self.scrollback.len() > self.max_scrollback {
                    self.scrollback.remove(0);
                }
            }

            // Shift lines up within scroll region
            for row in top..bottom {
                self.grid[row] = self.grid[row + 1].clone();
            }
            // Clear the bottom line of scroll region
            self.grid[bottom] = vec![Cell::default(); self.cols];
        }
    }

    /// Scroll the screen down by one line within the scroll region
    fn scroll_down(&mut self) {
        let (top, bottom) = self.scroll_region;
        if top < self.rows && bottom < self.rows && top <= bottom {
            // Shift lines down within scroll region
            for row in (top + 1..=bottom).rev() {
                self.grid[row] = self.grid[row - 1].clone();
            }
            // Clear the top line of scroll region
            self.grid[top] = vec![Cell::default(); self.cols];
        }
    }

    /// Move cursor to new line, scrolling if necessary
    fn newline(&mut self) {
        if self.cursor_row >= self.scroll_region.1 {
            self.scroll_up();
        } else {
            self.cursor_row += 1;
        }
    }

    /// Carriage return - move cursor to beginning of line
    fn carriage_return(&mut self) {
        self.cursor_col = 0;
    }

    /// Put a character at cursor position and advance
    fn put_char(&mut self, c: char) {
        // Handle pending wrap from previous character at edge
        if self.pending_wrap {
            self.pending_wrap = false;
            self.cursor_col = 0;
            self.newline();
        }

        // Apply line drawing character set if active
        let display_char = if self.is_line_drawing_active() {
            line_drawing_char(c)
        } else {
            c
        };

        // Save for REP (repeat character) command
        self.last_printed_char = Some(display_char);

        if self.cursor_row < self.rows && self.cursor_col < self.cols {
            // In insert mode, shift characters right
            if self.insert_mode {
                let row = &mut self.grid[self.cursor_row];
                // Shift characters from cursor to end of line right by 1
                for i in (self.cursor_col + 1..self.cols).rev() {
                    row[i] = row[i - 1].clone();
                }
            }

            self.grid[self.cursor_row][self.cursor_col] = Cell {
                c: display_char,
                style: self.current_style,
            };

            if self.cursor_col + 1 >= self.cols {
                // At the edge - set pending wrap if auto-wrap is enabled
                if self.auto_wrap {
                    self.pending_wrap = true;
                }
                // Don't advance cursor past edge
            } else {
                self.cursor_col += 1;
            }
        }
    }

    /// Check if line drawing character set is active
    fn is_line_drawing_active(&self) -> bool {
        if self.charset_index == 0 {
            self.g0_charset_line_drawing
        } else {
            self.g1_charset_line_drawing
        }
    }

    /// Repeat the last printed character n times
    fn repeat_char(&mut self, n: usize) {
        if let Some(c) = self.last_printed_char {
            for _ in 0..n {
                // Directly put the character without line drawing translation (already translated)
                if self.pending_wrap {
                    self.pending_wrap = false;
                    self.cursor_col = 0;
                    self.newline();
                }

                if self.cursor_row < self.rows && self.cursor_col < self.cols {
                    if self.insert_mode {
                        let row = &mut self.grid[self.cursor_row];
                        for i in (self.cursor_col + 1..self.cols).rev() {
                            row[i] = row[i - 1].clone();
                        }
                    }

                    self.grid[self.cursor_row][self.cursor_col] = Cell {
                        c,
                        style: self.current_style,
                    };

                    if self.cursor_col + 1 >= self.cols {
                        if self.auto_wrap {
                            self.pending_wrap = true;
                        }
                    } else {
                        self.cursor_col += 1;
                    }
                }
            }
        }
    }

    /// Insert n blank characters at cursor position, shifting existing chars right
    fn insert_chars(&mut self, n: usize) {
        if self.cursor_row < self.rows {
            let row = &mut self.grid[self.cursor_row];
            for _ in 0..n {
                if self.cursor_col < self.cols {
                    // Remove last character and insert blank at cursor
                    row.pop();
                    row.insert(self.cursor_col, Cell::default());
                }
            }
            // Ensure row has correct length
            while row.len() < self.cols {
                row.push(Cell::default());
            }
        }
    }

    /// Clear from cursor to end of line
    fn clear_to_end_of_line(&mut self) {
        if self.cursor_row < self.rows {
            for col in self.cursor_col..self.cols {
                self.grid[self.cursor_row][col] = Cell::default();
            }
        }
    }

    /// Clear from cursor to beginning of line
    fn clear_to_start_of_line(&mut self) {
        if self.cursor_row < self.rows {
            for col in 0..=self.cursor_col.min(self.cols - 1) {
                self.grid[self.cursor_row][col] = Cell::default();
            }
        }
    }

    /// Clear entire line
    fn clear_line(&mut self) {
        if self.cursor_row < self.rows {
            self.grid[self.cursor_row] = vec![Cell::default(); self.cols];
        }
    }

    /// Clear from cursor to end of screen
    fn clear_to_end_of_screen(&mut self) {
        self.clear_to_end_of_line();
        for row in (self.cursor_row + 1)..self.rows {
            self.grid[row] = vec![Cell::default(); self.cols];
        }
    }

    /// Clear from cursor to beginning of screen
    fn clear_to_start_of_screen(&mut self) {
        self.clear_to_start_of_line();
        for row in 0..self.cursor_row {
            self.grid[row] = vec![Cell::default(); self.cols];
        }
    }

    /// Clear entire screen
    fn clear_screen(&mut self) {
        for row in 0..self.rows {
            self.grid[row] = vec![Cell::default(); self.cols];
        }
    }

    /// Get visible lines for rendering (including scrollback)
    pub fn visible_lines(&self, height: usize) -> Vec<&Vec<Cell>> {
        if self.scroll_offset == 0 {
            // Show current screen
            self.grid.iter().take(height).collect()
        } else {
            // Show scrollback
            let total_lines = self.scrollback.len() + self.rows;
            let end = total_lines.saturating_sub(self.scroll_offset);
            let start = end.saturating_sub(height);

            let mut lines = Vec::new();
            for i in start..end {
                if i < self.scrollback.len() {
                    lines.push(&self.scrollback[i]);
                } else {
                    let grid_idx = i - self.scrollback.len();
                    if grid_idx < self.grid.len() {
                        lines.push(&self.grid[grid_idx]);
                    }
                }
            }
            lines
        }
    }

    /// Scroll view up (into history)
    pub fn scroll_view_up(&mut self, n: usize) {
        let max_scroll = self.scrollback.len();
        self.scroll_offset = (self.scroll_offset + n).min(max_scroll);
    }

    /// Scroll view down (towards current)
    pub fn scroll_view_down(&mut self, n: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(n);
    }

    /// Scroll to bottom (current screen)
    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
    }

    /// Parse SGR (Select Graphic Rendition) parameters
    fn apply_sgr(&mut self, params: &Params) {
        let params: Vec<u16> = params.iter().map(|p| p[0]).collect();

        if params.is_empty() {
            self.current_style = Style::default();
            return;
        }

        let mut i = 0;
        while i < params.len() {
            match params[i] {
                0 => self.current_style = Style::default(),
                1 => self.current_style = self.current_style.add_modifier(Modifier::BOLD),
                2 => self.current_style = self.current_style.add_modifier(Modifier::DIM),
                3 => self.current_style = self.current_style.add_modifier(Modifier::ITALIC),
                4 => self.current_style = self.current_style.add_modifier(Modifier::UNDERLINED),
                5 | 6 => self.current_style = self.current_style.add_modifier(Modifier::SLOW_BLINK),
                7 => self.current_style = self.current_style.add_modifier(Modifier::REVERSED),
                8 => self.current_style = self.current_style.add_modifier(Modifier::HIDDEN),
                9 => self.current_style = self.current_style.add_modifier(Modifier::CROSSED_OUT),
                22 => {
                    self.current_style = self
                        .current_style
                        .remove_modifier(Modifier::BOLD | Modifier::DIM)
                }
                23 => self.current_style = self.current_style.remove_modifier(Modifier::ITALIC),
                24 => self.current_style = self.current_style.remove_modifier(Modifier::UNDERLINED),
                25 => self.current_style = self.current_style.remove_modifier(Modifier::SLOW_BLINK),
                27 => self.current_style = self.current_style.remove_modifier(Modifier::REVERSED),
                28 => self.current_style = self.current_style.remove_modifier(Modifier::HIDDEN),
                29 => {
                    self.current_style = self.current_style.remove_modifier(Modifier::CROSSED_OUT)
                }
                // Foreground colors
                30 => self.current_style = self.current_style.fg(Color::Black),
                31 => self.current_style = self.current_style.fg(Color::Red),
                32 => self.current_style = self.current_style.fg(Color::Green),
                33 => self.current_style = self.current_style.fg(Color::Yellow),
                34 => self.current_style = self.current_style.fg(Color::Blue),
                35 => self.current_style = self.current_style.fg(Color::Magenta),
                36 => self.current_style = self.current_style.fg(Color::Cyan),
                37 => self.current_style = self.current_style.fg(Color::Gray),
                38 => {
                    // Extended foreground color
                    if i + 2 < params.len() && params[i + 1] == 5 {
                        // 256 color mode
                        self.current_style =
                            self.current_style.fg(Color::Indexed(params[i + 2] as u8));
                        i += 2;
                    } else if i + 4 < params.len() && params[i + 1] == 2 {
                        // RGB color mode
                        self.current_style = self.current_style.fg(Color::Rgb(
                            params[i + 2] as u8,
                            params[i + 3] as u8,
                            params[i + 4] as u8,
                        ));
                        i += 4;
                    }
                }
                39 => self.current_style = self.current_style.fg(Color::Reset),
                // Background colors
                40 => self.current_style = self.current_style.bg(Color::Black),
                41 => self.current_style = self.current_style.bg(Color::Red),
                42 => self.current_style = self.current_style.bg(Color::Green),
                43 => self.current_style = self.current_style.bg(Color::Yellow),
                44 => self.current_style = self.current_style.bg(Color::Blue),
                45 => self.current_style = self.current_style.bg(Color::Magenta),
                46 => self.current_style = self.current_style.bg(Color::Cyan),
                47 => self.current_style = self.current_style.bg(Color::Gray),
                48 => {
                    // Extended background color
                    if i + 2 < params.len() && params[i + 1] == 5 {
                        // 256 color mode
                        self.current_style =
                            self.current_style.bg(Color::Indexed(params[i + 2] as u8));
                        i += 2;
                    } else if i + 4 < params.len() && params[i + 1] == 2 {
                        // RGB color mode
                        self.current_style = self.current_style.bg(Color::Rgb(
                            params[i + 2] as u8,
                            params[i + 3] as u8,
                            params[i + 4] as u8,
                        ));
                        i += 4;
                    }
                }
                49 => self.current_style = self.current_style.bg(Color::Reset),
                // Bright foreground colors
                90 => self.current_style = self.current_style.fg(Color::DarkGray),
                91 => self.current_style = self.current_style.fg(Color::LightRed),
                92 => self.current_style = self.current_style.fg(Color::LightGreen),
                93 => self.current_style = self.current_style.fg(Color::LightYellow),
                94 => self.current_style = self.current_style.fg(Color::LightBlue),
                95 => self.current_style = self.current_style.fg(Color::LightMagenta),
                96 => self.current_style = self.current_style.fg(Color::LightCyan),
                97 => self.current_style = self.current_style.fg(Color::White),
                // Bright background colors
                100 => self.current_style = self.current_style.bg(Color::DarkGray),
                101 => self.current_style = self.current_style.bg(Color::LightRed),
                102 => self.current_style = self.current_style.bg(Color::LightGreen),
                103 => self.current_style = self.current_style.bg(Color::LightYellow),
                104 => self.current_style = self.current_style.bg(Color::LightBlue),
                105 => self.current_style = self.current_style.bg(Color::LightMagenta),
                106 => self.current_style = self.current_style.bg(Color::LightCyan),
                107 => self.current_style = self.current_style.bg(Color::White),
                _ => {}
            }
            i += 1;
        }
    }
}

impl Perform for VirtualTerminal {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            // Bell
            0x07 => {
                self.bell_pending = true;
            }
            // Backspace
            0x08 => {
                self.cursor_col = self.cursor_col.saturating_sub(1);
                self.pending_wrap = false;
            }
            // Tab
            0x09 => {
                self.tab_forward();
            }
            // Line feed, vertical tab, form feed
            // Note: In most terminal emulators, LF implies CR as well (onlcr behavior)
            0x0A..=0x0C => {
                self.newline();
                self.carriage_return();
            }
            // Carriage return
            0x0D => {
                self.carriage_return();
                self.pending_wrap = false;
            }
            // Shift Out - switch to G1 charset
            0x0E => {
                self.charset_index = 1;
            }
            // Shift In - switch to G0 charset
            0x0F => {
                self.charset_index = 0;
            }
            _ => {}
        }
    }

    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {}

    fn put(&mut self, _byte: u8) {}

    fn unhook(&mut self) {}

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        // Handle OSC sequences
        if params.is_empty() {
            return;
        }

        // Parse the command number
        let cmd = params[0];
        if let Ok(cmd_str) = std::str::from_utf8(cmd) {
            // Set window title (OSC 0 or OSC 2)
            if let Ok(0 | 2) = cmd_str.parse::<u8>() {
                if params.len() > 1 {
                    if let Ok(title) = std::str::from_utf8(params[1]) {
                        self.title = Some(title.to_string());
                    }
                }
            }
            // Other OSC commands (colors, etc.) - ignore for now
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        let params_vec: Vec<u16> = params.iter().map(|p| p[0]).collect();

        match action {
            // Cursor Up
            'A' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_row = self.cursor_row.saturating_sub(n);
            }
            // Cursor Down
            'B' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_row = (self.cursor_row + n).min(self.rows - 1);
            }
            // Cursor Forward
            'C' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_col = (self.cursor_col + n).min(self.cols - 1);
            }
            // Cursor Back
            'D' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_col = self.cursor_col.saturating_sub(n);
            }
            // Cursor Next Line
            'E' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_row = (self.cursor_row + n).min(self.rows - 1);
                self.cursor_col = 0;
            }
            // Cursor Previous Line
            'F' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_row = self.cursor_row.saturating_sub(n);
                self.cursor_col = 0;
            }
            // Cursor Horizontal Absolute
            'G' => {
                let col = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_col = (col - 1).min(self.cols - 1);
            }
            // Cursor Position
            'H' | 'f' => {
                let row = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                let col = params_vec.get(1).copied().unwrap_or(1).max(1) as usize;
                self.cursor_row = (row - 1).min(self.rows - 1);
                self.cursor_col = (col - 1).min(self.cols - 1);
            }
            // Erase in Display
            'J' => {
                let mode = params_vec.first().copied().unwrap_or(0);
                match mode {
                    0 => self.clear_to_end_of_screen(),
                    1 => self.clear_to_start_of_screen(),
                    2 | 3 => self.clear_screen(),
                    _ => {}
                }
            }
            // Erase in Line
            'K' => {
                let mode = params_vec.first().copied().unwrap_or(0);
                match mode {
                    0 => self.clear_to_end_of_line(),
                    1 => self.clear_to_start_of_line(),
                    2 => self.clear_line(),
                    _ => {}
                }
            }
            // Insert Lines
            'L' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                for _ in 0..n {
                    self.scroll_down();
                }
            }
            // Delete Lines
            'M' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                for _ in 0..n {
                    self.scroll_up();
                }
            }
            // Delete Characters
            'P' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                if self.cursor_row < self.rows {
                    let row = &mut self.grid[self.cursor_row];
                    for _ in 0..n {
                        if self.cursor_col < row.len() {
                            row.remove(self.cursor_col);
                            row.push(Cell::default());
                        }
                    }
                }
            }
            // Scroll Up
            'S' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                for _ in 0..n {
                    self.scroll_up();
                }
            }
            // Scroll Down
            'T' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                for _ in 0..n {
                    self.scroll_down();
                }
            }
            // Erase Characters
            'X' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                if self.cursor_row < self.rows {
                    for i in 0..n {
                        let col = self.cursor_col + i;
                        if col < self.cols {
                            self.grid[self.cursor_row][col] = Cell::default();
                        }
                    }
                }
            }
            // Cursor Horizontal Absolute
            '`' => {
                let col = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_col = (col - 1).min(self.cols - 1);
            }
            // Vertical Position Absolute
            'd' => {
                let row = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.cursor_row = (row - 1).min(self.rows - 1);
            }
            // SGR - Select Graphic Rendition
            'm' => {
                self.apply_sgr(params);
            }
            // Device Status Report
            'n' => {
                // Ignore - would need to send response back
            }
            // Set scroll region
            'r' => {
                let top = params_vec.first().copied().unwrap_or(1).max(1) as usize - 1;
                let bottom = params_vec
                    .get(1)
                    .copied()
                    .unwrap_or(self.rows as u16)
                    .max(1) as usize
                    - 1;
                if top < self.rows && bottom < self.rows && top <= bottom {
                    self.scroll_region = (top, bottom);
                }
                self.cursor_row = 0;
                self.cursor_col = 0;
            }
            // Save cursor position (ANSI.SYS style)
            's' => {
                self.save_cursor();
            }
            // Restore cursor position (ANSI.SYS style)
            'u' => {
                self.restore_cursor();
            }
            // Cursor Backward Tabulation (CBT)
            'Z' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.tab_backward(n);
            }
            // Repeat previous character (REP)
            'b' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.repeat_char(n);
            }
            // Tab Clear (TBC)
            'g' => {
                let mode = params_vec.first().copied().unwrap_or(0);
                match mode {
                    0 => self.clear_tab_stop_at_cursor(),
                    3 => self.clear_all_tab_stops(),
                    _ => {}
                }
            }
            // Insert Characters (ICH)
            '@' => {
                let n = params_vec.first().copied().unwrap_or(1).max(1) as usize;
                self.insert_chars(n);
            }
            // Private modes (DECSET/DECRST) and standard modes (SM/RM)
            'h' | 'l' => {
                let enable = action == 'h';
                if intermediates == [b'?'] {
                    // Private (DEC) modes
                    for &param in &params_vec {
                        match param {
                            1 => {
                                // DECCKM - Cursor Keys Mode (application vs normal)
                                self.application_cursor_keys = enable;
                            }
                            6 => {
                                // DECOM - Origin Mode
                                self.origin_mode = enable;
                                self.cursor_row = 0;
                                self.cursor_col = 0;
                            }
                            7 => {
                                // DECAWM - Auto-wrap Mode
                                self.auto_wrap = enable;
                            }
                            25 => {
                                // DECTCEM - Cursor visibility
                                self.cursor_visible = enable;
                            }
                            1049 => {
                                // Alternate screen buffer (save cursor + switch)
                                if enable {
                                    // Save current screen and switch to alternate
                                    self.alternate_screen = Some(Box::new(AlternateScreen {
                                        grid: self.grid.clone(),
                                        cursor_row: self.cursor_row,
                                        cursor_col: self.cursor_col,
                                        current_style: self.current_style,
                                    }));
                                    // Clear the screen for alternate buffer
                                    self.grid = vec![vec![Cell::default(); self.cols]; self.rows];
                                    self.cursor_row = 0;
                                    self.cursor_col = 0;
                                } else {
                                    // Restore from alternate screen
                                    if let Some(saved) = self.alternate_screen.take() {
                                        self.grid = saved.grid;
                                        self.cursor_row = saved.cursor_row;
                                        self.cursor_col = saved.cursor_col;
                                        self.current_style = saved.current_style;
                                    }
                                }
                            }
                            47 | 1047 => {
                                // Alternate screen buffer (without save cursor)
                                if enable {
                                    self.alternate_screen = Some(Box::new(AlternateScreen {
                                        grid: self.grid.clone(),
                                        cursor_row: self.cursor_row,
                                        cursor_col: self.cursor_col,
                                        current_style: self.current_style,
                                    }));
                                    self.grid = vec![vec![Cell::default(); self.cols]; self.rows];
                                } else if let Some(saved) = self.alternate_screen.take() {
                                    self.grid = saved.grid;
                                }
                            }
                            2004 => {
                                // Bracketed paste mode
                                self.bracketed_paste = enable;
                            }
                            _ => {}
                        }
                    }
                } else {
                    // Standard (ANSI) modes
                    for &param in &params_vec {
                        match param {
                            4 => {
                                // IRM - Insert/Replace Mode
                                self.insert_mode = enable;
                            }
                            20 => {
                                // LNM - Line Feed/New Line Mode
                                // We always treat LF as LF+CR, so ignore
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }

        // Clear pending wrap on cursor movement
        if matches!(
            action,
            'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'f' | 'd' | '`'
        ) {
            self.pending_wrap = false;
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        match (intermediates, byte) {
            // Save cursor (DECSC)
            ([], b'7') => {
                self.save_cursor();
            }
            // Restore cursor (DECRC)
            ([], b'8') => {
                self.restore_cursor();
            }
            // Reset (RIS)
            ([], b'c') => {
                *self = VirtualTerminal::new(self.rows, self.cols);
            }
            // Index - move down one line, scroll if at bottom
            ([], b'D') => {
                self.newline();
            }
            // Next Line
            ([], b'E') => {
                self.newline();
                self.cursor_col = 0;
            }
            // Horizontal Tab Set (HTS)
            ([], b'H') => {
                self.set_tab_stop_at_cursor();
            }
            // Reverse Index - move up one line, scroll if at top
            ([], b'M') => {
                if self.cursor_row == self.scroll_region.0 {
                    self.scroll_down();
                } else {
                    self.cursor_row = self.cursor_row.saturating_sub(1);
                }
            }
            // G0 charset designations
            ([b'('], b'0') => {
                // DEC Special Graphics (line drawing)
                self.g0_charset_line_drawing = true;
            }
            ([b'('], b'B') => {
                // ASCII (default)
                self.g0_charset_line_drawing = false;
            }
            // G1 charset designations
            ([b')'], b'0') => {
                self.g1_charset_line_drawing = true;
            }
            ([b')'], b'B') => {
                self.g1_charset_line_drawing = false;
            }
            // Application keypad mode (DECKPAM)
            ([], b'=') => {
                self.application_keypad = true;
            }
            // Normal keypad mode (DECKPNM)
            ([], b'>') => {
                self.application_keypad = false;
            }
            _ => {}
        }
    }
}

/// State for a single terminal connection
#[derive(Debug)]
pub struct TerminalConnection {
    /// WebSocket sender for sending input to the terminal
    sender: mpsc::UnboundedSender<Vec<u8>>,
    /// Sandbox ID this terminal is connected to
    pub sandbox_id: String,
}

/// Terminal output buffer for rendering - now using VirtualTerminal
#[derive(Debug, Clone)]
pub struct TerminalBuffer {
    pub terminal: VirtualTerminal,
}

impl Default for TerminalBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalBuffer {
    pub fn new() -> Self {
        Self {
            terminal: VirtualTerminal::new(24, 80),
        }
    }

    pub fn with_size(rows: usize, cols: usize) -> Self {
        Self {
            terminal: VirtualTerminal::new(rows, cols),
        }
    }

    /// Process raw terminal data
    pub fn process(&mut self, data: &[u8]) {
        self.terminal.process(data);
    }

    /// Resize the terminal
    pub fn resize(&mut self, rows: usize, cols: usize) {
        self.terminal.resize(rows, cols);
    }

    /// Scroll view up
    pub fn scroll_up(&mut self, n: usize) {
        self.terminal.scroll_view_up(n);
    }

    /// Scroll view down
    pub fn scroll_down(&mut self, n: usize) {
        self.terminal.scroll_view_down(n);
    }

    /// Scroll to bottom
    pub fn scroll_to_bottom(&mut self) {
        self.terminal.scroll_to_bottom();
    }

    /// Clear the terminal
    pub fn clear(&mut self) {
        let rows = self.terminal.rows;
        let cols = self.terminal.cols;
        self.terminal = VirtualTerminal::new(rows, cols);
    }

    /// Check if the terminal has any content
    pub fn has_content(&self) -> bool {
        // Check if any cell has non-space content
        for row in &self.terminal.grid {
            for cell in row {
                if cell.c != ' ' {
                    return true;
                }
            }
        }
        // Also check scrollback
        !self.terminal.scrollback.is_empty()
    }

    /// Get cursor position (row, col) - returns None if scrolled away from bottom
    pub fn cursor_position(&self) -> Option<(u16, u16)> {
        // Only show cursor if we're at the bottom (not scrolled back)
        if self.terminal.scroll_offset == 0 && self.terminal.cursor_visible {
            Some((
                self.terminal.cursor_row as u16,
                self.terminal.cursor_col as u16,
            ))
        } else {
            None
        }
    }

    /// Check if cursor is visible
    pub fn cursor_visible(&self) -> bool {
        self.terminal.cursor_visible && self.terminal.scroll_offset == 0
    }

    /// Get visible lines as ratatui Lines with styling
    pub fn visible_lines(&self, height: usize) -> Vec<ratatui::text::Line<'static>> {
        let cell_lines = self.terminal.visible_lines(height);
        cell_lines
            .into_iter()
            .map(|cells| {
                let mut spans: Vec<ratatui::text::Span<'static>> = Vec::new();
                let mut current_style = Style::default();
                let mut current_text = String::new();

                for cell in cells {
                    if cell.style == current_style {
                        current_text.push(cell.c);
                    } else {
                        if !current_text.is_empty() {
                            spans.push(ratatui::text::Span::styled(
                                std::mem::take(&mut current_text),
                                current_style,
                            ));
                        }
                        current_style = cell.style;
                        current_text.push(cell.c);
                    }
                }

                if !current_text.is_empty() {
                    spans.push(ratatui::text::Span::styled(current_text, current_style));
                }

                ratatui::text::Line::from(spans)
            })
            .collect()
    }
}

/// Manager for all terminal connections
pub struct TerminalManager {
    /// Base URL for WebSocket connections
    base_url: String,
    /// Active connections by pane ID
    connections: HashMap<PaneId, TerminalConnection>,
    /// Output buffers by pane ID
    buffers: HashMap<PaneId, TerminalBuffer>,
    /// Event channel to send events back to the app
    event_tx: mpsc::UnboundedSender<MuxEvent>,
}

impl TerminalManager {
    pub fn new(base_url: String, event_tx: mpsc::UnboundedSender<MuxEvent>) -> Self {
        Self {
            base_url,
            connections: HashMap::new(),
            buffers: HashMap::new(),
            event_tx,
        }
    }

    /// Get the output buffer for a pane
    pub fn get_buffer(&self, pane_id: PaneId) -> Option<&TerminalBuffer> {
        self.buffers.get(&pane_id)
    }

    /// Get the output buffer for a pane mutably
    pub fn get_buffer_mut(&mut self, pane_id: PaneId) -> Option<&mut TerminalBuffer> {
        self.buffers.get_mut(&pane_id)
    }

    /// Check if a pane has an active terminal connection
    pub fn is_connected(&self, pane_id: PaneId) -> bool {
        self.connections.contains_key(&pane_id)
    }

    /// Send input to a terminal
    pub fn send_input(&self, pane_id: PaneId, data: Vec<u8>) -> bool {
        if let Some(conn) = self.connections.get(&pane_id) {
            conn.sender.send(data).is_ok()
        } else {
            false
        }
    }

    /// Handle incoming terminal output
    pub fn handle_output(&mut self, pane_id: PaneId, data: Vec<u8>) {
        let buffer = self.buffers.entry(pane_id).or_default();
        buffer.process(&data);
    }

    /// Disconnect a terminal
    pub fn disconnect(&mut self, pane_id: PaneId) {
        self.connections.remove(&pane_id);
    }

    /// Clear a terminal buffer
    pub fn clear_buffer(&mut self, pane_id: PaneId) {
        if let Some(buffer) = self.buffers.get_mut(&pane_id) {
            buffer.clear();
        }
    }

    /// Send resize event to a terminal
    pub fn resize(&mut self, pane_id: PaneId, rows: u16, cols: u16) -> bool {
        // Resize the virtual terminal
        if let Some(buffer) = self.buffers.get_mut(&pane_id) {
            buffer.resize(rows as usize, cols as usize);
        }

        // Send resize command to remote
        if let Some(conn) = self.connections.get(&pane_id) {
            let msg = format!("resize:{}:{}", rows, cols);
            conn.sender.send(msg.into_bytes()).is_ok()
        } else {
            false
        }
    }

    /// Initialize a buffer with specific size
    pub fn init_buffer(&mut self, pane_id: PaneId, rows: usize, cols: usize) {
        self.buffers
            .insert(pane_id, TerminalBuffer::with_size(rows, cols));
    }
}

/// Shared terminal manager for async access
pub type SharedTerminalManager = Arc<Mutex<TerminalManager>>;

/// Create a new shared terminal manager
pub fn create_terminal_manager(
    base_url: String,
    event_tx: mpsc::UnboundedSender<MuxEvent>,
) -> SharedTerminalManager {
    Arc::new(Mutex::new(TerminalManager::new(base_url, event_tx)))
}

/// Connect to a sandbox terminal via WebSocket
pub async fn connect_to_sandbox(
    manager: SharedTerminalManager,
    pane_id: PaneId,
    sandbox_id: String,
    cols: u16,
    rows: u16,
) -> anyhow::Result<()> {
    let (base_url, event_tx) = {
        let mut mgr = manager.lock().await;
        // Initialize buffer with correct size
        mgr.init_buffer(pane_id, rows as usize, cols as usize);
        (mgr.base_url.clone(), mgr.event_tx.clone())
    };

    let ws_url = base_url
        .replace("http://", "ws://")
        .replace("https://", "wss://")
        .trim_end_matches('/')
        .to_string();

    let url = format!(
        "{}/sandboxes/{}/attach?cols={}&rows={}",
        ws_url, sandbox_id, cols, rows
    );

    let (ws_stream, _) = connect_async(&url).await?;
    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Create channel for sending input to this terminal
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    // Store connection
    {
        let mut mgr = manager.lock().await;
        mgr.connections.insert(
            pane_id,
            TerminalConnection {
                sender: input_tx,
                sandbox_id: sandbox_id.clone(),
            },
        );
    }

    // Notify connection established
    let _ = event_tx.send(MuxEvent::SandboxConnectionChanged {
        sandbox_id: sandbox_id.clone(),
        connected: true,
    });

    // Spawn task to handle WebSocket I/O
    let manager_clone = manager.clone();
    let event_tx_clone = event_tx.clone();
    let sandbox_id_clone = sandbox_id.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                // Handle incoming data from WebSocket
                msg = ws_read.next() => {
                    match msg {
                        Some(Ok(Message::Binary(data))) => {
                            {
                                let mut mgr = manager_clone.lock().await;
                                mgr.handle_output(pane_id, data.clone());
                            }
                            let _ = event_tx_clone.send(MuxEvent::TerminalOutput {
                                pane_id,
                                data,
                            });
                        }
                        Some(Ok(Message::Text(text))) => {
                            let data = text.into_bytes();
                            {
                                let mut mgr = manager_clone.lock().await;
                                mgr.handle_output(pane_id, data.clone());
                            }
                            let _ = event_tx_clone.send(MuxEvent::TerminalOutput {
                                pane_id,
                                data,
                            });
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            break;
                        }
                        Some(Err(e)) => {
                            let _ = event_tx_clone.send(MuxEvent::Error(format!(
                                "WebSocket error: {}",
                                e
                            )));
                            break;
                        }
                        _ => {}
                    }
                }
                // Handle outgoing input to WebSocket
                Some(data) = input_rx.recv() => {
                    // Check if this is a resize message
                    let data_str = String::from_utf8_lossy(&data);
                    if data_str.starts_with("resize:") {
                        if ws_write.send(Message::Text(data_str.into_owned())).await.is_err() {
                            break;
                        }
                    } else if ws_write.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
            }
        }

        // Clean up connection
        {
            let mut mgr = manager_clone.lock().await;
            mgr.disconnect(pane_id);
        }

        let _ = event_tx_clone.send(MuxEvent::SandboxConnectionChanged {
            sandbox_id: sandbox_id_clone,
            connected: false,
        });
    });

    Ok(())
}

/// Create a new sandbox and connect to it
pub async fn create_and_connect_sandbox(
    manager: SharedTerminalManager,
    pane_id: PaneId,
    name: Option<String>,
    cols: u16,
    rows: u16,
) -> anyhow::Result<String> {
    let base_url = {
        let mgr = manager.lock().await;
        mgr.base_url.clone()
    };

    let client = reqwest::Client::new();
    let url = format!("{}/sandboxes", base_url.trim_end_matches('/'));

    let body = crate::models::CreateSandboxRequest {
        name,
        workspace: None,
        read_only_paths: vec![],
        tmpfs: vec![],
        env: vec![],
    };

    let response = client.post(&url).json(&body).send().await?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "Failed to create sandbox: {} - {}",
            status,
            text
        ));
    }

    let summary: crate::models::SandboxSummary = response.json().await?;
    let sandbox_id = summary.id.to_string();

    // Connect to the new sandbox
    connect_to_sandbox(manager, pane_id, sandbox_id.clone(), cols, rows).await?;

    Ok(sandbox_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_terminal_handles_basic_text() {
        let mut term = VirtualTerminal::new(24, 80);
        term.process(b"Hello, World!");
        assert_eq!(term.grid[0][0].c, 'H');
        assert_eq!(term.grid[0][6].c, ' ');
        assert_eq!(term.grid[0][7].c, 'W');
    }

    #[test]
    fn virtual_terminal_handles_newline() {
        let mut term = VirtualTerminal::new(24, 80);
        term.process(b"Line 1\nLine 2");
        assert_eq!(term.grid[0][0].c, 'L');
        assert_eq!(term.grid[1][0].c, 'L');
    }

    #[test]
    fn virtual_terminal_handles_cursor_movement() {
        let mut term = VirtualTerminal::new(24, 80);
        term.process(b"Hello\x1b[2;1HWorld"); // Move to row 2, col 1
        assert_eq!(term.grid[0][0].c, 'H');
        assert_eq!(term.grid[1][0].c, 'W');
    }

    #[test]
    fn virtual_terminal_handles_colors() {
        let mut term = VirtualTerminal::new(24, 80);
        term.process(b"\x1b[31mRed\x1b[0m");
        assert_eq!(term.grid[0][0].c, 'R');
        assert_eq!(term.grid[0][0].style.fg, Some(Color::Red));
        assert_eq!(term.grid[0][2].style.fg, Some(Color::Red));
    }

    #[test]
    fn virtual_terminal_handles_clear_screen() {
        let mut term = VirtualTerminal::new(24, 80);
        term.process(b"Hello");
        term.process(b"\x1b[2J"); // Clear screen
        assert_eq!(term.grid[0][0].c, ' ');
    }

    #[test]
    fn virtual_terminal_scrolls() {
        let mut term = VirtualTerminal::new(3, 80);
        term.process(b"Line 1\nLine 2\nLine 3\nLine 4");
        // Line 1 should have scrolled into scrollback
        assert_eq!(term.scrollback.len(), 1);
        assert_eq!(term.scrollback[0][0].c, 'L');
    }
}
