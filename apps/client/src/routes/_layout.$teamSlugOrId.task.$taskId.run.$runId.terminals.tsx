import { api } from "@cmux/convex/api";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { convexQuery } from "@convex-dev/react-query";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import z from "zod";
import {
  TaskRunTerminalSession,
  type TerminalConnectionState,
} from "@/components/task-run-terminal-session";
import { toMorphXtermBaseUrl } from "@/lib/toProxyWorkspaceUrl";
import {
  createTerminalTabQueryOptions,
  terminalTabsQueryKey,
  terminalTabsQueryOptions,
} from "@/queries/terminals";
import type { TerminalTabId } from "@/queries/terminals";

const paramsSchema = z.object({
  taskId: typedZid("tasks"),
  runId: typedZid("taskRuns"),
});

export const Route = createFileRoute(
  "/_layout/$teamSlugOrId/task/$taskId/run/$runId/terminals"
)({
  component: TaskRunTerminals,
  params: {
    parse: paramsSchema.parse,
    stringify: (params) => ({
      taskId: params.taskId,
      runId: params.runId,
    }),
  },
  loader: async (opts) => {
    await opts.context.queryClient.ensureQueryData(
      convexQuery(api.taskRuns.get, {
        teamSlugOrId: opts.params.teamSlugOrId,
        id: opts.params.runId,
      })
    );
  },
});

const CONNECTION_STATE_COLORS: Record<TerminalConnectionState, string> = {
  open: "bg-emerald-500",
  connecting: "bg-amber-500",
  closed: "bg-neutral-400 dark:bg-neutral-600",
  error: "bg-red-500",
};

