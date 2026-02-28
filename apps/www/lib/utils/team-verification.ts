import { HTTPException } from "hono/http-exception";
import { getDb } from "@cmux/db";
import { getTeamBySlugOrId } from "@cmux/db/queries/teams";

/**
 * Verifies that a user has access to a team and returns the team object.
 * Throws HTTPException if the user doesn't have access.
 */
export async function verifyTeamAccess({
  teamSlugOrId,
}: {
  req?: Request;
  accessToken?: string | null;
  teamSlugOrId: string;
}): Promise<{
  uuid: string;
  slug: string | null;
  displayName: string | null;
  name: string | null;
}> {
  const db = getDb();

  try {
    const team = getTeamBySlugOrId(db, teamSlugOrId);

    if (!team) {
      throw new HTTPException(404, { message: "Team not found" });
    }

    return {
      uuid: team.teamId,
      slug: team.slug,
      displayName: team.displayName,
      name: team.displayName,
    };
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    throw new HTTPException(500, { message: "Failed to verify team access" });
  }
}
