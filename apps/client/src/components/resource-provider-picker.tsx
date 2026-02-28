import { useQuery } from "@tanstack/react-query";
import { getApiResourceProvidersOptions } from "@cmux/www-openapi-client/react-query";
import { Monitor } from "lucide-react";

interface ResourceProviderPickerProps {
  teamSlugOrId: string;
  value: string | undefined;
  onChange: (providerId: string | undefined) => void;
}

export function ResourceProviderPicker({
  teamSlugOrId,
  value,
  onChange,
}: ResourceProviderPickerProps) {
  const providersQuery = useQuery({
    ...getApiResourceProvidersOptions({ query: { teamSlugOrId } }),
    enabled: Boolean(teamSlugOrId),
  });

  const providers = providersQuery.data?.providers ?? [];
  const onlineProviders = providers.filter((p) => p.status === "online");

  if (providers.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Monitor className="w-4 h-4 text-neutral-500 dark:text-neutral-400" />
        <label className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
          iOS Resource Provider
        </label>
      </div>

      {onlineProviders.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          No Mac providers online. Register one in Settings.
        </p>
      ) : (
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">None (no iOS tools)</option>
          {onlineProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.xcodeVersion ? ` (Xcode ${p.xcodeVersion})` : ""}
              {" — "}
              {p.activeAllocations}/{p.maxConcurrentBuilds ?? 2} builds
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