function TaskRunTerminals() {
  const { runId: taskRunId, teamSlugOrId } = Route.useParams();
  const taskRun = useSuspenseQuery(
    convexQuery(api.taskRuns.get, {
      teamSlugOrId,
      id: taskRunId,
    })
  );

  const vscodeInfo = taskRun?.data?.vscode;
  const rawMorphUrl = vscodeInfo?.url ?? vscodeInfo?.workspaceUrl ?? null;
  const isMorphProvider = vscodeInfo?.provider === "morph";

  const xtermBaseUrl = useMemo(() => {
    if (!rawMorphUrl) {
      return null;
    }
    return toMorphXtermBaseUrl(rawMorphUrl);
  }, [rawMorphUrl]);

  const hasTerminalBackend = Boolean(isMorphProvider && xtermBaseUrl);

  const tabsQuery = useQuery(
    terminalTabsQueryOptions({
      baseUrl: xtermBaseUrl,
      contextKey: taskRunId,
      enabled: hasTerminalBackend,
    })
  );

  const terminalIds = useMemo(() => tabsQuery.data ?? [], [tabsQuery.data]);

  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [connectionStates, setConnectionStates] = useState<
    Record<string, TerminalConnectionState>
  >({});

  const queryClient = useQueryClient();

  const [createTerminalRequestKey, setCreateTerminalRequestKey] = useState<
    number | null
  >(null);
  const [createTerminalError, setCreateTerminalError] = useState<string | null>(
    null
  );

  const createTerminalQuery = useQuery(
    createTerminalTabQueryOptions({
      baseUrl: xtermBaseUrl,
      contextKey: taskRunId,
      triggerKey: createTerminalRequestKey,
      enabled: hasTerminalBackend && createTerminalRequestKey !== null,
    })
  );

  const isCreatingTerminal = createTerminalQuery.fetchStatus === "fetching";

  useEffect(() => {
    if (!createTerminalRequestKey) {
      return;
    }
    if (createTerminalQuery.status !== "success" || !createTerminalQuery.data) {
      return;
    }
    const payload = createTerminalQuery.data;
    setCreateTerminalError(null);
    setCreateTerminalRequestKey(null);
    setActiveTerminalId(payload.id);
    setConnectionStates((prev) => ({
      ...prev,
      [payload.id]: prev[payload.id] ?? "connecting",
    }));
    queryClient.setQueryData<TerminalTabId[] | undefined>(
      terminalTabsQueryKey(xtermBaseUrl, taskRunId),
      (current) => {
        if (!current) {
          return [payload.id];
        }
        if (current.includes(payload.id)) {
          return current;
        }
        return [...current, payload.id];
      }
    );
    queryClient.invalidateQueries({
      queryKey: terminalTabsQueryKey(xtermBaseUrl, taskRunId),
    });
  }, [
    createTerminalQuery.data,
    createTerminalQuery.status,
    createTerminalRequestKey,
    queryClient,
    taskRunId,
    xtermBaseUrl,
  ]);

  useEffect(() => {
    if (!createTerminalRequestKey) {
      return;
    }
    if (createTerminalQuery.status !== "error") {
      return;
    }
    const error = createTerminalQuery.error;
    setCreateTerminalRequestKey(null);
    setCreateTerminalError(
      error instanceof Error ? error.message : "Unable to create terminal."
    );
  }, [
    createTerminalQuery.error,
    createTerminalQuery.status,
    createTerminalRequestKey,
  ]);

  useEffect(() => {
    if (!hasTerminalBackend || terminalIds.length === 0) {
      setActiveTerminalId(null);
    } else {
      setActiveTerminalId((current) =>
        current && terminalIds.includes(current) ? current : terminalIds[0]
      );
    }
  }, [hasTerminalBackend, terminalIds]);

  useEffect(() => {
    if (!hasTerminalBackend) {
      setConnectionStates({});
      return;
    }
    setConnectionStates((prev) => {
      const next: Record<string, TerminalConnectionState> = {};
      for (const id of terminalIds) {
        next[id] = prev[id] ?? "connecting";
      }
      const sameSize = Object.keys(prev).length === Object.keys(next).length;
      if (sameSize) {
        let unchanged = true;
        for (const id of terminalIds) {
          if (prev[id] !== next[id]) {
            unchanged = false;
            break;
          }
        }
        if (unchanged) {
          return prev;
        }
      }
      return next;
    });
  }, [hasTerminalBackend, terminalIds]);

  const handleConnectionStateChange = useCallback(
    (terminalId: string, state: TerminalConnectionState) => {
      setConnectionStates((prev) => {
        if (prev[terminalId] === state) {
          return prev;
        }
        return {
          ...prev,
          [terminalId]: state,
        };
      });
    },
    []
  );

  const renderMessage = useCallback((message: string) => {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
        {message}
      </div>
    );
  }, []);

  const renderTerminalArea = () => {
    if (!isMorphProvider) {
      return renderMessage("Terminals are only available for Morph-based runs.");
    }

    if (!xtermBaseUrl) {
      return renderMessage("Waiting for Morph workspace to expose the terminal backend...");
    }

    return (
      <div className="flex flex-col grow min-h-0">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-100/70 px-3 dark:border-neutral-800 dark:bg-neutral-900/40">
          <div className="flex min-h-[40px] items-center gap-1 overflow-x-auto py-2">
            {terminalIds.length > 0 ? (
              terminalIds.map((id, index) => {
                const state = connectionStates[id] ?? "connecting";
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveTerminalId(id)}
                    className={clsx(
                      "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors", 
                      activeTerminalId === id
                        ? "bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900"
                        : "bg-transparent text-neutral-600 hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-100"
                    )}
                    title={id}
                  >
                    <span
                      className={clsx(
                        "h-2 w-2 rounded-full",
                        CONNECTION_STATE_COLORS[state]
                      )}
                    />
                    <span className="whitespace-nowrap">Terminal {index + 1}</span>
                  </button>
                );
              })
            ) : (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                No terminals detected yet.
              </span>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!hasTerminalBackend || isCreatingTerminal) {
                    return;
                  }
                  setCreateTerminalError(null);
                  setCreateTerminalRequestKey(Date.now());
                }}
                disabled={!hasTerminalBackend || isCreatingTerminal}
                className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100"
              >
                {isCreatingTerminal ? (
                  "Creating…"
                ) : (
                  <>
                    <Plus className="h-3.5 w-3.5" />
                    <span>New Terminal</span>
                  </>
                )}
              </button>
            </div>
            {createTerminalError ? (
              <span className="text-xs text-red-500 dark:text-red-400">
                {createTerminalError}
              </span>
            ) : null}
          </div>
        </div>
        <div className="relative flex-1 min-h-0 bg-neutral-950">
          {tabsQuery.isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-300">
              Loading terminals…
            </div>
          ) : tabsQuery.isError ? (
            renderMessage(
              tabsQuery.error instanceof Error
                ? tabsQuery.error.message
                : "Unable to load terminals."
            )
          ) : terminalIds.length === 0 ? (
            renderMessage("No terminal sessions are currently active.")
          ) : (
            terminalIds.map((id) => (
              <TaskRunTerminalSession
                key={id}
                baseUrl={xtermBaseUrl}
                terminalId={id}
                isActive={activeTerminalId === id}
                onConnectionStateChange={(state) =>
                  handleConnectionStateChange(id, state)
                }
              />
            ))
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col grow bg-neutral-50 dark:bg-black">
      <div className="flex flex-col grow min-h-0 border-l border-neutral-200 dark:border-neutral-800">
        {renderTerminalArea()}
      </div>
    </div>
  );
}
