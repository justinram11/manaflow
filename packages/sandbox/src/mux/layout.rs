use ratatui::layout::Rect;
use uuid::Uuid;

/// Unique identifier for a pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PaneId(pub Uuid);

impl PaneId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for PaneId {
    fn default() -> Self {
        Self::new()
    }
}

/// Unique identifier for a tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TabId(pub Uuid);

impl TabId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TabId {
    fn default() -> Self {
        Self::new()
    }
}

/// Direction for splitting panes or navigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Horizontal,
    Vertical,
}

/// Direction for navigation between panes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDirection {
    Left,
    Right,
    Up,
    Down,
}

/// Content that can be displayed in a pane.
#[derive(Debug, Clone, Default)]
pub enum PaneContent {
    /// An empty placeholder pane
    #[default]
    Empty,
    /// A shell/terminal pane
    Terminal {
        sandbox_id: Option<String>,
        title: String,
    },
    /// An ACP chat session
    Chat {
        sandbox_id: String,
        provider: String,
    },
}

/// A single pane in the layout.
#[derive(Debug, Clone)]
pub struct Pane {
    pub id: PaneId,
    pub content: PaneContent,
    /// The computed area for this pane (set during rendering)
    pub area: Option<Rect>,
}

impl Pane {
    pub fn new(content: PaneContent) -> Self {
        Self {
            id: PaneId::new(),
            content,
            area: None,
        }
    }

    pub fn empty() -> Self {
        Self::new(PaneContent::Empty)
    }

    pub fn terminal(sandbox_id: Option<String>, title: impl Into<String>) -> Self {
        Self::new(PaneContent::Terminal {
            sandbox_id,
            title: title.into(),
        })
    }

    pub fn chat(sandbox_id: impl Into<String>, provider: impl Into<String>) -> Self {
        Self::new(PaneContent::Chat {
            sandbox_id: sandbox_id.into(),
            provider: provider.into(),
        })
    }

    pub fn title(&self) -> String {
        match &self.content {
            PaneContent::Empty => "Empty".to_string(),
            PaneContent::Terminal { title, .. } => title.clone(),
            PaneContent::Chat { provider, .. } => format!("Chat ({})", provider),
        }
    }
}

/// A node in the layout tree.
#[derive(Debug, Clone)]
pub enum LayoutNode {
    /// A leaf node containing a single pane.
    Pane(Pane),
    /// A split containing two children.
    Split {
        direction: Direction,
        /// Percentage of space for the first child (0.0 - 1.0)
        ratio: f32,
        first: Box<LayoutNode>,
        second: Box<LayoutNode>,
    },
}

impl LayoutNode {
    /// Create a new leaf node with an empty pane.
    pub fn empty() -> Self {
        LayoutNode::Pane(Pane::empty())
    }

    /// Create a new leaf node with a terminal pane.
    pub fn terminal(sandbox_id: Option<String>, title: impl Into<String>) -> Self {
        LayoutNode::Pane(Pane::terminal(sandbox_id, title))
    }

    /// Split this node in the given direction, placing the new pane according to direction.
    pub fn split(&mut self, direction: Direction, new_pane: Pane) {
        let old_node = std::mem::replace(self, LayoutNode::empty());
        *self = LayoutNode::Split {
            direction,
            ratio: 0.5,
            first: Box::new(old_node),
            second: Box::new(LayoutNode::Pane(new_pane)),
        };
    }

    /// Find a pane by ID and return a mutable reference.
    pub fn find_pane_mut(&mut self, id: PaneId) -> Option<&mut Pane> {
        match self {
            LayoutNode::Pane(pane) => {
                if pane.id == id {
                    Some(pane)
                } else {
                    None
                }
            }
            LayoutNode::Split { first, second, .. } => {
                first.find_pane_mut(id).or_else(|| second.find_pane_mut(id))
            }
        }
    }

