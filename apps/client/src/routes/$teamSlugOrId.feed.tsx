import { cachedGetUser } from "@/lib/cachedGetUser";
import { stackClientApp } from "@/lib/stack";
import { queryClient } from "@/query-client";
import {
  getApiTeamsOptions,
} from "@cmux/www-openapi-client/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$teamSlugOrId/feed")({
  component: FeedPage,
  beforeLoad: async ({ params, location }) => {
    const user = await cachedGetUser(stackClientApp);
    if (!user) {
      throw redirect({
        to: "/sign-in",
        search: {
          after_auth_return_to: location.pathname,
        },
      });
    }

    const { teamSlugOrId } = params;
    const teamsData = await queryClient.ensureQueryData(getApiTeamsOptions());
    const teams = teamsData.teams as Array<{ id?: string; slug?: string; teamId?: string }>;
    const teamMembership = teams.find((team) => {
      return team.slug === teamSlugOrId || team.id === teamSlugOrId || team.teamId === teamSlugOrId;
    });
    if (!teamMembership) {
      throw redirect({ to: "/team-picker" });
    }
  },
});

function FeedPage() {
  const { teamSlugOrId } = Route.useParams();

  return (
    <div className="min-h-dvh bg-neutral-50 dark:bg-neutral-950">
      <div className="max-w-2xl mx-auto py-8 px-4">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100 mb-6">
          Feed
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Team: {teamSlugOrId}
        </p>
      </div>
    </div>
  );
}
