import { env } from "@/client-env";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useExpandTasks } from "@/contexts/expand-tasks/ExpandTasksContext";
import { useSocket } from "@/contexts/socket/use-socket";
import { useTheme } from "@/components/theme/use-theme";
import { postApiTasks } from "@cmux/www-openapi-client";
import type {
  CreateLocalWorkspaceResponse,
  CreateCloudWorkspaceResponse,
} from "@cmux/shared";
import { useMutation } from "@tanstack/react-query";
import { Cloud, Loader2, Monitor } from "lucide-react";
import { useCallback, useState } from "react";
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

  const reserveLocalWorkspaceMutation = useMutation({
    mutationFn: async (_args: { teamSlugOrId: string; projectFullName: string; repoUrl: string }) => {
      // This uses the socket emit below, so this is a placeholder
      // The actual reservation is done via socket
      return null as unknown as { taskId: string; taskRunId: string; workspaceName: string; descriptor: string };
    },
  });
  const createTaskMutation = useMutation({
    mutationFn: async (args: {
      teamSlugOrId: string;
      text: string;
      projectFullName?: string;
      baseBranch?: string;
      environmentId?: string;
      isCloudWorkspace?: boolean;
    }) => {
      const result = await postApiTasks({ body: args });
      return result.data as { taskId: string };
    },
  });

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

    const projectFullName = selectedProject[0];
    const repoUrl = `https://github.com/${projectFullName}.git`;

    setIsCreatingLocal(true);

    try {
      const reservation = await reserveLocalWorkspaceMutation.mutateAsync({
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
    reserveLocalWorkspaceMutation,
    addTaskToExpand,
  ]);

  const handleCreateCloudWorkspace = useCallback(async () => {
    if (!socket) {
      toast.error("Socket not connected");
      return;
    }

    if (selectedProject.length === 0) {
      toast.error("Please select an environment first");
      return;
    }

    if (!isEnvSelected) {
      toast.error("Cloud workspaces require an environment, not a repository");
      return;
    }

    const projectFullName = selectedProject[0];
    const environmentId = projectFullName.replace(
      /^env:/,
      ""
    );

    // Extract environment name from the selectedProject (format is "env:id:name")
    const environmentName = projectFullName.split(":")[2] || "Unknown Environment";

    setIsCreatingCloud(true);

    try {
      // Create task with environment name
      const { taskId } = await createTaskMutation.mutateAsync({
        teamSlugOrId,
        text: environmentName,
        environmentId,
        isCloudWorkspace: true,
      });

      // Hint the sidebar to auto-expand this task once it appears
      addTaskToExpand(taskId);

      await new Promise<void>((resolve) => {
        socket.emit(
          "create-cloud-workspace",
          {
            teamSlugOrId,
            environmentId,
            taskId,
            theme,
          },
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
    isEnvSelected,
    teamSlugOrId,
    createTaskMutation,
    addTaskToExpand,
    theme,
  ]);

  const canCreateLocal = selectedProject.length > 0 && !isEnvSelected;
  const canCreateCloud = selectedProject.length > 0 && isEnvSelected;

  const SHOW_WORKSPACE_BUTTONS = false;

  if (!SHOW_WORKSPACE_BUTTONS) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 mb-3">
      {!env.NEXT_PUBLIC_WEB_MODE && (
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
                <Monitor className="w-3.5 h-3.5" />
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
      )}

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
              <Cloud className="w-4 h-4" />
            )}
            <span>Create Cloud Workspace</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {!selectedProject.length
            ? "Select an environment first"
            : !isEnvSelected
              ? "Switch to environment mode (not repository)"
              : "Create workspace from selected environment"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