    /// Find a pane by ID and return an immutable reference.
    pub fn find_pane(&self, id: PaneId) -> Option<&Pane> {
        match self {
            LayoutNode::Pane(pane) => {
                if pane.id == id {
                    Some(pane)
                } else {
                    None
                }
            }
            LayoutNode::Split { first, second, .. } => {
                first.find_pane(id).or_else(|| second.find_pane(id))
            }
        }
    }

    /// Get all pane IDs in this layout.
    pub fn pane_ids(&self) -> Vec<PaneId> {
        let mut ids = Vec::new();
        self.collect_pane_ids(&mut ids);
        ids
    }

    fn collect_pane_ids(&self, ids: &mut Vec<PaneId>) {
        match self {
            LayoutNode::Pane(pane) => ids.push(pane.id),
            LayoutNode::Split { first, second, .. } => {
                first.collect_pane_ids(ids);
                second.collect_pane_ids(ids);
            }
        }
    }

    /// Get all panes in this layout.
    pub fn panes(&self) -> Vec<&Pane> {
        let mut panes = Vec::new();
        self.collect_panes(&mut panes);
        panes
    }

    fn collect_panes<'a>(&'a self, panes: &mut Vec<&'a Pane>) {
        match self {
            LayoutNode::Pane(pane) => panes.push(pane),
            LayoutNode::Split { first, second, .. } => {
                first.collect_panes(panes);
                second.collect_panes(panes);
            }
        }
    }

    /// Count the total number of panes.
    pub fn pane_count(&self) -> usize {
        match self {
            LayoutNode::Pane(_) => 1,
            LayoutNode::Split { first, second, .. } => first.pane_count() + second.pane_count(),
        }
    }

    /// Remove a pane by ID. Returns true if removed, false if not found.
    /// If this would remove the last pane, returns false without removing.
    pub fn remove_pane(&mut self, id: PaneId) -> bool {
        if self.pane_count() <= 1 {
            return false;
        }
        self.remove_pane_internal(id)
    }

    fn remove_pane_internal(&mut self, id: PaneId) -> bool {
        match self {
            LayoutNode::Pane(pane) => pane.id == id,
            LayoutNode::Split { first, second, .. } => {
                let first_contains = first.contains_pane(id);
                let second_contains = second.contains_pane(id);

                if first_contains {
                    if first.pane_count() == 1 {
                        // Replace self with second
                        let second_node = std::mem::replace(second.as_mut(), LayoutNode::empty());
                        *self = second_node;
                        true
                    } else {
                        first.remove_pane_internal(id)
                    }
                } else if second_contains {
                    if second.pane_count() == 1 {
                        // Replace self with first
                        let first_node = std::mem::replace(first.as_mut(), LayoutNode::empty());
                        *self = first_node;
                        true
                    } else {
                        second.remove_pane_internal(id)
                    }
                } else {
                    false
                }
            }
        }
    }

    fn contains_pane(&self, id: PaneId) -> bool {
        match self {
            LayoutNode::Pane(pane) => pane.id == id,
            LayoutNode::Split { first, second, .. } => {
                first.contains_pane(id) || second.contains_pane(id)
            }
        }
    }

    /// Calculate areas for all panes given a bounding rect.
    pub fn calculate_areas(&mut self, area: Rect) {
        match self {
            LayoutNode::Pane(pane) => {
                pane.area = Some(area);
            }
            LayoutNode::Split {
                direction,
                ratio,
                first,
                second,
            } => {
                let (first_area, second_area) = match direction {
                    Direction::Horizontal => {
                        let split_point = (area.height as f32 * *ratio) as u16;
                        let first_area = Rect::new(area.x, area.y, area.width, split_point);
                        let second_area = Rect::new(
                            area.x,
                            area.y + split_point,
                            area.width,
                            area.height.saturating_sub(split_point),
                        );
                        (first_area, second_area)
                    }
                    Direction::Vertical => {
                        let split_point = (area.width as f32 * *ratio) as u16;
                        let first_area = Rect::new(area.x, area.y, split_point, area.height);
                        let second_area = Rect::new(
                            area.x + split_point,
                            area.y,
                            area.width.saturating_sub(split_point),
                            area.height,
                        );
                        (first_area, second_area)
                    }
                };
                first.calculate_areas(first_area);
                second.calculate_areas(second_area);
            }
        }
    }

    /// Find the pane in a given direction from the specified pane.
    pub fn find_neighbor(&self, from_id: PaneId, direction: NavDirection) -> Option<PaneId> {
        let panes = self.panes();
        let from_pane = panes.iter().find(|p| p.id == from_id)?;
        let from_area = from_pane.area?;

        // Find the center point of the source pane
        let from_center_x = from_area.x + from_area.width / 2;
        let from_center_y = from_area.y + from_area.height / 2;

        let mut best_candidate: Option<(PaneId, i32)> = None;

        for pane in panes {
            if pane.id == from_id {
                continue;
            }
            let Some(area) = pane.area else {
                continue;
            };

            let center_x = area.x + area.width / 2;
            let center_y = area.y + area.height / 2;

            // Check if this pane is in the right direction
            let is_valid_direction = match direction {
                NavDirection::Left => area.x + area.width <= from_area.x,
                NavDirection::Right => area.x >= from_area.x + from_area.width,
                NavDirection::Up => area.y + area.height <= from_area.y,
                NavDirection::Down => area.y >= from_area.y + from_area.height,
            };

            if !is_valid_direction {
                continue;
            }

            // Calculate distance (prefer panes that are more aligned)
            let dist = match direction {
                NavDirection::Left | NavDirection::Right => {
                    let dx = (center_x as i32 - from_center_x as i32).abs();
                    let dy = (center_y as i32 - from_center_y as i32).abs();
                    dx + dy * 2 // Weight vertical distance more to prefer horizontally aligned
                }
                NavDirection::Up | NavDirection::Down => {
                    let dx = (center_x as i32 - from_center_x as i32).abs();
                    let dy = (center_y as i32 - from_center_y as i32).abs();
                    dy + dx * 2 // Weight horizontal distance more to prefer vertically aligned
                }
            };

            match best_candidate {
                None => best_candidate = Some((pane.id, dist)),
                Some((_, best_dist)) if dist < best_dist => best_candidate = Some((pane.id, dist)),
                _ => {}
            }
        }

        best_candidate.map(|(id, _)| id)
    }

    /// Resize the split containing the given pane in the specified direction.
    pub fn resize_pane(&mut self, pane_id: PaneId, direction: NavDirection, delta: f32) {
        self.resize_pane_internal(pane_id, direction, delta);
    }

    fn resize_pane_internal(&mut self, pane_id: PaneId, direction: NavDirection, delta: f32) {
        match self {
            LayoutNode::Pane(_) => {}
            LayoutNode::Split {
                direction: split_dir,
                ratio,
                first,
                second,
            } => {
                let first_contains = first.contains_pane(pane_id);
                let second_contains = second.contains_pane(pane_id);

                // Check if this split is relevant to the resize direction
                let is_relevant = matches!(
                    (split_dir, direction),
                    (
                        Direction::Vertical,
                        NavDirection::Left | NavDirection::Right
                    ) | (Direction::Horizontal, NavDirection::Up | NavDirection::Down)
                );

                if is_relevant && (first_contains || second_contains) {
                    let adjustment = match direction {
                        NavDirection::Left | NavDirection::Up => {
                            if first_contains {
                                -delta
                            } else {
                                delta
                            }
                        }
                        NavDirection::Right | NavDirection::Down => {
                            if first_contains {
                                delta
                            } else {
                                -delta
                            }
                        }
                    };

                    *ratio = (*ratio + adjustment).clamp(0.1, 0.9);
                } else {
                    // Recurse into the appropriate child
                    if first_contains {
                        first.resize_pane_internal(pane_id, direction, delta);
                    } else if second_contains {
                        second.resize_pane_internal(pane_id, direction, delta);
                    }
                }
            }
        }
    }
}

