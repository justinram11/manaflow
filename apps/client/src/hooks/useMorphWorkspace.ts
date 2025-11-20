import { useMutation, useQuery } from "@tanstack/react-query";
import {
  postApiMorphTaskRunsByTaskRunIdIsPaused,
  type Options,
  type PostApiMorphTaskRunsByTaskRunIdResumeData,
  type PostApiMorphTaskRunsByTaskRunIdResumeResponse,
} from "@cmux/www-openapi-client";
import {
  postApiMorphTaskRunsByTaskRunIdResumeMutation,
} from "@cmux/www-openapi-client/react-query";
import { toast } from "sonner";
import { queryClient } from "@/query-client";

interface MorphWorkspaceQueryArgs {
  taskRunId: string;
  teamSlugOrId: string;
  enabled?: boolean;
}

interface UseResumeMorphWorkspaceArgs {
  taskRunId: string;
  teamSlugOrId: string;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

export function morphPauseQueryKey(
  taskRunId: string,
  teamSlugOrId: string
) {
  return ["morph", "task-run", taskRunId, "paused", teamSlugOrId] as const;
}

export function useMorphInstancePauseQuery({
  taskRunId,
  teamSlugOrId,
  enabled,
}: MorphWorkspaceQueryArgs) {
  return useQuery({
    queryKey: morphPauseQueryKey(taskRunId, teamSlugOrId),
    queryFn: async ({ signal }) => {
      const { data } = await postApiMorphTaskRunsByTaskRunIdIsPaused({
        path: {
          taskRunId,
        },
        body: {
          teamSlugOrId,
        },
        signal,
        throwOnError: true,
      });
      return data;
    },
    enabled,
  });
}

export function useResumeMorphWorkspace({
  taskRunId,
  teamSlugOrId,
  onSuccess,
  onError,
}: UseResumeMorphWorkspaceArgs) {
  return useMutation<
    PostApiMorphTaskRunsByTaskRunIdResumeResponse,
    Error,
    Options<PostApiMorphTaskRunsByTaskRunIdResumeData>,
    { toastId: string | number }
  >({
    ...postApiMorphTaskRunsByTaskRunIdResumeMutation(),
    mutationKey: ["resume", "task-run", taskRunId],
    onMutate: async () => {
      const toastId = toast.loading("Resuming workspace…");
      return { toastId };
    },
    onSuccess: (_data, __, context) => {
      toast.success("Workspace resumed", { id: context?.toastId });
      queryClient.setQueryData(morphPauseQueryKey(taskRunId, teamSlugOrId), {
        paused: false,
      });
      onSuccess?.();
    },
    onError: (error, _variables, context) => {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to resume workspace.";
      toast.error(message, { id: context?.toastId });
      onError?.(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: morphPauseQueryKey(taskRunId, teamSlugOrId),
      });
    },
  });
}
