import clsx from "clsx";

type FirecrackerVmSize = "standard" | "performance";

const VM_SIZE_OPTIONS: Array<{
  value: FirecrackerVmSize;
  label: string;
  description: string;
}> = [
  {
    value: "standard",
    label: "Standard",
    description: "2 vCPU, 4 GB RAM",
  },
  {
    value: "performance",
    label: "Performance",
    description: "4 vCPU, 16 GB RAM",
  },
];

interface FirecrackerVmSizeSelectProps {
  value: FirecrackerVmSize;
  onChange: (value: FirecrackerVmSize) => void;
  disabled?: boolean;
  className?: string;
}

export function FirecrackerVmSizeSelect({
  value,
  onChange,
  disabled,
  className,
}: FirecrackerVmSizeSelectProps) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
        VM Size
      </label>
      <div className="flex gap-2">
        {VM_SIZE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={clsx(
              "flex-1 rounded-md border px-3 py-2 text-left transition-colors",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              value === option.value
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-400"
                : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600",
            )}
          >
            <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {option.label}
            </div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400">
              {option.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