/// A tab in the workspace.
#[derive(Debug, Clone)]
pub struct Tab {
    pub id: TabId,
    pub name: String,
    pub layout: LayoutNode,
    pub active_pane: Option<PaneId>,
}

impl Tab {
    pub fn new(name: impl Into<String>) -> Self {
        let layout = LayoutNode::terminal(None, "Terminal");
        let active_pane = layout.pane_ids().first().copied();
        Self {
            id: TabId::new(),
            name: name.into(),
            layout,
            active_pane,
        }
    }

    /// Split the active pane in the given direction.
    pub fn split(&mut self, direction: Direction, new_pane: Pane) {
        let Some(active_id) = self.active_pane else {
            return;
        };

        // Find the node containing the active pane and split it
        self.split_at_pane(&active_id, direction, new_pane);
    }

    fn split_at_pane(&mut self, pane_id: &PaneId, direction: Direction, new_pane: Pane) {
        let new_pane_id = new_pane.id;
        Self::split_node_at_pane(&mut self.layout, pane_id, direction, new_pane);
        self.active_pane = Some(new_pane_id);
    }

    fn split_node_at_pane(
        node: &mut LayoutNode,
        pane_id: &PaneId,
        direction: Direction,
        new_pane: Pane,
    ) -> bool {
        match node {
            LayoutNode::Pane(pane) => {
                if pane.id == *pane_id {
                    node.split(direction, new_pane);
                    true
                } else {
                    false
                }
            }
            LayoutNode::Split { first, second, .. } => {
                Self::split_node_at_pane(first, pane_id, direction, new_pane.clone())
                    || Self::split_node_at_pane(second, pane_id, direction, new_pane)
            }
        }
    }

