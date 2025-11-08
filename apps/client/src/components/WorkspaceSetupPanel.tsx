import { parseEnvBlock } from "@/lib/parseEnvBlock";
import { ensureInitialEnvVars, type EnvVar } from "@/types/environment";
import { formatEnvVarsContent } from "@cmux/shared/utils/format-env-vars-content";
import {
  getApiWorkspaceConfigsOptions,
  postApiWorkspaceConfigsMutation,
} from "@cmux/www-openapi-client/react-query";
import { useMutation as useRQMutation, useQuery } from "@tanstack/react-query";
import TextareaAutosize from "react-textarea-autosize";
import { ChevronDown, ChevronRight, Minus, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import { toast } from "sonner";

type WorkspaceSetupPanelProps = {
  teamSlugOrId: string;
  projectFullName: string | null;
};

export function WorkspaceSetupPanel({
  teamSlugOrId,
  projectFullName,
}: WorkspaceSetupPanelProps) {
  const configQuery = useQuery({
    ...getApiWorkspaceConfigsOptions({
      query: {
        teamSlugOrId,
        projectFullName: projectFullName || "",
      },
    }),
    enabled: Boolean(projectFullName),
  });

  const saveMutation = useRQMutation(postApiWorkspaceConfigsMutation());

  const [maintenanceScript, setMaintenanceScript] = useState("");
  const [envVars, setEnvVars] = useState<EnvVar[]>(() =>
    ensureInitialEnvVars(),
  );

  const originalConfigRef = useRef<{ script: string; envContent: string }>({
    script: "",
    envContent: "",
  });

  const hasInitializedFromServerRef = useRef(false);

  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (!projectFullName) return;
    setMaintenanceScript("");
    setEnvVars(ensureInitialEnvVars());
    originalConfigRef.current = { script: "", envContent: "" };
    hasInitializedFromServerRef.current = false;
    setIsExpanded(true);
  }, [projectFullName]);

  useEffect(() => {
    if (configQuery.isPending) return;
    if (configQuery.error) return;
    if (configQuery.data === undefined) return;
    const data = configQuery.data;
    const nextScript = (data?.maintenanceScript ?? "").toString();
    const envContent = data?.envVarsContent ?? "";
    const parsedEnvVars =
      envContent.trim().length > 0
        ? parseEnvBlock(envContent).map((row) => ({
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          name: row.name,
          value: row.value,
          isSecret: true,
        }))
        : [];
    const normalizedEnvContent = formatEnvVarsContent(
      parsedEnvVars
        .filter(
          (row) => row.name.trim().length > 0 || row.value.trim().length > 0,
        )
        .map((row) => ({ name: row.name, value: row.value })),
    );

    setMaintenanceScript(nextScript);
    setEnvVars(ensureInitialEnvVars(parsedEnvVars));
    originalConfigRef.current = {
      script: nextScript.trim(),
      envContent: normalizedEnvContent,
    };

    if (!hasInitializedFromServerRef.current) {
      hasInitializedFromServerRef.current = true;
      const hasInitialContent =
        nextScript.trim().length > 0 || parsedEnvVars.length > 0;
      setIsExpanded(!hasInitialContent);
    }
  }, [configQuery.data, configQuery.isPending, configQuery.error]);

  const updateEnvVars = useCallback(
    (updater: (prev: EnvVar[]) => EnvVar[]) => {
      setEnvVars((prev) => {
        const updated = updater(prev);
        // Always ensure at least 1 row exists
        return updated.length === 0
          ? [
            {
              name: "",
              value: "",
              isSecret: true,
            },
          ]
          : updated;
      });
    },
    [],
  );

  const currentEnvContent = useMemo(() => {
    const filtered = envVars
      .filter(
        (row) => row.name.trim().length > 0 || row.value.trim().length > 0,
      )
      .map((row) => ({ name: row.name, value: row.value }));
    return formatEnvVarsContent(filtered);
  }, [envVars]);

  const normalizedScript = maintenanceScript.trim();
  const hasChanges =
    normalizedScript !== originalConfigRef.current.script ||
    currentEnvContent !== originalConfigRef.current.envContent;

  const handleSave = useCallback(() => {
    if (!projectFullName) return;

    const scriptToSave = normalizedScript.length
      ? normalizedScript
      : undefined;

    saveMutation.mutate(
      {
        body: {
          teamSlugOrId,
          projectFullName,
          maintenanceScript: scriptToSave,
          envVarsContent: currentEnvContent,
        },
      },
      {
        onSuccess: () => {
          originalConfigRef.current = {
            script: normalizedScript,
            envContent: currentEnvContent,
          };
          toast.success("Workspace setup saved");
        },
        onError: (error) => {
          console.error("[WorkspaceSetupPanel] Failed to save setup", error);
          toast.error("Failed to save workspace setup");
        },
      },
    );
  }, [
    currentEnvContent,
    normalizedScript,
    projectFullName,
    saveMutation,
    teamSlugOrId,
  ]);

  const handleEnvPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData?.getData("text") ?? "";
      if (!text || !/\n|=/.test(text)) {
        return;
      }
      event.preventDefault();
      const entries = parseEnvBlock(text);
      if (entries.length === 0) {
        return;
      }
      updateEnvVars((prev) => {
        const map = new Map(
          prev
            .filter(
              (row) =>
                row.name.trim().length > 0 || row.value.trim().length > 0,
            )
            .map((row) => [row.name, row] as const),
        );
        for (const entry of entries) {
          if (!entry.name) continue;
          map.set(entry.name, {
            name: entry.name,
            value: entry.value,
            isSecret: true,
          });
        }
        return Array.from(map.values());
      });
    },
    [updateEnvVars],
  );

  if (configQuery.error) {
    throw configQuery.error;
  }

  if (!projectFullName) {
    return null;
  }

  return (
    <div className="mt-4 rounded-xl border border-blue-200/50 bg-blue-50/60 px-4 py-4 text-sm text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-100">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="inline-flex items-center gap-2 text-sm font-medium text-blue-900 hover:text-blue-700 dark:text-blue-100 dark:hover:text-blue-200 transition-colors"
        >
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <span>
            Configure workspace for{" "}
            <span className="font-semibold">{projectFullName}</span>
          </span>
        </button>
      </div>

      {isExpanded && (
        <>
          <p className="mt-2 text-xs text-blue-900/80 dark:text-blue-200/80">
            Set up scripts and environment variables for{" "}
            <span className="font-semibold">{projectFullName}</span>. This
            configuration will be used for both local and cloud workspaces.
          </p>

          {configQuery.isPending ? (
            <p className="mt-4 text-xs text-neutral-500 dark:text-neutral-400">
              Loading saved configuration…
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              {/* Split Screen Container */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Left: Setup Script Section */}
                <div className="flex flex-col">
                  <div className="rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950 flex flex-col h-full">
                    <div className="px-3 py-3 border-b border-neutral-200 dark:border-neutral-800">
                      <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          Setup script
                        </p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          Runs after cloning your repository so dependencies and
                          services are ready.
                        </p>
                      </div>
                    </div>

                    <div className="flex-1 px-3 py-3">
                      <TextareaAutosize
                        value={maintenanceScript}
                        onChange={(e) => setMaintenanceScript(e.target.value)}
                        placeholder={`# e.g.\npnpm install\nbundle install\nuv sync`}
                        minRows={4}
                        maxRows={18}
                        className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-sm font-mono text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 resize-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:ring-neutral-700"
                      />
                      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                        Executed from your workspace root directory
                      </p>
                    </div>
                  </div>
                </div>

                {/* Right: Environment Variables Section */}
                <div className="flex flex-col">
                  <div
                    className="rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950 flex flex-col h-full"
                    onPasteCapture={handleEnvPaste}
                  >
                    <div className="px-3 py-3 border-b border-neutral-200 dark:border-neutral-800">
                      <div className="flex flex-col gap-1">
                        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          Environment variables
                        </p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          Stored securely and injected when your setup script runs.
                          Paste directly from .env files.
                        </p>
                      </div>
                    </div>

                    {/* Scrollable Env Vars Grid */}
                    <div
                      className="flex-1 overflow-y-auto px-3 py-3"
                      style={{ maxHeight: "400px" }}
                    >
                      <div
                        className="grid gap-3 text-xs font-medium text-neutral-600 dark:text-neutral-400 items-center mb-3"
                        style={{ gridTemplateColumns: "1fr 1fr 36px" }}
                      >
                        <span>Key</span>
                        <span>Value</span>
                        <span />
                      </div>

                      <div className="space-y-2.5">
                        {envVars.map((row, idx) => (
                          <div
                            key={`${row}-${idx}`}
                            className="grid gap-3 items-center"
                            style={{
                              gridTemplateColumns: "1fr 1fr 36px",
                            }}
                          >
                            <input
                              type="text"
                              value={row.name}
                              onChange={(event) => {
                                const value = event.target.value;
                                updateEnvVars((prev) => {
                                  const next = [...prev];
                                  next[idx] = { ...next[idx]!, name: value };
                                  return next;
                                });
                              }}
                              placeholder="EXAMPLE_KEY"
                              className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-sm font-mono text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:ring-neutral-700"
                            />
                            <TextareaAutosize
                              value={row.value}
                              onChange={(event) => {
                                const value = event.target.value;
                                updateEnvVars((prev) => {
                                  const next = [...prev];
                                  next[idx] = { ...next[idx]!, value };
                                  return next;
                                });
                              }}
                              minRows={1}
                              maxRows={6}
                              placeholder="secret-value"
                              className="w-full rounded-md border border-neutral-200 bg-white px-2.5 py-2 text-sm font-mono text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 resize-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:ring-neutral-700"
                            />
                            <button
                              type="button"
                              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-700 hover:border-neutral-300 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-300 dark:hover:border-neutral-700"
                              onClick={() =>
                                updateEnvVars((prev) =>
                                  prev.filter((_, i) => i !== idx),
                                )
                              }
                              aria-label="Remove variable"
                            >
                              <Minus className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="mt-4 pt-2 border-t border-neutral-100 dark:border-neutral-800/50">
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-50 hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:hover:border-neutral-700"
                          onClick={() =>
                            updateEnvVars((prev) => [
                              ...prev,
                              {
                                id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                                name: "",
                                value: "",
                                isSecret: true,
                              },
                            ])
                          }
                        >
                          <Plus className="h-4 w-4" />
                          Add variable
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Save Button - Full Width at Bottom */}
              <div className="flex items-center justify-end gap-3">
                {!hasChanges && !saveMutation.isPending ? (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    All changes saved
                  </span>
                ) : null}
                <button
                  type="button"
                  className="inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-60"
                  disabled={!hasChanges || saveMutation.isPending}
                  onClick={handleSave}
                >
                  {saveMutation.isPending ? "Saving…" : "Save setup"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
