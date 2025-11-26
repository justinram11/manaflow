"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  Loader2,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Minus,
  Plus,
  Check,
  Copy,
  Github,
} from "lucide-react";
import Link from "next/link";
import { formatEnvVarsContent } from "@cmux/shared/utils/format-env-vars-content";
import clsx from "clsx";

const MASKED_ENV_VALUE = "••••••••••••••••";

type SandboxInstance = {
  instanceId: string;
  vscodeUrl: string;
  workerUrl: string;
  vncUrl?: string;
  provider: string;
};

type PreviewConfigureClientProps = {
  teamSlugOrId: string;
  repo: string;
  installationId: string | null;
};

type EnvVar = { name: string; value: string; isSecret: boolean };

type WizardStep = 1 | 2;

function normalizeVncUrl(url: string): string | null {
  try {
    const target = new URL(url);
    target.searchParams.set("autoconnect", "1");
    target.searchParams.set("resize", "scale");
    return target.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}autoconnect=1&resize=scale`;
  }
}

function resolveMorphHostId(
  instanceId?: string,
  workspaceUrl?: string
): string | null {
  if (instanceId && instanceId.trim().length > 0) {
    return instanceId.trim().toLowerCase().replace(/_/g, "-");
  }

  if (!workspaceUrl) {
    return null;
  }

  try {
    const url = new URL(workspaceUrl);
    const directMatch = url.hostname.match(
      /^port-\d+-(morphvm-[^.]+)\.http\.cloud\.morph\.so$/i
    );
    if (directMatch && directMatch[1]) {
      return directMatch[1].toLowerCase();
    }

    const proxyMatch = url.hostname.match(
      /^cmux-([^-]+)-[a-z0-9-]+-\d+\.cmux\.(?:app|dev|sh|local|localhost)$/i
    );
    if (proxyMatch && proxyMatch[1]) {
      return `morphvm-${proxyMatch[1].toLowerCase()}`;
    }
  } catch {
    return null;
  }

  return null;
}

function deriveVncUrl(
  instanceId?: string,
  workspaceUrl?: string
): string | null {
  const morphHostId = resolveMorphHostId(instanceId, workspaceUrl);
  if (!morphHostId) {
    return null;
  }

  const hostname = `port-39380-${morphHostId}.http.cloud.morph.so`;
  const baseUrl = `https://${hostname}/vnc.html`;
  return normalizeVncUrl(baseUrl);
}

const ensureInitialEnvVars = (initial?: EnvVar[]): EnvVar[] => {
  const base = (initial ?? []).map((item) => ({
    name: item.name,
    value: item.value,
    isSecret: item.isSecret ?? true,
  }));
  if (base.length === 0) {
    return [{ name: "", value: "", isSecret: true }];
  }
  const last = base[base.length - 1];
  if (!last || last.name.trim().length > 0 || last.value.trim().length > 0) {
    base.push({ name: "", value: "", isSecret: true });
  }
  return base;
};

function parseEnvBlock(text: string): Array<{ name: string; value: string }> {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const results: Array<{ name: string; value: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    const cleanLine = trimmed.replace(/^export\s+/, "").replace(/^set\s+/, "");
    const eqIdx = cleanLine.indexOf("=");

    if (eqIdx === -1) continue;

    const key = cleanLine.slice(0, eqIdx).trim();
    let value = cleanLine.slice(eqIdx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && !/\s/.test(key)) {
      results.push({ name: key, value });
    }
  }

  return results;
}


// Persistent iframe manager for Next.js
type PersistentIframeOptions = {
  allow?: string;
  sandbox?: string;
};

type MountOptions = {
  backgroundColor?: string;
};

class SimplePersistentIframeManager {
  private iframes = new Map<
    string,
    { iframe: HTMLIFrameElement; wrapper: HTMLDivElement; allow?: string; sandbox?: string }
  >();
  private container: HTMLDivElement | null = null;

  constructor() {
    if (typeof document !== "undefined") {
      this.initContainer();
    }
  }

