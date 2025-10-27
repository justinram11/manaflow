import { EnvironmentConfiguration } from "@/components/EnvironmentConfiguration";
import { FloatingPane } from "@/components/floating-pane";
import { RepositoryPicker } from "@/components/RepositoryPicker";
import { TitleBar } from "@/components/TitleBar";
import { toMorphVncUrl } from "@/lib/toProxyWorkspaceUrl";
import {
  clearEnvironmentDraft,
  persistEnvironmentDraftMetadata,
  updateEnvironmentDraftConfig,
  useEnvironmentDraft,
} from "@/state/environment-draft-store";
import type { EnvironmentConfigDraft } from "@/types/environment";
import {
  DEFAULT_MORPH_SNAPSHOT_ID,
  MORPH_SNAPSHOT_PRESETS,
  type MorphSnapshotId,
} from "@cmux/shared";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

const morphSnapshotIds = MORPH_SNAPSHOT_PRESETS.map(
  (preset) => preset.id
) as [MorphSnapshotId, ...MorphSnapshotId[]];

const searchSchema = z.object({
  step: z.enum(["select", "configure"]).default("select"),
  selectedRepos: z.array(z.string()).default([]),
  instanceId: z.string().optional(),
  connectionLogin: z.string().optional(),
  repoSearch: z.string().optional(),
  snapshotId: z.enum(morphSnapshotIds).default(DEFAULT_MORPH_SNAPSHOT_ID),
});

export const Route = createFileRoute("/_layout/$teamSlugOrId/environments/new")(
  {
    component: EnvironmentsPage,
    validateSearch: searchSchema,
  }
);

function EnvironmentsPage() {
  const searchParams = Route.useSearch();
  const stepFromSearch = searchParams.step ?? "select";
  const urlSelectedRepos = searchParams.selectedRepos ?? [];
  const urlInstanceId = searchParams.instanceId;
  const searchSnapshotId =
    searchParams.snapshotId ?? DEFAULT_MORPH_SNAPSHOT_ID;
  const { teamSlugOrId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const draft = useEnvironmentDraft(teamSlugOrId);
  const [headerActions, setHeaderActions] = useState<ReactNode | null>(null);

  const activeStep = draft?.step === "configure" ? "configure" : stepFromSearch;
  const activeSelectedRepos = draft?.selectedRepos ?? urlSelectedRepos;
  const activeInstanceId = draft?.instanceId ?? urlInstanceId;
  const activeSnapshotId = draft?.snapshotId ?? searchSnapshotId;

  const derivedVscodeUrl = useMemo(() => {
    if (!activeInstanceId) return undefined;
    const hostId = activeInstanceId.replace(/_/g, "-");
    return `https://port-39378-${hostId}.http.cloud.morph.so/?folder=/root/workspace`;
  }, [activeInstanceId]);

  const derivedBrowserUrl = useMemo(() => {
    if (!activeInstanceId) return undefined;
    const hostId = activeInstanceId.replace(/_/g, "-");
    const workspaceUrl = `https://port-39378-${hostId}.http.cloud.morph.so/?folder=/root/workspace`;
    return toMorphVncUrl(workspaceUrl) ?? undefined;
  }, [activeInstanceId]);

  useEffect(() => {
    if (activeStep !== "configure") {
      setHeaderActions(null);
    }
  }, [activeStep]);

  useEffect(() => {
    if (activeStep !== "configure" || draft) {
      return;
    }
    persistEnvironmentDraftMetadata(
      teamSlugOrId,
      {
        selectedRepos: activeSelectedRepos,
        instanceId: activeInstanceId,
        snapshotId: activeSnapshotId,
      },
      { resetConfig: false },
    );
  }, [
    activeInstanceId,
    activeSelectedRepos,
    activeSnapshotId,
    activeStep,
    draft,
    teamSlugOrId,
  ]);

  const handleStartConfigure = useCallback(
    (payload: {
      selectedRepos: string[];
      instanceId?: string;
      snapshotId?: MorphSnapshotId;
    }) => {
      persistEnvironmentDraftMetadata(
        teamSlugOrId,
        {
          selectedRepos: payload.selectedRepos,
          instanceId: payload.instanceId,
          snapshotId: payload.snapshotId,
        },
        { resetConfig: true },
      );
    },
    [teamSlugOrId],
  );

  const handlePersistConfig = useCallback(
    (partial: Partial<EnvironmentConfigDraft>) => {
      updateEnvironmentDraftConfig(teamSlugOrId, partial, {
        selectedRepos: activeSelectedRepos,
        instanceId: activeInstanceId,
        snapshotId: activeSnapshotId,
      });
    },
    [teamSlugOrId, activeInstanceId, activeSelectedRepos, activeSnapshotId],
  );

  const handleResetDraft = useCallback(() => {
    clearEnvironmentDraft(teamSlugOrId);
    setHeaderActions(null);
  }, [teamSlugOrId]);

  const handleDiscardAndExit = useCallback(async () => {
    handleResetDraft();
    await navigate({
      to: "/$teamSlugOrId/environments",
      params: { teamSlugOrId },
      search: {
        step: undefined,
        selectedRepos: undefined,
        connectionLogin: undefined,
        repoSearch: undefined,
        instanceId: undefined,
        snapshotId: undefined,
      },
    });
  }, [handleResetDraft, navigate, teamSlugOrId]);

  return (
    <FloatingPane header={<TitleBar title="Environments" actions={headerActions} />}>
      <div className="flex flex-col grow select-none relative h-full overflow-hidden">
        {activeStep === "select" ? (
          <div className="p-6 max-w-3xl w-full mx-auto overflow-auto">
            <RepositoryPicker
              teamSlugOrId={teamSlugOrId}
              instanceId={activeInstanceId}
              initialSelectedRepos={activeSelectedRepos}
              initialSnapshotId={activeSnapshotId}
              showHeader={true}
              showContinueButton={true}
              showManualConfigOption={true}
              onStartConfigure={handleStartConfigure}
            />
          </div>
        ) : (
          <EnvironmentConfiguration
            selectedRepos={activeSelectedRepos}
            teamSlugOrId={teamSlugOrId}
            instanceId={activeInstanceId}
            vscodeUrl={derivedVscodeUrl}
            browserUrl={derivedBrowserUrl}
            isProvisioning={false}
            onHeaderControlsChange={setHeaderActions}
            persistedState={draft?.config}
            onPersistStateChange={handlePersistConfig}
            onDiscardDraft={handleDiscardAndExit}
            onEnvironmentSaved={handleResetDraft}
          />
        )}
      </div>
    </FloatingPane>
  );
}
