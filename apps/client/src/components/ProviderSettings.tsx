import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";
import { toast } from "sonner";
import { Trash2, Plus, Copy, Server } from "lucide-react";
import { WWW_ORIGIN } from "@/lib/wwwOrigin";
import { fetchWithAuth } from "@/lib/stack";

interface Provider {
  id: string;
  name: string;
  platform: string;
  arch: string;
  status: string;
  capabilities: string[] | null;
  maxConcurrentSlots: number | null;
  metadata: Record<string, string> | null;
  activeAllocations: number;
}

interface ProviderSettingsProps {
  teamSlugOrId: string;
}

const API_BASE = `${WWW_ORIGIN}/api`;

/** Fetch wrapper that adds auth headers */
function authFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetchWithAuth(new Request(url, init));
}

export function ProviderSettings({ teamSlugOrId }: ProviderSettingsProps) {
  const queryClient = useQueryClient();
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [newProviderName, setNewProviderName] = useState("");
  const [newProviderPlatform, setNewProviderPlatform] = useState<"linux" | "macos">("linux");
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editMaxSlots, setEditMaxSlots] = useState(4);

  const queryKey = ["providers", teamSlugOrId];

  const providersQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await authFetch(
        `${API_BASE}/providers?teamSlugOrId=${encodeURIComponent(teamSlugOrId)}`,
      );
      if (!res.ok) throw new Error("Failed to fetch providers");
      return res.json() as Promise<{ providers: Provider[] }>;
    },
    enabled: Boolean(teamSlugOrId),
    refetchInterval: 10000,
  });

  const registerMutation = useMutation({
    mutationFn: async (opts: { name: string; platform: string }) => {
      const res = await authFetch(`${API_BASE}/providers/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamSlugOrId,
          name: opts.name,
          platform: opts.platform,
          arch: "arm64",
        }),
      });
      if (!res.ok) throw new Error("Failed to register provider");
      return res.json() as Promise<{ id: string; token: string }>;
    },
    onSuccess: (data) => {
      setGeneratedToken(data.token);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      toast.error("Failed to register provider");
      console.error("Register error:", error);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await authFetch(`${API_BASE}/providers/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete provider");
    },
    onSuccess: () => {
      toast.success("Provider removed");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      toast.error("Failed to remove provider");
      console.error("Delete error:", error);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (opts: {
      id: string;
      name?: string;
      maxConcurrentSlots?: number;
    }) => {
      const res = await authFetch(`${API_BASE}/providers/${opts.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.name,
          maxConcurrentSlots: opts.maxConcurrentSlots,
        }),
      });
      if (!res.ok) throw new Error("Failed to update provider");
    },
    onSuccess: () => {
      toast.success("Provider updated");
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey });
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
    registerMutation.mutate({
      name: newProviderName.trim(),
      platform: newProviderPlatform,
    });
  }, [newProviderName, newProviderPlatform, registerMutation]);

  const handleCopyToken = useCallback(() => {
    if (generatedToken) {
      navigator.clipboard.writeText(generatedToken);
      toast.success("Token copied to clipboard");
    }
  }, [generatedToken]);

  const handleCopySetupCommand = useCallback(() => {
    if (generatedToken) {
      const serverUrl = window.location.origin;
      const cmd = `curl -fsSL ${serverUrl}/api/providers/setup | bash -s -- --token ${generatedToken} --server ${serverUrl}`;
      navigator.clipboard.writeText(cmd);
      toast.success("Setup command copied to clipboard");
    }
  }, [generatedToken]);

  const providers = providersQuery.data?.providers ?? [];

  const capabilityBadge = (cap: string) => {
    const colors: Record<string, string> = {
      "compute:incus": "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      "resource:ios-simulator": "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
    };
    return (
      <span
        key={cap}
        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[cap] ?? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"}`}
      >
        {cap}
      </span>
    );
  };

  return (
    <div className="bg-white dark:bg-neutral-950 rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Providers
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            Register machines to run workspaces and iOS builds. Capabilities are
            auto-detected.
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
          Register Provider
        </button>
      </div>

      <div className="p-4">
        {providersQuery.isLoading ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Loading...
          </p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            No providers registered. Register a machine to run sandboxed
            workspaces.
          </p>
        ) : (
          <div className="space-y-3">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between p-3 rounded-lg border border-neutral-200 dark:border-neutral-800"
              >
                <div className="flex items-center gap-3">
                  <Server className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
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
                          value={editMaxSlots}
                          onChange={(e) =>
                            setEditMaxSlots(parseInt(e.target.value, 10))
                          }
                          className="px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-700 rounded bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 w-16"
                          title="Max concurrent slots"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            updateMutation.mutate({
                              id: provider.id,
                              name: editName,
                              maxConcurrentSlots: editMaxSlots,
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
                              setEditMaxSlots(
                                provider.maxConcurrentSlots ?? 4,
                              );
                            }}
                            className="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:underline"
                          >
                            {provider.name}
                          </button>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          {provider.capabilities?.map((cap) =>
                            capabilityBadge(cap),
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                          <span>{provider.platform}/{provider.arch}</span>
                          {provider.metadata?.xcodeVersion && (
                            <span>
                              Xcode {provider.metadata.xcodeVersion}
                            </span>
                          )}
                          <span>
                            {provider.activeAllocations}/
                            {provider.maxConcurrentSlots ?? 4} slots
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
                  Provider registered! Run this command on your machine:
                </p>
                <div className="relative">
                  <pre className="p-3 rounded-md bg-neutral-900 dark:bg-neutral-950 text-green-400 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                    {`curl -fsSL ${window.location.origin}/api/providers/setup | bash -s -- --token ${generatedToken} --server ${window.location.origin}`}
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
                  the provider daemon as a systemd/launchd service.
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
                  Register a new provider
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
                    placeholder="e.g. Build Server 1"
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRegister();
                    }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    Platform
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setNewProviderPlatform("linux")}
                      className={`px-3 py-1.5 text-xs rounded-md border ${
                        newProviderPlatform === "linux"
                          ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                      }`}
                    >
                      Linux
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewProviderPlatform("macos")}
                      className={`px-3 py-1.5 text-xs rounded-md border ${
                        newProviderPlatform === "macos"
                          ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                      }`}
                    >
                      macOS
                    </button>
                  </div>
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
