import { ThemeProvider } from "@/components/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HeroUIProvider } from "@heroui/react";
import { StackProvider, StackTheme } from "@stackframe/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Component, type ErrorInfo, type ReactNode, Suspense, useEffect } from "react";
import { AntdProvider } from "./components/antd-provider";
import { OnboardingOverlay } from "./components/onboarding";
import { OnboardingProvider } from "./contexts/onboarding";
import { isElectron } from "./lib/electron";
import { isLocalAuth, stackClientApp } from "./lib/stack";
import { queryClient } from "./query-client";

function MaybeStackProvider({ children }: { children: ReactNode }) {
  if (isLocalAuth) {
    return <>{children}</>;
  }
  // stackClientApp is guaranteed non-null when !isLocalAuth.
  // The generic type mismatch (StackClientApp vs StackClientApp<true, string>)
  // is a @stackframe library quirk — the runtime types are identical.
  return <StackProvider app={stackClientApp as Parameters<typeof StackProvider>[0]["app"]}>{children}</StackProvider>;
}

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  useEffect(() => {
    if (isElectron) {
      document.documentElement.classList.add("is-electron");
    }
  }, []);

  return (
    <ThemeProvider>
      <StackTheme>
        <Suspense fallback={<div>Loading stack...</div>}>
          <MaybeStackProvider>
            <QueryClientProvider client={queryClient}>
              <TooltipProvider delayDuration={700} skipDelayDuration={300}>
                <HeroUIProvider>
                  <RootErrorBoundary>
                    <OnboardingProvider>
                      <AntdProvider>
                        {children}
                        <OnboardingOverlay />
                      </AntdProvider>
                    </OnboardingProvider>
                  </RootErrorBoundary>
                </HeroUIProvider>
              </TooltipProvider>
            </QueryClientProvider>
          </MaybeStackProvider>
        </Suspense>
      </StackTheme>
    </ThemeProvider>
  );
}

// Minimal error boundary to log render errors and show a friendly message.
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[RootErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 p-6">
          <div className="max-w-lg text-center">
            <p className="font-medium">Something went wrong.</p>
            <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              Check the console for details. The app hit an error while loading.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
