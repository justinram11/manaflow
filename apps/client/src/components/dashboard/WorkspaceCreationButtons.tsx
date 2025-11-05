import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useExpandTasks } from "@/contexts/expand-tasks/ExpandTasksContext";
import { useSocket } from "@/contexts/socket/use-socket";
import { useTheme } from "@/components/theme/use-theme";
import { api } from "@cmux/convex/api";
import type { Doc, Id } from "@cmux/convex/dataModel";
import type {
  CreateLocalWorkspaceResponse,
  CreateCloudWorkspaceResponse,
  CreateCloudWorkspace,
} from "@cmux/shared";
import { useMutation, useQuery } from "convex/react";
import { Server as ServerIcon, FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

type WorkspaceCreationButtonsProps = {
  teamSlugOrId: string;
  selectedProject: string[];
  isEnvSelected: boolean;
};

export function WorkspaceCreationButtons({
  teamSlugOrId,
  selectedProject,
  isEnvSelected,
}: WorkspaceCreationButtonsProps) {
  const { socket } = useSocket();
  const { addTaskToExpand } = useExpandTasks();
  const { theme } = useTheme();
  const [isCreatingLocal, setIsCreatingLocal] = useState(false);
  const [isCreatingCloud, setIsCreatingCloud] = useState(false);

  const reserveLocalWorkspace = useMutation(api.localWorkspaces.reserve);
  const createTask = useMutation(api.tasks.create);
  const environments = useQuery(api.environments.list, { teamSlugOrId });

  const environmentById = useMemo(() => {
    const map = new Map<Id<"environments">, Doc<"environments">>();
    if (!environments) {
      return map;
    }
    environments.forEach((environment) => {
      map.set(environment._id, environment);
    });
    return map;
  }, [environments]);

  const selectionMeta = useMemo(() => {
    const selection = selectedProject[0] ?? null;
    if (!selection) {
      return {
        kind: "none" as const,
        workspaceLabel: "Unknown Selection",
      };
    }

    if (selection.startsWith("env:")) {
      const environmentId = selection.replace(/^env:/, "") as Id<"environments">;
      const environment = environmentById.get(environmentId);
      return {
        kind: "environment" as const,
        environmentId,
        environment,
        workspaceLabel: environment?.name ?? "Unknown Environment",
      };
    }

    return {
      kind: "repository" as const,
      projectFullName: selection,
      workspaceLabel: selection,
      repoUrl: `https://github.com/${selection}.git`,
    };
  }, [environmentById, selectedProject]);

  const handleCreateLocalWorkspace = useCallback(async () => {
    if (!socket) {
      toast.error("Socket not connected");
      return;
    }

    if (selectedProject.length === 0) {
      toast.error("Please select a repository first");
      return;
    }

    if (isEnvSelected) {
      toast.error("Local workspaces require a repository, not an environment");
      return;
    }

    const projectFullName = selectionMeta.kind === "repository"
      ? selectionMeta.projectFullName
      : undefined;

    if (!projectFullName) {
      toast.error("Local workspaces require a repository selection");
      return;
    }

    const repoUrl = selectionMeta.repoUrl ?? `https://github.com/${projectFullName}.git`;

    setIsCreatingLocal(true);

    try {
      const reservation = await reserveLocalWorkspace({
        teamSlugOrId,
        projectFullName,
        repoUrl,
      });

      if (!reservation) {
        throw new Error("Unable to reserve workspace name");
      }

      addTaskToExpand(reservation.taskId);

      await new Promise<void>((resolve) => {
        socket.emit(
          "create-local-workspace",
          {
            teamSlugOrId,
            projectFullName,
            repoUrl,
            taskId: reservation.taskId,
            taskRunId: reservation.taskRunId,
            workspaceName: reservation.workspaceName,
            descriptor: reservation.descriptor,
          },
          async (response: CreateLocalWorkspaceResponse) => {
            if (response.success) {
              toast.success(
                `Local workspace "${reservation.workspaceName}" created successfully`
              );
            } else {
              toast.error(
                response.error || "Failed to create local workspace"
              );
            }
            resolve();
          }
        );
      });
    } catch (error) {
      console.error("Error creating local workspace:", error);
      toast.error("Failed to create local workspace");
    } finally {
      setIsCreatingLocal(false);
    }
  }, [
    socket,
    selectedProject,
    isEnvSelected,
    teamSlugOrId,
    reserveLocalWorkspace,
    addTaskToExpand,
    selectionMeta,
  ]);

  const handleCreateCloudWorkspace = useCallback(async () => {
    if (!socket) {
      toast.error("Socket not connected");
      return;
    }

    if (selectedProject.length === 0) {
      toast.error("Please select a repository or environment first");
      return;
    }

    const environmentId = selectionMeta.kind === "environment"
      ? selectionMeta.environmentId
      : undefined;
    const projectFullName = selectionMeta.kind === "repository"
      ? selectionMeta.projectFullName
      : undefined;
    const workspaceLabel = selectionMeta.workspaceLabel;
    const repoUrl = selectionMeta.repoUrl;

    setIsCreatingCloud(true);

    try {
      const taskId = await createTask({
        teamSlugOrId,
        text: `Cloud Workspace: ${workspaceLabel}`,
        projectFullName,
        baseBranch: undefined,
        environmentId,
        isCloudWorkspace: true,
      });

      addTaskToExpand(taskId);

      const payload: CreateCloudWorkspace = {
        teamSlugOrId,
        taskId,
        theme,
        ...(environmentId ? { environmentId } : {}),
        ...(projectFullName
          ? {
              projectFullName,
              repoUrl,
            }
          : {}),
      };

      await new Promise<void>((resolve) => {
        socket.emit(
          "create-cloud-workspace",
          payload,
          async (response: CreateCloudWorkspaceResponse) => {
            if (response.success) {
              toast.success("Cloud workspace created successfully");
            } else {
              toast.error(
                response.error || "Failed to create cloud workspace"
              );
            }
            resolve();
          }
        );
      });

      console.log("Cloud workspace created:", taskId);
    } catch (error) {
      console.error("Error creating cloud workspace:", error);
      toast.error("Failed to create cloud workspace");
    } finally {
      setIsCreatingCloud(false);
    }
  }, [
    socket,
    selectedProject,
    teamSlugOrId,
    createTask,
    addTaskToExpand,
    theme,
    selectionMeta,
  ]);

  const canCreateLocal = selectedProject.length > 0 && !isEnvSelected;
  const canCreateCloud = selectedProject.length > 0;

  const SHOW_WORKSPACE_BUTTONS = false;

  if (!SHOW_WORKSPACE_BUTTONS) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 mb-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCreateLocalWorkspace}
            disabled={!canCreateLocal || isCreatingLocal}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors rounded-lg bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingLocal ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FolderOpen className="w-3.5 h-3.5" />
            )}
            <span>Create Local Workspace</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {!selectedProject.length
            ? "Select a repository first"
            : isEnvSelected
              ? "Switch to repository mode (not environment)"
              : "Create workspace from selected repository"}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCreateCloudWorkspace}
            disabled={!canCreateCloud || isCreatingCloud}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors rounded-lg bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingCloud ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ServerIcon className="w-3.5 h-3.5" />
            )}
            <span>Create Cloud Workspace</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {!selectedProject.length
            ? "Select a repository or environment first"
            : "Create cloud workspace from the current selection"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