    /// Close the active pane.
    pub fn close_active_pane(&mut self) -> bool {
        let Some(active_id) = self.active_pane else {
            return false;
        };

        if self.layout.remove_pane(active_id) {
            // Select a new active pane
            self.active_pane = self.layout.pane_ids().first().copied();
            true
        } else {
            false
        }
    }

    /// Navigate to a neighbor pane.
    pub fn navigate(&mut self, direction: NavDirection) {
        let Some(active_id) = self.active_pane else {
            return;
        };

        if let Some(neighbor_id) = self.layout.find_neighbor(active_id, direction) {
            self.active_pane = Some(neighbor_id);
        }
    }

    /// Cycle to the next pane.
    pub fn next_pane(&mut self) {
        let pane_ids = self.layout.pane_ids();
        if pane_ids.is_empty() {
            return;
        }

        let current_idx = self
            .active_pane
            .and_then(|id| pane_ids.iter().position(|&pid| pid == id))
            .unwrap_or(0);

        let next_idx = (current_idx + 1) % pane_ids.len();
        self.active_pane = Some(pane_ids[next_idx]);
    }

    /// Cycle to the previous pane.
    pub fn prev_pane(&mut self) {
        let pane_ids = self.layout.pane_ids();
        if pane_ids.is_empty() {
            return;
        }

        let current_idx = self
            .active_pane
            .and_then(|id| pane_ids.iter().position(|&pid| pid == id))
            .unwrap_or(0);

        let prev_idx = if current_idx == 0 {
            pane_ids.len() - 1
        } else {
            current_idx - 1
        };
        self.active_pane = Some(pane_ids[prev_idx]);
    }

    /// Resize the active pane in the given direction.
    pub fn resize(&mut self, direction: NavDirection, delta: f32) {
        let Some(active_id) = self.active_pane else {
            return;
        };
        self.layout.resize_pane(active_id, direction, delta);
    }
}

/// The workspace containing all tabs.
#[derive(Debug)]
pub struct Workspace {
    pub tabs: Vec<Tab>,
    pub active_tab_index: usize,
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

impl Workspace {
    pub fn new() -> Self {
        Self {
            tabs: vec![Tab::new("Tab 1")],
            active_tab_index: 0,
        }
    }

