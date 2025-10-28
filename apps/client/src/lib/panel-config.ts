export type PanelType = "chat" | "workspace" | "terminal" | "browser" | "gitDiff";

export interface PanelConfig {
  topLeft: PanelType | null;
  topRight: PanelType | null;
  bottomLeft: PanelType | null;
  bottomRight: PanelType | null;
}

export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  topLeft: "chat",
  topRight: "workspace",
  bottomLeft: "terminal",
  bottomRight: "browser",
};

export const PANEL_LABELS: Record<PanelType, string> = {
  chat: "Activity",
  workspace: "Workspace",
  terminal: "Terminal",
  browser: "Browser",
  gitDiff: "Git Diff",
};

export const PANEL_ICONS: Record<PanelType, string> = {
  chat: "MessageSquare",
  workspace: "Code2",
  terminal: "TerminalSquare",
  browser: "Globe2",
  gitDiff: "GitCompare",
};

const STORAGE_KEY = "taskPanelConfig";

export function loadPanelConfig(): PanelConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        topLeft: parsed.topLeft ?? DEFAULT_PANEL_CONFIG.topLeft,
        topRight: parsed.topRight ?? DEFAULT_PANEL_CONFIG.topRight,
        bottomLeft: parsed.bottomLeft ?? DEFAULT_PANEL_CONFIG.bottomLeft,
        bottomRight: parsed.bottomRight ?? DEFAULT_PANEL_CONFIG.bottomRight,
      };
    }
  } catch (error) {
    console.error("Failed to load panel config:", error);
  }
  return DEFAULT_PANEL_CONFIG;
}

export function savePanelConfig(config: PanelConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error("Failed to save panel config:", error);
  }
}

export function resetPanelConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error("Failed to reset panel config:", error);
  }
}

export function getAvailablePanels(config: PanelConfig): PanelType[] {
  const allPanels: PanelType[] = ["chat", "workspace", "terminal", "browser", "gitDiff"];
  const usedPanels = new Set([
    config.topLeft,
    config.topRight,
    config.bottomLeft,
    config.bottomRight,
  ].filter((p): p is PanelType => p !== null));

  return allPanels.filter(panel => !usedPanels.has(panel));
}