  private initContainer() {
    this.container = document.createElement("div");
    this.container.id = "persistent-iframe-container";
    this.container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      pointer-events: none;
      z-index: 9999;
    `;
    document.body.appendChild(this.container);
  }

  setVisibility(key: string, visible: boolean) {
    const entry = this.iframes.get(key);
    if (!entry) {
      return;
    }
    entry.wrapper.style.visibility = visible ? "visible" : "hidden";
    entry.wrapper.style.pointerEvents = visible ? "auto" : "none";
  }

  getOrCreateIframe(
    key: string,
    url: string,
    options?: PersistentIframeOptions
  ): HTMLIFrameElement {
    const existing = this.iframes.get(key);
    if (existing) {
      if (options?.allow && existing.allow !== options.allow) {
        existing.iframe.allow = options.allow;
        existing.allow = options.allow;
      }
      if (options?.sandbox && existing.sandbox !== options.sandbox) {
        existing.iframe.setAttribute("sandbox", options.sandbox);
        existing.sandbox = options.sandbox;
      }
      if (existing.iframe.src !== url) {
        existing.iframe.src = url;
      }
      return existing.iframe;
    }

    const wrapper = document.createElement("div");
    wrapper.style.cssText = `
      position: fixed;
      visibility: hidden;
      pointer-events: none;
      transform: translate(-100vw, -100vh);
      width: 0;
      height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
    `;
    wrapper.setAttribute("data-iframe-key", key);

    const iframe = document.createElement("iframe");
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: transparent;
    `;
    iframe.style.transform = "none";
    iframe.src = url;
    if (options?.allow) {
      iframe.allow = options.allow;
    } else {
      iframe.allow = "clipboard-read; clipboard-write; cross-origin-isolated; fullscreen";
    }
    if (options?.sandbox) {
      iframe.setAttribute("sandbox", options.sandbox);
    } else {
      iframe.setAttribute(
        "sandbox",
        "allow-same-origin allow-scripts allow-forms allow-downloads allow-modals allow-popups"
      );
    }

    wrapper.appendChild(iframe);
    this.container?.appendChild(wrapper);
    this.iframes.set(key, {
      iframe,
      wrapper,
      allow: options?.allow,
      sandbox: options?.sandbox,
    });

    return iframe;
  }

  mountIframe(
    key: string,
    targetElement: HTMLElement,
    options?: MountOptions
  ): () => void {
    const entry = this.iframes.get(key);
    if (!entry) return () => {};

    entry.wrapper.style.background = options?.backgroundColor ?? "transparent";

    const syncPosition = () => {
      const rect = targetElement.getBoundingClientRect();
      entry.wrapper.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      entry.wrapper.style.width = `${rect.width}px`;
      entry.wrapper.style.height = `${rect.height}px`;
    };

    entry.wrapper.style.visibility = "visible";
    entry.wrapper.style.pointerEvents = "auto";
    entry.iframe.style.transform = "none";
    syncPosition();

    const observer = new ResizeObserver(syncPosition);
    observer.observe(targetElement);
    window.addEventListener("resize", syncPosition);
    window.addEventListener("scroll", syncPosition, true);

    return () => {
      entry.wrapper.style.visibility = "hidden";
      entry.wrapper.style.pointerEvents = "none";
      observer.disconnect();
      window.removeEventListener("resize", syncPosition);
      window.removeEventListener("scroll", syncPosition, true);
    };
  }
}

const iframeManager = typeof window !== "undefined" ? new SimplePersistentIframeManager() : null;

const STEPS = [
  {
    id: 1 as const,
    numeral: "I",
    title: "Environment & Scripts",
    description: "Configure environment and run your dev server",
  },
  {
    id: 2 as const,
    numeral: "II",
    title: "Browser Setup",
    description: "Prepare browser for automation",
  },
];