    /// Get the active tab.
    pub fn active_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.active_tab_index)
    }

    /// Get the active tab mutably.
    pub fn active_tab_mut(&mut self) -> Option<&mut Tab> {
        self.tabs.get_mut(self.active_tab_index)
    }

    /// Create a new tab.
    pub fn new_tab(&mut self) -> TabId {
        let tab_num = self.tabs.len() + 1;
        let tab = Tab::new(format!("Tab {}", tab_num));
        let id = tab.id;
        self.tabs.push(tab);
        self.active_tab_index = self.tabs.len() - 1;
        id
    }

    /// Close the active tab.
    pub fn close_active_tab(&mut self) -> bool {
        if self.tabs.len() <= 1 {
            return false;
        }

        self.tabs.remove(self.active_tab_index);
        if self.active_tab_index >= self.tabs.len() {
            self.active_tab_index = self.tabs.len() - 1;
        }
        true
    }

    /// Switch to the next tab.
    pub fn next_tab(&mut self) {
        if !self.tabs.is_empty() {
            self.active_tab_index = (self.active_tab_index + 1) % self.tabs.len();
        }
    }

    /// Switch to the previous tab.
    pub fn prev_tab(&mut self) {
        if !self.tabs.is_empty() {
            self.active_tab_index = if self.active_tab_index == 0 {
                self.tabs.len() - 1
            } else {
                self.active_tab_index - 1
            };
        }
    }

    /// Go to a specific tab by index (0-based).
    pub fn go_to_tab(&mut self, index: usize) {
        if index < self.tabs.len() {
            self.active_tab_index = index;
        }
    }

    /// Move the active tab left.
    pub fn move_tab_left(&mut self) {
        if self.active_tab_index > 0 {
            self.tabs
                .swap(self.active_tab_index, self.active_tab_index - 1);
            self.active_tab_index -= 1;
        }
    }

    /// Move the active tab right.
    pub fn move_tab_right(&mut self) {
        if self.active_tab_index < self.tabs.len() - 1 {
            self.tabs
                .swap(self.active_tab_index, self.active_tab_index + 1);
            self.active_tab_index += 1;
        }
    }

    /// Rename the active tab.
    pub fn rename_active_tab(&mut self, name: impl Into<String>) {
        if let Some(tab) = self.active_tab_mut() {
            tab.name = name.into();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn can_create_workspace() {
        let workspace = Workspace::new();
        assert_eq!(workspace.tabs.len(), 1);
        assert_eq!(workspace.active_tab_index, 0);
    }

    #[test]
    fn can_add_tabs() {
        let mut workspace = Workspace::new();
        workspace.new_tab();
        workspace.new_tab();
        assert_eq!(workspace.tabs.len(), 3);
        assert_eq!(workspace.active_tab_index, 2);
    }

    #[test]
    fn can_navigate_tabs() {
        let mut workspace = Workspace::new();
        workspace.new_tab();
        workspace.new_tab();
        workspace.go_to_tab(0);
        assert_eq!(workspace.active_tab_index, 0);
        workspace.next_tab();
        assert_eq!(workspace.active_tab_index, 1);
        workspace.prev_tab();
        assert_eq!(workspace.active_tab_index, 0);
    }

    #[test]
    fn can_split_pane() {
        let mut workspace = Workspace::new();
        if let Some(tab) = workspace.active_tab_mut() {
            let initial_count = tab.layout.pane_count();
            tab.split(Direction::Vertical, Pane::empty());
            assert_eq!(tab.layout.pane_count(), initial_count + 1);
        }
    }

    #[test]
    fn can_close_pane() {
        let mut workspace = Workspace::new();
        if let Some(tab) = workspace.active_tab_mut() {
            tab.split(Direction::Vertical, Pane::empty());
            let count_before = tab.layout.pane_count();
            tab.close_active_pane();
            assert_eq!(tab.layout.pane_count(), count_before - 1);
        }
    }
}
