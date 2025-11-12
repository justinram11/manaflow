type WorkspaceSetupPanelProps = {
  teamSlugOrId: string;
  projectFullName: string | null;
};

export function WorkspaceSetupPanel({
  teamSlugOrId: _teamSlugOrId,
  projectFullName: _projectFullName,
}: WorkspaceSetupPanelProps) {
  // Workspace configs no longer support maintenance scripts and env vars
  // These should be configured via environments instead
  return null;
}
