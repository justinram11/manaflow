use tui_textarea::TextArea;

use crate::mux::commands::MuxCommand;

/// Item types for palette rendering.
#[derive(Debug, Clone)]
pub enum PaletteItem {
    /// A header/separator for grouping.
    Header(String),
    /// A command with its details.
    Command {
        command: MuxCommand,
        is_highlighted: bool,
    },
}

/// State for the command palette.
#[derive(Debug)]
pub struct CommandPalette<'a> {
    pub visible: bool,
    pub search_input: TextArea<'a>,
    pub selected_index: usize,
    filtered_commands: Vec<MuxCommand>,
}

impl Default for CommandPalette<'_> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> CommandPalette<'a> {
    pub fn new() -> Self {
        let mut search_input = TextArea::default();
        search_input.set_placeholder_text("Type to search commands...");
        search_input.set_cursor_line_style(ratatui::style::Style::default());

        Self {
            visible: false,
            search_input,
            selected_index: 0,
            filtered_commands: MuxCommand::all().to_vec(),
        }
    }

    /// Open the palette.
    pub fn open(&mut self) {
        self.visible = true;
        self.search_input = TextArea::default();
        self.search_input
            .set_placeholder_text("Type to search commands...");
        self.search_input
            .set_cursor_line_style(ratatui::style::Style::default());
        self.selected_index = 0;
        self.update_filtered_commands();
    }

    /// Close the palette.
    pub fn close(&mut self) {
        self.visible = false;
    }

    /// Get the current search query.
    pub fn search_query(&self) -> String {
        self.search_input.lines().join("")
    }

    /// Update the filtered list of commands based on search query.
    pub fn update_filtered_commands(&mut self) {
        let query = self.search_query();
        self.filtered_commands = MuxCommand::all()
            .iter()
            .filter(|cmd| cmd.matches(&query))
            .copied()
            .collect();

        // Reset selection if it's out of bounds
        if self.selected_index >= self.filtered_commands.len() {
            self.selected_index = 0;
        }
    }

    /// Handle text input.
    pub fn handle_input(&mut self, input: impl Into<tui_textarea::Input>) {
        let old_query = self.search_query();
        self.search_input.input(input);
        let new_query = self.search_query();

        if old_query != new_query {
            self.update_filtered_commands();
            self.selected_index = 0;
        }
    }

    /// Move selection up.
    pub fn select_up(&mut self) {
        if !self.filtered_commands.is_empty() {
            self.selected_index = if self.selected_index == 0 {
                self.filtered_commands.len() - 1
            } else {
                self.selected_index - 1
            };
        }
    }

    /// Move selection down.
    pub fn select_down(&mut self) {
        if !self.filtered_commands.is_empty() {
            self.selected_index = (self.selected_index + 1) % self.filtered_commands.len();
        }
    }

    /// Get the currently selected command.
    pub fn selected_command(&self) -> Option<MuxCommand> {
        self.filtered_commands.get(self.selected_index).copied()
    }

    /// Execute the selected command and close the palette.
    pub fn execute_selection(&mut self) -> Option<MuxCommand> {
        let cmd = self.selected_command();
        self.close();
        cmd
    }

    /// Get palette items grouped by category for rendering.
    pub fn get_items(&self) -> Vec<PaletteItem> {
        let mut items = Vec::new();
        let mut current_category: Option<&str> = None;

        for (idx, cmd) in self.filtered_commands.iter().enumerate() {
            let category = cmd.category();

            // Add category header if it changed
            if current_category != Some(category) {
                if current_category.is_some() {
                    // Add spacing between categories (represented as empty header)
                }
                items.push(PaletteItem::Header(category.to_string()));
                current_category = Some(category);
            }

            items.push(PaletteItem::Command {
                command: *cmd,
                is_highlighted: idx == self.selected_index,
            });
        }

        items
    }

    /// Get count of filtered commands.
    pub fn filtered_count(&self) -> usize {
        self.filtered_commands.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_filtering_works() {
        let mut palette = CommandPalette::new();
        palette.open();

        // Initial state should show all commands
        assert!(!palette.filtered_commands.is_empty());

        // Filter by "split"
        palette.search_input.insert_str("split");
        palette.update_filtered_commands();

        // Should only show split-related commands
        assert!(palette
            .filtered_commands
            .iter()
            .all(|c| c.label().to_lowercase().contains("split")));
    }

    #[test]
    fn palette_navigation_works() {
        let mut palette = CommandPalette::new();
        palette.open();

        assert_eq!(palette.selected_index, 0);

        palette.select_down();
        assert_eq!(palette.selected_index, 1);

        palette.select_up();
        assert_eq!(palette.selected_index, 0);

        palette.select_up();
        assert_eq!(palette.selected_index, palette.filtered_commands.len() - 1);
    }

    #[test]
    fn palette_selection_works() {
        let mut palette = CommandPalette::new();
        palette.open();

        let selected = palette.selected_command();
        assert!(selected.is_some());
    }
}
