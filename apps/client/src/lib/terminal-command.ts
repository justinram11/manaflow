import type { CreateTerminalTabRequest } from "@/queries/terminals";

type TerminalIntent = "create-session" | "attach-session";

interface BuildTerminalCommandOptions {
  intent: TerminalIntent;
  isCloudWorkspace: boolean;
}

const TMUX_SESSION_NAME = "cmux";
const WORKSPACE_ROOT = "/root/workspace";
const DEFAULT_WINDOW_NAMES = ["main", "maintenance", "dev"] as const;

function buildEnsureSessionScript(): string {
  const primaryWindow = DEFAULT_WINDOW_NAMES[0];
  const additionalWindows = DEFAULT_WINDOW_NAMES.slice(1)
    .map(
      (windowName) =>
        `  tmux new-window -t "$SESSION:" -n "${windowName}" -c "$WORKSPACE_ROOT"`,
    )
    .join("\n");

  return `ensure_session() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    return
  fi

  tmux new-session -d -s "$SESSION" -c "$WORKSPACE_ROOT" -n "${primaryWindow}"
  tmux rename-window -t "$SESSION:1" "${primaryWindow}" >/dev/null 2>&1 || true
${additionalWindows ? `${additionalWindows}\n` : ""}
}
ensure_session`;
}

function buildCloudWorkspaceCommand(): CreateTerminalTabRequest {
  const bootstrapScript = `set -euo pipefail
SESSION="${TMUX_SESSION_NAME}"
WORKSPACE_ROOT="${WORKSPACE_ROOT}"
${buildEnsureSessionScript()}

tmux select-window -t "$SESSION:${DEFAULT_WINDOW_NAMES[0]}" >/dev/null 2>&1 || true
exec tmux attach -t "$SESSION"`;

  return {
    cmd: "bash",
    args: ["-lc", bootstrapScript],
  };
}

function buildStandardCommand(intent: TerminalIntent): CreateTerminalTabRequest {
  if (intent === "create-session") {
    return {
      cmd: "tmux",
      args: ["new-session", "-A", TMUX_SESSION_NAME],
    };
  }

  const script = `set -euo pipefail
tmux select-window -t ${TMUX_SESSION_NAME}:0 >/dev/null 2>&1 || true
exec tmux attach -t ${TMUX_SESSION_NAME}`;

  return {
    cmd: "bash",
    args: ["-lc", script],
  };
}

export function buildTerminalCommand({
  intent,
  isCloudWorkspace,
}: BuildTerminalCommandOptions): CreateTerminalTabRequest {
  if (isCloudWorkspace) {
    return buildCloudWorkspaceCommand();
  }

  return buildStandardCommand(intent);
}
