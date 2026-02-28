import type { DbTask } from "@cmux/www-openapi-client";

export type RunEnvironmentSummary = {
  id: string;
  name: string;
  selectedRepos?: string[];
};

export interface TaskRunWithChildren {
  id: string;
  taskId: string;
  parentRunId?: string;
  prompt: string;
  agentName?: string;
  summary?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  isArchived?: boolean;
  isLocalWorkspace?: boolean;
  isCloudWorkspace?: boolean;
  isPreviewJob?: boolean;
  log?: string;
  worktreePath?: string;
  newBranch?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  exitCode?: number;
  environmentError?: {
    devError?: string;
    maintenanceError?: string;
  };
  errorMessage?: string;
  userId: string;
  teamId: string;
  environmentId?: string;
  isCrowned?: boolean;
  crownReason?: string;
  pullRequestUrl?: string;
  pullRequestIsDraft?: boolean;
  pullRequestState?:
    | "none"
    | "draft"
    | "open"
    | "merged"
    | "closed"
    | "unknown";
  pullRequestNumber?: number;
  pullRequests?: Array<{
    repoFullName: string;
    url?: string;
    number?: number;
    state: "none" | "draft" | "open" | "merged" | "closed" | "unknown";
    isDraft?: boolean;
  }>;
  diffsLastUpdated?: number;
  screenshotStorageId?: string;
  screenshotCapturedAt?: number;
  screenshotMimeType?: string;
  screenshotFileName?: string;
  screenshotCommitSha?: string;
  latestScreenshotSetId?: string;
  claims?: Array<{
    claim: string;
    evidence: {
      type: string;
      screenshotIndex?: number;
      filePath?: string;
      startLine?: number;
      endLine?: number;
    };
    timestamp: number;
  }>;
  claimsGeneratedAt?: number;
  vscode?: {
    provider: "docker" | "morph" | "daytona" | "incus" | "other";
    containerName?: string;
    status: "starting" | "running" | "stopped";
    statusMessage?: string;
    ports?: {
      vscode: string;
      worker: string;
      extension?: string;
      proxy?: string;
      vnc?: string;
      pty?: string;
    };
    url?: string;
    workspaceUrl?: string;
    startedAt?: number;
    stoppedAt?: number;
    lastAccessedAt?: number;
    keepAlive?: boolean;
    scheduledStopAt?: number;
  };
  networking?: Array<{
    status: "starting" | "running" | "stopped";
    port: number;
    url: string;
  }>;
  customPreviews?: Array<{
    url: string;
    createdAt: number;
  }>;
  children: TaskRunWithChildren[];
  environment: RunEnvironmentSummary | null;
}

export interface AnnotatedTaskRun extends TaskRunWithChildren {
  agentOrdinal?: number;
  hasDuplicateAgentName?: boolean;
  children: AnnotatedTaskRun[];
}

export interface Repo {
  fullName: string;
  org: string;
  name: string;
}

export interface TaskVersion {
  id: string;
  taskId: string;
  version: number;
  diff: string;
  summary: string;
  createdAt: number;
  userId: string;
  teamId: string;
  files: Array<{
    path: string;
    changes: string;
  }>;
  task: DbTask;
}
