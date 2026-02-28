import { env } from "@/client-env";
import { BootLoaderProvider } from "@/contexts/auth/boot-loader-provider";
import { RealSocketProvider } from "@/contexts/socket/real-socket-provider";
import {
  identifyPosthogUser,
  initPosthog,
  resetPosthog,
} from "@/lib/analytics/posthog";
import { cachedGetUser } from "@/lib/cachedGetUser";
import { stackClientApp } from "@/lib/stack";
import {
  localVSCodeServeWebQueryOptions,
  useLocalVSCodeServeWebQuery,
} from "@/queries/local-vscode-serve-web";
import { getApiTeamsOptions } from "@cmux/www-openapi-client/react-query";
import { PostHogProvider } from "@posthog/react";
import { useUser } from "@stackframe/react";
import { useMatch } from "@tanstack/react-router";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

export const Route = createFileRoute("/_layout")({
  component: Layout,
  beforeLoad: async ({ context }) => {
    if (env.NEXT_PUBLIC_AUTH_MODE === "local") {
      const jwt = localStorage.getItem("cmux-local-jwt");
      if (!jwt) {
        throw redirect({
          to: "/sign-in",
          search: {
            after_auth_return_to: location.pathname,
          },
        });
      }
    } else {
      const user = await cachedGetUser(stackClientApp);
      if (!user) {
        throw redirect({
          to: "/sign-in",
          search: {
            after_auth_return_to: location.pathname,
          },
        });
      }
    }
    void context.queryClient
      .ensureQueryData(localVSCodeServeWebQueryOptions())
      .catch(() => undefined);
  },
});

function PosthogTracking() {
  const user = useUser({ or: "return-null" });
  const previousUserId = useRef<string | null>(null);
  const match = useMatch({
    from: "/_layout/$teamSlugOrId",
    shouldThrow: false,
  });
  const teamSlugOrId = match?.params.teamSlugOrId;
  const teamQuery = useQuery({
    ...getApiTeamsOptions(),
    enabled: Boolean(teamSlugOrId),
  });
  const team = useMemo(() => {
    if (!teamSlugOrId || !teamQuery.data) return undefined;
    const teams = teamQuery.data?.teams as Array<{ id?: string; uuid?: string; slug?: string }> | undefined;
    return teams?.find(
      (t) => t.slug === teamSlugOrId || t.id === teamSlugOrId || t.uuid === teamSlugOrId
    );
  }, [teamSlugOrId, teamQuery.data]);
  const teamId = team?.uuid ?? team?.id;

  useEffect(() => {
    if (!user) {
      if (previousUserId.current) {
        resetPosthog();
        previousUserId.current = null;
      }
      return;
    }

    identifyPosthogUser(user.id, {
      email: user.primaryEmail ?? undefined,
      name: user.displayName ?? undefined,
      team_id: teamId ?? undefined,
    });
    previousUserId.current = user.id;
  }, [teamId, user]);

  return null;
}

function MaybePosthogProvider({ children }: { children: React.ReactNode }) {
  const posthogClient = useMemo(() => initPosthog(), []);
  if (!posthogClient) {
    return children;
  }
  return <PostHogProvider client={posthogClient}>{children}</PostHogProvider>;
}

function Layout() {
  useLocalVSCodeServeWebQuery();

  return (
    <BootLoaderProvider>
      <RealSocketProvider>
        <MaybePosthogProvider>
          <PosthogTracking />
          <Outlet />
        </MaybePosthogProvider>
      </RealSocketProvider>
    </BootLoaderProvider>
  );
}
