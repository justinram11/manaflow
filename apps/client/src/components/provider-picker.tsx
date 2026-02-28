import { useQuery } from "@tanstack/react-query";

interface Provider {
  id: string;
  name: string;
  status: string;
  capabilities: string[] | null;
  maxConcurrentSlots: number | null;
  metadata: Record<string, string> | null;
  activeAllocations: number;
}

const API_BASE = "/api";

export function ProviderPicker({
  teamSlugOrId,
  value,
  onChange,
  capability,
}: {
  teamSlugOrId: string;
  value: string | null;
  onChange: (providerId: string | null) => void;
  capability?: string;
}) {
  const { data } = useQuery({
    queryKey: ["providers", teamSlugOrId, capability],
    queryFn: async () => {
      const params = new URLSearchParams({ teamSlugOrId });
      if (capability) params.set("capability", capability);
      const res = await fetch(`${API_BASE}/providers?${params}`);
      if (!res.ok) throw new Error("Failed to fetch providers");
      return res.json() as Promise<{ providers: Provider[] }>;
    },
    enabled: Boolean(teamSlugOrId),
  });

  const providers = data?.providers ?? [];
  const onlineProviders = providers.filter((p) => p.status === "online");

  if (providers.length === 0) return null;

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm"
    >
      <option value="">None</option>
      {onlineProviders.length === 0 ? (
        <option disabled>No online providers — check Settings</option>
      ) : (
        onlineProviders.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.capabilities?.length ? ` (${p.capabilities.join(", ")})` : ""}
            {` — ${p.activeAllocations}/${p.maxConcurrentSlots ?? 4} slots`}
          </option>
        ))
      )}
    </select>
  );
}
