import type { SandboxProvider } from "@/types/environment";
import { Accordion, AccordionItem } from "@heroui/react";
import { Check } from "lucide-react";
import { Label, Radio, RadioGroup } from "react-aria-components";

export interface RepositoryAdvancedOptionsProps {
  selectedProvider?: SandboxProvider;
  onProviderChange?: (provider: SandboxProvider) => void;
}

export function RepositoryAdvancedOptions({
  selectedProvider = "firecracker",
  onProviderChange,
}: RepositoryAdvancedOptionsProps) {
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-hidden">
      <Accordion
        selectionMode="multiple"
        className="px-0"
        itemClasses={{
          trigger:
            "text-sm cursor-pointer py-2 px-3 transition-colors data-[hovered=true]:bg-neutral-50 dark:data-[hovered=true]:bg-neutral-900 rounded-none",
          content:
            "pt-0 px-3 pb-3 border-t border-neutral-200 dark:border-neutral-800",
          title: "text-sm font-medium",
        }}
      >
        <AccordionItem
          key="advanced-options"
          aria-label="Advanced options"
          title="Advanced options"
        >
          <div className="space-y-4 pt-1.5">
            {onProviderChange && (
              <RadioGroup
                value={selectedProvider}
                onChange={(value) => onProviderChange(value as SandboxProvider)}
                className="space-y-4"
              >
                <Label className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  Sandbox Provider
                </Label>
                <div className="grid gap-3 sm:grid-cols-2 pt-1.5">
                  <Radio
                    value="firecracker"
                    className={({ isSelected, isFocusVisible }) => {
                      const baseClasses =
                        "relative flex h-full cursor-pointer flex-col justify-between rounded-lg border px-4 py-3 text-left transition-colors focus:outline-none";
                      const stateClasses = [
                        isSelected
                          ? "border-neutral-900 dark:border-neutral-100 bg-neutral-50 dark:bg-neutral-900"
                          : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 hover:border-neutral-300 dark:hover:border-neutral-700",
                        isFocusVisible
                          ? "outline-2 outline-offset-2 outline-neutral-500"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return `${baseClasses} ${stateClasses}`.trim();
                    }}
                  >
                    {({ isSelected }) => (
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                            Firecracker (Local)
                          </p>
                          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                            Self-hosted microVM with sub-second resume
                          </p>
                        </div>
                        <span
                          className={`mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                            isSelected
                              ? "border-neutral-900 dark:border-neutral-100 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                              : "border-neutral-300 dark:border-neutral-700 bg-white text-transparent dark:bg-neutral-950"
                          }`}
                        >
                          <Check className="h-3 w-3" aria-hidden="true" />
                        </span>
                      </div>
                    )}
                  </Radio>
                </div>
              </RadioGroup>
            )}
          </div>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
