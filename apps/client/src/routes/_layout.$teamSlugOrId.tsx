import { CmuxComments } from "@/components/cmux-comments";
import { CommandBar } from "@/components/CommandBar";
import { Sidebar } from "@/components/Sidebar";
import { ExpandTasksProvider } from "@/contexts/expand-tasks/ExpandTasksProvider";
import { cachedGetUser } from "@/lib/cachedGetUser";
import { setLastTeamSlugOrId } from "@/lib/lastTeam";
import { stackClientApp } from "@/lib/stack";
import { queryClient } from "@/query-client";
import type { DbTask } from "@cmux/www-openapi-client";
import {
  getApiTasksNotificationOrderOptions,
  getApiTeamsOptions,
} from "@cmux/www-openapi-client/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useQuery as useRQ } from "@tanstack/react-query";
import { Suspense, useEffect } from "react";
import { env } from "@/client-env";

export const Route = createFileRoute("/_layout/$teamSlugOrId")({
  component: LayoutComponentWrapper,
  beforeLoad: async ({ params, location }) => {
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
    const { teamSlugOrId } = params;
    // Verify team membership via API
    const teamsData = await queryClient.ensureQueryData(getApiTeamsOptions());
    const teams = teamsData.teams as Array<{ id?: string; slug?: string; teamId?: string }>;
    const teamMembership = teams.find((team) => {
      return team.slug === teamSlugOrId || team.id === teamSlugOrId || team.teamId === teamSlugOrId;
    });
    if (!teamMembership) {
      throw redirect({ to: "/team-picker" });
    }
  },
  loader: async ({ params }) => {
    // In web mode, exclude local workspaces
    const excludeLocalWorkspaces = env.NEXT_PUBLIC_WEB_MODE ? "true" as const : undefined;
    void queryClient.prefetchQuery(
      getApiTasksNotificationOrderOptions({
        query: { teamSlugOrId: params.teamSlugOrId, excludeLocalWorkspaces },
      })
    );
  },
});

function LayoutComponent() {
  const { teamSlugOrId } = Route.useParams();
  // In web mode, exclude local workspaces
  const excludeLocalWorkspaces = env.NEXT_PUBLIC_WEB_MODE ? "true" as const : undefined;
  // Use React Query to fetch tasks sorted by notification order
  const tasksQuery = useRQ({
    ...getApiTasksNotificationOrderOptions({
      query: { teamSlugOrId, excludeLocalWorkspaces },
    }),
    enabled: Boolean(teamSlugOrId),
  });
  const tasks = tasksQuery.data?.tasks;

  // Tasks are already sorted by the query (unread notifications first, then by createdAt)
  // The API response includes hasUnread as an extra field beyond the base DbTask type
  const displayTasks = tasks as Array<DbTask & { hasUnread: boolean }> | undefined;

  return (
    <ExpandTasksProvider>
      <CommandBar teamSlugOrId={teamSlugOrId} />

      <div className="flex flex-row grow min-h-0 h-dvh bg-white dark:bg-black overflow-x-auto snap-x snap-mandatory md:overflow-x-visible md:snap-none">
        <Sidebar tasks={displayTasks} teamSlugOrId={teamSlugOrId} />

        <div className="min-w-full md:min-w-0 grow snap-start snap-always flex flex-col">
          <Suspense fallback={<div>Loading...</div>}>
            <Outlet />
          </Suspense>
        </div>
      </div>

      <button
        onClick={() => {
          const msg = window.prompt("Enter debug note");
          if (msg) {
            // Prefix allows us to easily grep in the console.

            console.log(`[USER NOTE] ${msg}`);
          }
        }}
        className="hidden"
        style={{
          position: "fixed",
          bottom: "16px",
          right: "16px",
          zIndex: "var(--z-overlay)",
          background: "#ffbf00",
          color: "#000",
          border: "none",
          borderRadius: "4px",
          padding: "8px 12px",
          cursor: "default",
          fontSize: "12px",
          fontWeight: 600,
          boxShadow: "0 2px 4px rgba(0,0,0,0.15)",
        }}
      >
        Add Debug Note
      </button>
    </ExpandTasksProvider>
  );
}

function LayoutComponentWrapper() {
  const { teamSlugOrId } = Route.useParams();
  useEffect(() => {
    setLastTeamSlugOrId(teamSlugOrId);
  }, [teamSlugOrId]);
  return (
    <>
      <LayoutComponent />
      <CmuxComments teamSlugOrId={teamSlugOrId} />
    </>
  );
}
