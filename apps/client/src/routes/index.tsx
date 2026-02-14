import { env } from "@/client-env";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getLastTeamSlugOrId } from "@/lib/lastTeam";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (env.NEXT_PUBLIC_AUTH_MODE === "local") {
      throw redirect({
        to: "/$teamSlugOrId/dashboard",
        params: { teamSlugOrId: "local" },
      });
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
