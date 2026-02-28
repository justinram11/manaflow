import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getApiResourceProvidersOptions } from "@cmux/www-openapi-client/react-query";
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Trash2, Plus, Copy, Monitor } from "lucide-react";

interface ResourceProviderSettingsProps {
  teamSlugOrId: string;
}

export function ResourceProviderSettings({
  teamSlugOrId,
}: ResourceProviderSettingsProps) {
  const queryClient = useQueryClient();
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [newProviderName, setNewProviderName] = useState("");
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editMaxBuilds, setEditMaxBuilds] = useState(2);

  const providersQuery = useQuery({
    ...getApiResourceProvidersOptions({ query: { teamSlugOrId } }),
    enabled: Boolean(teamSlugOrId),
    refetchInterval: 10000, // Poll every 10s for status updates
  });

  const registerMutation = useMutation({
    mutationFn: async (name: string) => {
      const { postApiResourceProviders } = await import(
        "@cmux/www-openapi-client"
      );
      return await postApiResourceProviders({
        body: {
          teamSlugOrId,
          name,
          platform: "macos",
          arch: "arm64",
        },
      });
    },
    onSuccess: (data) => {
      if (data.data) {
        setGeneratedToken(data.data.token);
      }
      queryClient.invalidateQueries({
        queryKey: getApiResourceProvidersOptions({ query: { teamSlugOrId } })
          .queryKey,
      });
    },
    onError: (error) => {
      toast.error("Failed to register provider");
      console.error("Register error:", error);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { deleteApiResourceProvidersById } = await import(
        "@cmux/www-openapi-client"
      );
      return await deleteApiResourceProvidersById({ path: { id } });
    },
    onSuccess: () => {
      toast.success("Provider removed");
      queryClient.invalidateQueries({
        queryKey: getApiResourceProvidersOptions({ query: { teamSlugOrId } })
          .queryKey,
      });
    },
    onError: (error) => {
      toast.error("Failed to remove provider");
      console.error("Delete error:", error);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      maxConcurrentBuilds,
    }: {
      id: string;
      name?: string;
      maxConcurrentBuilds?: number;
    }) => {
      const { patchApiResourceProvidersById } = await import(
        "@cmux/www-openapi-client"
      );
      return await patchApiResourceProvidersById({
        path: { id },
        body: { name, maxConcurrentBuilds },
      });
    },
    onSuccess: () => {
      toast.success("Provider updated");
      setEditingId(null);
      queryClient.invalidateQueries({
        queryKey: getApiResourceProvidersOptions({ query: { teamSlugOrId } })
          .queryKey,
      });
    },
    onError: (error) => {
      toast.error("Failed to update provider");
      console.error("Update error:", error);
    },
  });

  const handleRegister = useCallback(() => {
    if (!newProviderName.trim()) {
      toast.error("Name is required");
      return;
    }
    registerMutation.mutate(newProviderName.trim());
  }, [newProviderName, registerMutation]);

  const handleCopyToken = useCallback(() => {
    if (generatedToken) {
      navigator.clipboard.writeText(generatedToken);
      toast.success("Token copied to clipboard");
    }
  }, [generatedToken]);

  const handleCopySetupCommand = useCallback(() => {
    if (generatedToken) {
      const serverUrl = window.location.origin;
      const cmd = `curl -fsSL ${serverUrl}/api/resource-providers/setup | bash -s -- --token ${generatedToken} --server ${serverUrl}`;
      navigator.clipboard.writeText(cmd);
      toast.success("Setup command copied to clipboard");
    }
  }, [generatedToken]);

  const providers = providersQuery.data?.providers ?? [];

  return (
    <div className="bg-white dark:bg-neutral-950 rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Resource Providers
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            Register Mac machines for iOS builds and simulator access in
            workspaces.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowRegisterDialog(true);
            setGeneratedToken(null);
            setNewProviderName("");
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90"
        >
          <Plus className="w-3.5 h-3.5" />
          Register Mac
        </button>
      </div>

      <div className="p-4">
        {providersQuery.isLoading ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Loading...
          </p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            No resource providers registered. Register a Mac to enable iOS
            development in workspaces.
          </p>
        ) : (
          <div className="space-y-3">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between p-3 rounded-lg border border-neutral-200 dark:border-neutral-800"
              >
                <div className="flex items-center gap-3">
                  <Monitor className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
                  <div>
                    {editingId === provider.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
                        />
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={editMaxBuilds}
                          onChange={(e) =>
                            setEditMaxBuilds(parseInt(e.target.value, 10))
                          }
                          className="px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 w-16"
                          title="Max concurrent builds"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            updateMutation.mutate({
                              id: provider.id,
                              name: editName,
                              maxConcurrentBuilds: editMaxBuilds,
                            })
                          }
                          className="px-2 py-1 text-xs rounded bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full ${provider.status === "online" ? "bg-green-500" : "bg-neutral-400"}`}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(provider.id);
                              setEditName(provider.name);
                              setEditMaxBuilds(
                                provider.maxConcurrentBuilds ?? 2,
                              );
                            }}
                            className="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:underline"
                          >
                            {provider.name}
                          </button>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                          <span>{provider.platform}</span>
                          {provider.xcodeVersion && (
                            <span>Xcode {provider.xcodeVersion}</span>
                          )}
                          <span>
                            {provider.activeAllocations}/
                            {provider.maxConcurrentBuilds ?? 2} builds
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
                {editingId !== provider.id && (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          `Remove ${provider.name}? This will disconnect it from all workspaces.`,
                        )
                      ) {
                        deleteMutation.mutate(provider.id);
                      }
                    }}
                    className="p-1.5 text-neutral-400 hover:text-red-500 dark:text-neutral-500 dark:hover:text-red-400"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Register Dialog */}
        {showRegisterDialog && (
          <div className="mt-4 p-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
            {generatedToken ? (
              <div className="space-y-3">
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Mac registered! Run this command on your Mac:
                </p>
                <div className="relative">
                  <pre className="p-3 rounded-md bg-neutral-900 dark:bg-neutral-950 text-green-400 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                    {`curl -fsSL ${window.location.origin}/api/resource-providers/setup | bash -s -- --token ${generatedToken} --server ${window.location.origin}`}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopySetupCommand}
                    className="absolute top-2 right-2 p-1.5 rounded bg-neutral-700 hover:bg-neutral-600 text-neutral-300"
                    title="Copy setup command"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  This token is shown only once. The setup script will install
                  the daemon as a launchd service.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyToken}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                  >
                    <Copy className="w-3 h-3" />
                    Copy token only
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRegisterDialog(false)}
                    className="px-3 py-1.5 text-xs rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Register a new Mac
                </p>
                <div>
                  <label
                    htmlFor="provider-name"
                    className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1"
                  >
                    Name
                  </label>
                  <input
                    id="provider-name"
                    type="text"
                    value={newProviderName}
                    onChange={(e) => setNewProviderName(e.target.value)}
                    placeholder="e.g. Mac Studio"
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRegister();
                    }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleRegister}
                    disabled={registerMutation.isPending}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 disabled:opacity-50"
                  >
                    {registerMutation.isPending
                      ? "Registering..."
                      : "Register"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRegisterDialog(false)}
                    className="px-3 py-1.5 text-xs rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
