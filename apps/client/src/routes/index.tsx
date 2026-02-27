import { env } from "@/client-env";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getLastTeamSlugOrId } from "@/lib/lastTeam";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (env.NEXT_PUBLIC_AUTH_MODE === "local") {
      const jwt = localStorage.getItem("cmux-local-jwt");
      const userJson = localStorage.getItem("cmux-local-user");
      if (jwt && userJson) {
        const user = JSON.parse(userJson) as { teamSlug: string };
        throw redirect({
          to: "/$teamSlugOrId/dashboard",
          params: { teamSlugOrId: user.teamSlug },
        });
      }
      // No JWT — redirect to sign-in
      throw redirect({ to: "/sign-in" });
    }
    if (typeof window !== "undefined") {
      const last = getLastTeamSlugOrId();
      if (last && last.trim().length > 0) {
        throw redirect({
          to: "/$teamSlugOrId/dashboard",
          params: { teamSlugOrId: last },
        });
      }
    }
    throw redirect({ to: "/team-picker" });
  },
  component: () => null,
});