function StepIndicator({ currentStep }: { currentStep: WizardStep }) {
  return (
    <div className="flex items-center gap-3 mb-6">
      {STEPS.map((step, index) => {
        const isActive = step.id === currentStep;
        const isCompleted = step.id < currentStep;

        return (
          <div key={step.id} className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div
                className={clsx(
                  "flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors",
                  isActive
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : isCompleted
                      ? "bg-green-500 text-white dark:bg-green-500"
                      : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                )}
              >
                {isCompleted ? <Check className="h-3.5 w-3.5" /> : step.numeral}
              </div>
              <div className="hidden sm:block">
                <div
                  className={clsx(
                    "text-sm font-medium",
                    isActive
                      ? "text-neutral-900 dark:text-neutral-100"
                      : "text-neutral-500 dark:text-neutral-400"
                  )}
                >
                  {step.title}
                </div>
              </div>
            </div>
            {index < STEPS.length - 1 && (
              <div
                className={clsx(
                  "h-px w-8 transition-colors",
                  isCompleted
                    ? "bg-green-500"
                    : "bg-neutral-200 dark:bg-neutral-800"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function PreviewConfigureClient({
  teamSlugOrId,
  repo,
  installationId: _installationId,
}: PreviewConfigureClientProps) {
  const [instance, setInstance] = useState<SandboxInstance | null>(null);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [currentStep, setCurrentStep] = useState<WizardStep>(1);

  const [envVars, setEnvVars] = useState<EnvVar[]>(() => ensureInitialEnvVars());
  const [maintenanceScript, setMaintenanceScript] = useState("");
  const [devScript, setDevScript] = useState("");

  const [areEnvValuesHidden, setAreEnvValuesHidden] = useState(true);
  const [activeEnvValueIndex, setActiveEnvValueIndex] = useState<number | null>(null);
  const [pendingFocusIndex, setPendingFocusIndex] = useState<number | null>(null);

  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, []);

  const persistentIframeManager = useMemo(() => iframeManager, []);

  const keyInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const lastSubmittedEnvContent = useRef<string | null>(null);

  const vscodePersistKey = instance?.instanceId ? `preview-${instance.instanceId}:vscode` : "vscode";
  const browserPersistKey = instance?.instanceId ? `preview-${instance.instanceId}:browser` : "browser";

  const resolvedVncUrl = useMemo(() => {
    if (instance?.vncUrl) {
      return normalizeVncUrl(instance.vncUrl) ?? instance.vncUrl;
    }
    return deriveVncUrl(instance?.instanceId, instance?.vscodeUrl);
  }, [instance?.instanceId, instance?.vncUrl, instance?.vscodeUrl]);

  const workspacePlaceholder = useMemo(
    () =>
      instance?.vscodeUrl
        ? null
        : {
            title: instance?.instanceId
              ? "Waiting for VS Code"
              : "VS Code workspace not ready",
            description: instance?.instanceId
              ? "The editor opens automatically once the environment finishes booting."
              : "Provisioning the workspace. We'll open VS Code as soon as it's ready.",
          },
    [instance?.instanceId, instance?.vscodeUrl]
  );

  const browserPlaceholder = useMemo(
    () =>
      resolvedVncUrl
        ? null
        : {
            title: instance?.instanceId
              ? "Waiting for browser"
              : "Browser preview unavailable",
            description: instance?.instanceId
              ? "We'll embed the browser session as soon as the environment exposes it."
              : "Launch the workspace so the browser agent can stream the preview here.",
          },
    [instance?.instanceId, resolvedVncUrl]
  );

  const provisionVM = useCallback(async () => {
    setIsProvisioning(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/sandboxes/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamSlugOrId,
          repoUrl: `https://github.com/${repo}`,
          branch: "main",
          ttlSeconds: 3600,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = (await response.json()) as SandboxInstance;
      const normalizedFromResponse =
        data.vncUrl && data.vncUrl.trim().length > 0
          ? normalizeVncUrl(data.vncUrl) ?? data.vncUrl
          : null;
      const derived = normalizedFromResponse ?? deriveVncUrl(data.instanceId, data.vscodeUrl);

      setInstance({
        ...data,
        vncUrl: derived ?? undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to provision workspace";
      setErrorMessage(message);
      console.error("Failed to provision workspace:", error);
    } finally {
      setIsProvisioning(false);
    }
  }, [repo, teamSlugOrId]);

  useEffect(() => {
    if (!instance && !isProvisioning && !errorMessage) {
      void provisionVM();
    }
  }, [instance, isProvisioning, errorMessage, provisionVM]);

  useEffect(() => {
    if (pendingFocusIndex !== null) {
      const el = keyInputRefs.current[pendingFocusIndex];
      if (el) {
        setTimeout(() => {
          el.focus();
          try {
            el.scrollIntoView({ block: "nearest" });
          } catch (_e) {
            void 0;
          }
        }, 0);
        setPendingFocusIndex(null);
      }
    }
  }, [pendingFocusIndex, envVars]);

  // Auto-apply env vars to sandbox
  useEffect(() => {
    if (!instance?.instanceId) {
      return;
    }

    const envVarsContent = formatEnvVarsContent(
      envVars
        .filter((r) => r.name.trim().length > 0)
        .map((r) => ({ name: r.name, value: r.value }))
    );

    if (envVarsContent.length === 0 && lastSubmittedEnvContent.current === null) {
      return;
    }

    if (envVarsContent === lastSubmittedEnvContent.current) {
      return;
    }

    const timeoutId = window.setTimeout(async () => {
      try {
        await fetch(`/api/sandboxes/${instance.instanceId}/env`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamSlugOrId, envVarsContent }),
        });
        lastSubmittedEnvContent.current = envVarsContent;
      } catch (error) {
        console.error("Failed to apply sandbox environment vars", error);
      }
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [envVars, instance?.instanceId, teamSlugOrId]);

  const updateEnvVars = useCallback((updater: (prev: EnvVar[]) => EnvVar[]) => {
    setEnvVars((prev) => updater(prev));
  }, []);

  const handleSaveConfiguration = async () => {
    if (!instance?.instanceId) {
      console.error("Missing instanceId for configuration save");
      return;
    }

    const repoName = repo.split("/").pop() || "preview";
    const now = new Date();
    const dateTime = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const envName = `${repoName}-${dateTime}`;

    const envVarsContent = formatEnvVarsContent(
      envVars
        .filter((r) => r.name.trim().length > 0)
        .map((r) => ({ name: r.name, value: r.value }))
    );

    const normalizedMaintenanceScript = maintenanceScript.trim();
    const normalizedDevScript = devScript.trim();
    const requestMaintenanceScript =
      normalizedMaintenanceScript.length > 0 ? normalizedMaintenanceScript : undefined;
    const requestDevScript =
      normalizedDevScript.length > 0 ? normalizedDevScript : undefined;

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const envResponse = await fetch("/api/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamSlugOrId,
          name: envName,
          morphInstanceId: instance.instanceId,
          envVarsContent,
          selectedRepos: [repo],
          maintenanceScript: requestMaintenanceScript,
          devScript: requestDevScript,
          exposedPorts: undefined,
          description: undefined,
        }),
      });

      if (!envResponse.ok) {
        throw new Error(await envResponse.text());
      }

      const envData = await envResponse.json();
      const environmentId = envData.id;

      const previewResponse = await fetch("/api/preview/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamSlugOrId,
          repoFullName: repo,
          environmentId,
          repoInstallationId: _installationId ? Number(_installationId) : undefined,
          repoDefaultBranch: "main",
          status: "active",
        }),
      });

      if (!previewResponse.ok) {
        throw new Error(await previewResponse.text());
      }

      window.location.href = "/preview";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save configuration";
      setErrorMessage(message);
      console.error("Failed to save preview configuration:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleNextStep = () => {
    if (currentStep < 2) {
      setCurrentStep((currentStep + 1) as WizardStep);
    }
  };

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep((currentStep - 1) as WizardStep);
    }
  };

  // Mount iframes
  useLayoutEffect(() => {
    if (!instance || !persistentIframeManager) return;

    const cleanupFunctions: Array<() => void> = [];

    if (instance.vscodeUrl) {
      const vscodeUrl = new URL(instance.vscodeUrl);
      vscodeUrl.searchParams.set("folder", "/root/workspace");
      persistentIframeManager.getOrCreateIframe(vscodePersistKey, vscodeUrl.toString());
      const targets = document.querySelectorAll(
        `[data-iframe-target="${vscodePersistKey}"]`,
      );
      // Mount to the first visible target
      const target = targets[0] as HTMLElement | null;
      if (target) {
        cleanupFunctions.push(persistentIframeManager.mountIframe(vscodePersistKey, target));
      }
    }

    if (resolvedVncUrl && currentStep === 2) {
      persistentIframeManager.getOrCreateIframe(browserPersistKey, resolvedVncUrl);
      const target = document.querySelector(
        `[data-iframe-target="${browserPersistKey}"]`,
      ) as HTMLElement | null;
      if (target) {
        cleanupFunctions.push(
          persistentIframeManager.mountIframe(browserPersistKey, target, {
            backgroundColor: "#000000",
          }),
        );
      }
    }

    return () => {
      cleanupFunctions.forEach((fn) => fn());
    };
  }, [
    browserPersistKey,
    instance,
    persistentIframeManager,
    currentStep,
    resolvedVncUrl,
    vscodePersistKey,
  ]);

  // Control iframe visibility based on current step
  useEffect(() => {
    if (!persistentIframeManager) {
      return;
    }

    // Step 1: VS Code only
    // Step 2: Browser only
    const workspaceVisible = currentStep === 1 && Boolean(instance?.vscodeUrl);
    const browserVisible = currentStep === 2 && Boolean(resolvedVncUrl);

    persistentIframeManager.setVisibility(vscodePersistKey, workspaceVisible);
    persistentIframeManager.setVisibility(browserPersistKey, browserVisible);
  }, [
    browserPersistKey,
    currentStep,
    persistentIframeManager,
    resolvedVncUrl,
    instance?.vscodeUrl,
    vscodePersistKey,
  ]);

  if (errorMessage && !instance) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#05050a] text-white">
        <div className="text-center max-w-md px-6">
          <h1 className="text-2xl font-bold text-red-400">Error</h1>
          <p className="mt-2 text-neutral-400">{errorMessage}</p>
          <button
            type="button"
            onClick={() => {
              setErrorMessage(null);
              void provisionVM();
            }}
            className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-neutral-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (isProvisioning || !instance) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#05050a] text-white">
        <div className="text-center">
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-sky-400" />
          <h1 className="mt-4 text-2xl font-bold">Provisioning Workspace</h1>
          <p className="mt-2 text-neutral-400">
            Setting up your development environment for <span className="font-mono text-white">{repo}</span>
          </p>
          <p className="mt-1 text-xs text-neutral-500">This may take a minute...</p>
        </div>
      </div>
    );
  }

  const renderStep1Content = () => (
    <div className="space-y-5">
      {/* Workspace Info */}
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 p-3">
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          The workspace root <code className="px-1 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">/root/workspace</code> maps to your repository root. All scripts run from this directory.
        </p>
      </div>

      {/* Environment Variables */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            1
          </div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 flex-1">
            Add environment variables
          </h3>
          <button
            type="button"
            onClick={() => {
              setActiveEnvValueIndex(null);
              setAreEnvValuesHidden((previous) => !previous);
            }}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition p-1"
            aria-label={areEnvValuesHidden ? "Reveal values" : "Hide values"}
          >
            {areEnvValuesHidden ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        <p className="ml-9 text-xs text-neutral-500 dark:text-neutral-400 mb-3">
          Stored encrypted and injected securely at runtime. Never exposed in logs or code.
        </p>
        <div
          className="ml-9"
          onPasteCapture={(e) => {
            const text = e.clipboardData?.getData("text") ?? "";
            if (text && (/\n/.test(text) || /(=|:)\s*\S/.test(text))) {
              e.preventDefault();
              const items = parseEnvBlock(text);
              if (items.length > 0) {
                updateEnvVars((prev) => {
                  const map = new Map(
                    prev
                      .filter((r) => r.name.trim().length > 0 || r.value.trim().length > 0)
                      .map((r) => [r.name, r] as const)
                  );
                  for (const it of items) {
                    if (!it.name) continue;
                    const existing = map.get(it.name);
                    if (existing) {
                      map.set(it.name, { ...existing, value: it.value });
                    } else {
                      map.set(it.name, { name: it.name, value: it.value, isSecret: true });
                    }
                  }
                  const next = Array.from(map.values());
                  next.push({ name: "", value: "", isSecret: true });
                  setPendingFocusIndex(next.length - 1);
                  return next;
                });
              }
            }
          }}
        >
          <div
            className="grid gap-3 text-xs text-neutral-500 dark:text-neutral-500 items-center pb-2"
            style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) 44px" }}
          >
            <span>Key</span>
            <span>Value</span>
            <span />
          </div>

          <div className="space-y-2">
            {envVars.map((row, idx) => {
              const rowKey = idx;
              const isEditingValue = activeEnvValueIndex === idx;
              const shouldMaskValue = areEnvValuesHidden && row.value.trim().length > 0 && !isEditingValue;
              return (
                <div
                  key={rowKey}
                  className="grid gap-3 items-center"
                  style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) 44px" }}
                >
                  <input
                    type="text"
                    value={row.name}
                    ref={(el) => {
                      keyInputRefs.current[idx] = el;
                    }}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateEnvVars((prev) => {
                        const next = [...prev];
                        const current = next[idx];
                        if (current) {
                          next[idx] = { ...current, name: v };
                        }
                        return next;
                      });
                    }}
                    placeholder="EXAMPLE_NAME"
                    className="w-full min-w-0 self-start rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-700"
                  />
                  <textarea
                    value={shouldMaskValue ? MASKED_ENV_VALUE : row.value}
                    onChange={
                      shouldMaskValue
                        ? undefined
                        : (e: ChangeEvent<HTMLTextAreaElement>) => {
                            const v = e.target.value;
                            updateEnvVars((prev) => {
                              const next = [...prev];
                              const current = next[idx];
                              if (current) {
                                next[idx] = { ...current, value: v };
                              }
                              return next;
                            });
                          }
                    }
                    onFocus={() => setActiveEnvValueIndex(idx)}
                    onBlur={() => setActiveEnvValueIndex((current) => (current === idx ? null : current))}
                    readOnly={shouldMaskValue}
                    placeholder="value"
                    rows={1}
                    className="w-full min-w-0 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-700 resize-y"
                  />
                  <div className="self-start flex items-center justify-end w-[44px]">
                    <button
                      type="button"
                      onClick={() => {
                        updateEnvVars((prev) => {
                          const next = prev.filter((_, i) => i !== idx);
                          return next.length > 0 ? next : [{ name: "", value: "", isSecret: true }];
                        });
                      }}
                      className="h-10 w-[44px] rounded-md border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 grid place-items-center hover:bg-neutral-50 dark:hover:bg-neutral-900"
                      aria-label="Remove variable"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-3">
            <button
              type="button"
              onClick={() =>
                updateEnvVars((prev) => [...prev, { name: "", value: "", isSecret: true }])
              }
              className="inline-flex items-center gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <Plus className="w-4 h-4" /> Add More
            </button>
          </div>

          <p className="text-xs text-neutral-400 dark:text-neutral-500 pt-3">
            Tip: Paste a .env file to auto-fill
          </p>
        </div>
      </div>

      {/* Maintenance Script */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            2
          </div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Maintenance script
          </h3>
        </div>
        <div className="ml-9">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            Runs after git pull to install dependencies
          </p>
          <textarea
            value={maintenanceScript}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setMaintenanceScript(e.target.value)}
            placeholder="npm install"
            rows={2}
            className="w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-xs font-mono text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-700 resize-y"
          />
        </div>
      </div>

      {/* Dev Script */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            3
          </div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Dev script
          </h3>
        </div>
        <div className="ml-9">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            Starts the development server
          </p>
          <textarea
            value={devScript}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDevScript(e.target.value)}
            placeholder="npm run dev"
            rows={2}
            className="w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-xs font-mono text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 dark:focus:ring-neutral-700 resize-y"
          />
        </div>
      </div>

      {/* Run Scripts */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            4
          </div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Run scripts in VS Code terminal
          </h3>
        </div>
        <div className="ml-9 space-y-4">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Open the terminal in VS Code (<kbd className="px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 text-xs">Cmd+J</kbd> or <kbd className="px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 text-xs">Ctrl+`</kbd>) and paste:
          </p>
          {(maintenanceScript.trim() || devScript.trim()) ? (
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-900 dark:bg-neutral-950 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-700 dark:border-neutral-800 bg-neutral-800 dark:bg-neutral-900">
                <span className="text-xs text-neutral-400">Commands</span>
                <button
                  type="button"
                  onClick={() => {
                    const combined = [maintenanceScript.trim(), devScript.trim()].filter(Boolean).join(' && ');
                    navigator.clipboard.writeText(combined);
                  }}
                  className="text-neutral-400 hover:text-neutral-200 transition p-1"
                  aria-label="Copy commands"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
              <pre className="px-3 py-2 text-xs font-mono text-neutral-100 overflow-x-auto whitespace-pre-wrap break-all select-all">
                {[maintenanceScript.trim(), devScript.trim()].filter(Boolean).join(' && ')}
              </pre>
            </div>
          ) : (
            <p className="text-sm text-neutral-400 dark:text-neutral-500 italic">
              Enter scripts above to see commands to run
            </p>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Proceed once your dev server is running.
          </p>
        </div>
      </div>
    </div>
  );

  const renderStep2Content = () => (
    <div className="space-y-8">
      {/* Browser Setup Info */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            1
          </div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Prepare browser for automation
          </h3>
        </div>
        <div className="ml-9 space-y-4">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Use the browser on the right to set up any authentication or configuration needed:
          </p>
          <ul className="space-y-3 text-sm text-neutral-600 dark:text-neutral-400">
            <li className="flex items-start gap-3">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 flex-shrink-0 mt-0.5">1</span>
              <span>Sign in to any dashboards or SaaS tools</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 flex-shrink-0 mt-0.5">2</span>
              <span>Dismiss cookie banners, popups, or MFA prompts</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800 text-xs text-neutral-500 dark:text-neutral-400 flex-shrink-0 mt-0.5">3</span>
              <span>Navigate to your dev server URL (e.g., localhost:3000)</span>
            </li>
          </ul>
        </div>
      </div>

      {/* Note about terminal */}
      <div className="ml-9 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 p-4">
        <p className="text-sm text-amber-800 dark:text-amber-200">
          <strong>Note:</strong> Any running terminals will be stopped when you save. The dev script you configured will run automatically on each preview.
        </p>
      </div>
    </div>
  );

  const renderPreviewPanel = () => {
    const isVscodeStep = currentStep === 1;
    const title = isVscodeStep ? "VS Code" : "Browser";
    const placeholder = isVscodeStep ? workspacePlaceholder : browserPlaceholder;
    const iframeKey = isVscodeStep ? vscodePersistKey : browserPersistKey;

    return (
      <div className="h-full flex flex-col rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-sm overflow-hidden">
        <div className="flex items-center border-b border-neutral-200 dark:border-neutral-800 px-3 py-2">
          <h2 className="text-xs font-medium text-neutral-800 dark:text-neutral-100">
            {title}
          </h2>
        </div>
        <div className="relative flex-1">
          {placeholder ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-neutral-500 dark:text-neutral-400">
              <div className="text-sm font-medium text-neutral-600 dark:text-neutral-200">
                {placeholder.title}
              </div>
              {placeholder.description ? (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {placeholder.description}
                </p>
              ) : null}
            </div>
          ) : null}
          <div
            className={clsx(
              "absolute inset-0",
              placeholder ? "opacity-0" : "opacity-100"
            )}
            data-iframe-target={iframeKey}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 dark:bg-neutral-950">
      {/* Left: Configuration Form */}
      <div className="w-[420px] flex flex-col overflow-hidden border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black">
        <div className="flex-shrink-0 p-6 pb-4">
          <Link
            href="/preview"
            className="inline-flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 mb-4"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Home
          </Link>

          <div className="flex items-center gap-2 mb-4">
            <span className="inline-flex items-center gap-2 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 px-2 py-1 text-xs font-mono">
              {/* eslint-disable-next-line @typescript-eslint/no-deprecated */}
              <Github className="h-3.5 w-3.5" />
              {repo}
            </span>
          </div>

          <StepIndicator currentStep={currentStep} />
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {currentStep === 1 ? renderStep1Content() : renderStep2Content()}
        </div>

        <div className="flex-shrink-0 border-t border-neutral-200 dark:border-neutral-800 p-6 bg-white dark:bg-black">
          {errorMessage && (
            <div className="rounded-md bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/50 p-3 mb-4">
              <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            {currentStep > 1 ? (
              <button
                type="button"
                onClick={handlePrevStep}
                className="inline-flex items-center gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
            ) : (
              <div />
            )}

            {currentStep < 2 ? (
              <button
                type="button"
                onClick={handleNextStep}
                className="inline-flex items-center gap-2 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 transition"
              >
                Next
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSaveConfiguration}
                disabled={isSaving}
                className="inline-flex items-center justify-center rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-4 py-2 text-sm font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Configuration"
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Right: Preview Panel */}
      <div className="flex-1 flex flex-col bg-neutral-50 dark:bg-neutral-950 overflow-hidden p-4">
        {renderPreviewPanel()}
      </div>
    </div>
  );
}
