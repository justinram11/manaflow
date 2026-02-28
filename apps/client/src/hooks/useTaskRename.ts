import {
  patchApiTasksById,
} from "@cmux/www-openapi-client";
import type { DbTaskListResponse } from "@cmux/www-openapi-client";
import {
  getApiTasksQueryKey,
  getApiTasksByIdQueryKey,
} from "@cmux/www-openapi-client/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";

interface UseTaskRenameOptions {
  taskId: string;
  teamSlugOrId: string;
  currentText: string;
  canRename: boolean;
}

export function useTaskRename({
  taskId,
  teamSlugOrId,
  currentText,
  canRename,
}: UseTaskRenameOptions) {
  const queryClient = useQueryClient();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(currentText);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenamePending, setIsRenamePending] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRenameFocusFrame = useRef<number | null>(null);
  const renameInputHasFocusedRef = useRef(false);

  const updateTaskMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      patchApiTasksById({
        path: { id },
        body: { teamSlugOrId, text },
        throwOnError: true,
      }),
    onMutate: async ({ id, text }) => {
      const optimisticUpdatedAt = Date.now();

      type ListVariant = { teamSlugOrId: string; archived?: "true" | "false" };
      const listVariants: ListVariant[] = [
        { teamSlugOrId },
        { teamSlugOrId, archived: "false" },
        { teamSlugOrId, archived: "true" },
      ];

      const previousLists: Array<{ key: readonly unknown[]; data: DbTaskListResponse | undefined }> = [];

      for (const variant of listVariants) {
        const key = getApiTasksQueryKey({ query: variant });
        await queryClient.cancelQueries({ queryKey: key });
        const prev = queryClient.getQueryData<DbTaskListResponse>(key);
        previousLists.push({ key, data: prev });

        if (prev) {
          queryClient.setQueryData(key, {
            ...prev,
            tasks: prev.tasks.map((t) =>
              t.id === id ? { ...t, text, updatedAt: optimisticUpdatedAt } : t
            ),
          });
        }
      }

      const detailKey = getApiTasksByIdQueryKey({ path: { id }, query: { teamSlugOrId } });
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previousDetail = queryClient.getQueryData(detailKey);
      if (previousDetail && typeof previousDetail === "object") {
        queryClient.setQueryData(detailKey, {
          ...previousDetail,
          text,
          updatedAt: optimisticUpdatedAt,
        });
      }

      return { previousLists, previousDetail, detailKey };
    },
    onError: (_err, _args, context) => {
      if (context) {
        for (const { key, data } of context.previousLists) {
          if (data) queryClient.setQueryData(key, data);
        }
        if (context.previousDetail) {
          queryClient.setQueryData(context.detailKey, context.previousDetail);
        }
      }
    },
    onSettled: (_data, _err, args) => {
      void queryClient.invalidateQueries({ queryKey: getApiTasksQueryKey({ query: { teamSlugOrId } }) });
      void queryClient.invalidateQueries({ queryKey: getApiTasksByIdQueryKey({ path: { id: args.id }, query: { teamSlugOrId } }) });
    },
  });

  const focusRenameInput = useCallback(() => {
    if (typeof window === "undefined") {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
      return;
    }
    if (pendingRenameFocusFrame.current !== null) {
      window.cancelAnimationFrame(pendingRenameFocusFrame.current);
    }
    pendingRenameFocusFrame.current = window.requestAnimationFrame(() => {
      pendingRenameFocusFrame.current = null;
      const input = renameInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.select();
    });
  }, []);

  useEffect(
    () => () => {
      if (pendingRenameFocusFrame.current !== null) {
        window.cancelAnimationFrame(pendingRenameFocusFrame.current);
        pendingRenameFocusFrame.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (!isRenaming) {
      setRenameValue(currentText);
    }
  }, [isRenaming, currentText]);

  const handleRenameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setRenameValue(event.target.value);
      if (renameError) {
        setRenameError(null);
      }
    },
    [renameError]
  );

  const handleRenameCancel = useCallback(() => {
    setRenameValue(currentText);
    setRenameError(null);
    setIsRenaming(false);
  }, [currentText]);

  const handleRenameSubmit = useCallback(async () => {
    if (!canRename) {
      setIsRenaming(false);
      return;
    }
    if (isRenamePending) {
      return;
    }
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError("Task name is required.");
      renameInputRef.current?.focus();
      return;
    }
    const current = currentText.trim();
    if (trimmed === current) {
      setIsRenaming(false);
      setRenameError(null);
      return;
    }
    setIsRenamePending(true);
    try {
      await updateTaskMutation.mutateAsync({
        id: taskId,
        text: trimmed,
      });
      setIsRenaming(false);
      setRenameError(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to rename task.";
      setRenameError(message);
      toast.error(message);
      renameInputRef.current?.focus();
    } finally {
      setIsRenamePending(false);
    }
  }, [
    canRename,
    isRenamePending,
    renameValue,
    taskId,
    currentText,
    updateTaskMutation,
  ]);

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void handleRenameSubmit();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        handleRenameCancel();
      }
    },
    [handleRenameCancel, handleRenameSubmit]
  );

  const handleRenameBlur = useCallback(() => {
    if (!renameInputHasFocusedRef.current) {
      focusRenameInput();
      return;
    }
    void handleRenameSubmit();
  }, [focusRenameInput, handleRenameSubmit]);

  const handleRenameFocus = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      renameInputHasFocusedRef.current = true;
      event.currentTarget.select();
    },
    []
  );

  const handleStartRenaming = useCallback(() => {
    if (!canRename) {
      return;
    }
    flushSync(() => {
      setRenameValue(currentText);
      setRenameError(null);
      setIsRenaming(true);
    });
    renameInputHasFocusedRef.current = false;
    focusRenameInput();
  }, [canRename, focusRenameInput, currentText]);

  return {
    isRenaming,
    renameValue,
    renameError,
    isRenamePending,
    renameInputRef,
    handleRenameChange,
    handleRenameCancel,
    handleRenameSubmit,
    handleRenameKeyDown,
    handleRenameBlur,
    handleRenameFocus,
    handleStartRenaming,
  };
}
