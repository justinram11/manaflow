import { DEFAULT_MORPH_SNAPSHOT_ID } from "@/lib/utils/morph-defaults";
import { verifyTeamAccess } from "@/lib/utils/team-verification";
import { getDb } from "@cmux/db";
import {
  getEnvironmentByTeam,
  listEnvironments,
  findSnapshotVersionBySnapshotId,
} from "@cmux/db/queries/environments";
import { MORPH_SNAPSHOT_PRESETS } from "@cmux/shared";
import { typedZid } from "@cmux/shared/utils/typed-zid";
import { HTTPException } from "hono/http-exception";

export interface SnapshotResolution {
  team: Awaited<ReturnType<typeof verifyTeamAccess>>;
  resolvedSnapshotId: string;
  environmentDataVaultKey?: string;
  environmentMaintenanceScript?: string;
  environmentDevScript?: string;
}

export const resolveTeamAndSnapshot = async ({
  req,
  teamSlugOrId,
  environmentId,
  snapshotId,
}: {
  req: Request;
  teamSlugOrId: string;
  environmentId?: string;
  snapshotId?: string;
}): Promise<SnapshotResolution> => {
  const team = await verifyTeamAccess({ req, teamSlugOrId });
  const db = getDb();

  if (environmentId) {
    const environmentDoc = getEnvironmentByTeam(
      db,
      teamSlugOrId,
      typedZid("environments").parse(environmentId),
    );

    if (!environmentDoc) {
      throw new HTTPException(403, {
        message: "Environment not found or not accessible",
      });
    }

    return {
      team,
      resolvedSnapshotId:
        environmentDoc.morphSnapshotId || DEFAULT_MORPH_SNAPSHOT_ID,
      environmentDataVaultKey: environmentDoc.dataVaultKey ?? undefined,
      environmentMaintenanceScript: environmentDoc.maintenanceScript ?? undefined,
      environmentDevScript: environmentDoc.devScript ?? undefined,
    };
  }

  if (snapshotId) {
    const isKnownDefaultSnapshot = MORPH_SNAPSHOT_PRESETS.some((preset) =>
      preset.versions.some((v) => v.snapshotId === snapshotId)
    );

    if (isKnownDefaultSnapshot) {
      return {
        team,
        resolvedSnapshotId: snapshotId,
      };
    }

    const environments = listEnvironments(db, teamSlugOrId);
    const matchedEnvironment = environments.find(
      (environment: (typeof environments)[number]) => environment.morphSnapshotId === snapshotId
    );

    if (matchedEnvironment) {
      return {
        team,
        resolvedSnapshotId:
          matchedEnvironment.morphSnapshotId || DEFAULT_MORPH_SNAPSHOT_ID,
      };
    }

    const snapshotVersion = findSnapshotVersionBySnapshotId(
      db,
      teamSlugOrId,
      snapshotId,
    );

    if (!snapshotVersion) {
      throw new HTTPException(403, {
        message: "Forbidden: Snapshot does not belong to this team",
      });
    }

    return {
      team,
      resolvedSnapshotId:
        snapshotVersion.morphSnapshotId || DEFAULT_MORPH_SNAPSHOT_ID,
    };
  }

  return {
    team,
    resolvedSnapshotId: DEFAULT_MORPH_SNAPSHOT_ID,
  };
};
