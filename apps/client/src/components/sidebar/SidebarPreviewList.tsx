import { api } from "@cmux/convex/api";
import type { Doc, Id } from "@cmux/convex/dataModel";
import { Link } from "@tanstack/react-router";
import { useQuery as useConvexQuery } from "convex/react";
import { CheckCircle, Circle } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import { SidebarListItem } from "./SidebarListItem";

type Props = {
  teamSlugOrId: string;
  limit?: number;
};

type PreviewRunWithConfig = Doc<"previewRuns"> & {
  configRepoFullName?: string;
  taskId?: Id<"tasks">;
};

const DEFAULT_LIMIT = 10;

type PreviewRunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

function getStatusIcon(status: PreviewRunStatus): ReactElement {
  // Only two states: open circle (in progress) or checkmark (done)
  if (status === "completed" || status === "failed" || status === "skipped") {
    return <CheckCircle className="w-3 h-3 text-neutral-400" />;
  }
  return <Circle className="w-3 h-3 text-neutral-400" />;
}

export function SidebarPreviewList({
  teamSlugOrId,
  limit = DEFAULT_LIMIT,
}: Props) {
  const previewRuns = useConvexQuery(api.previewRuns.listByTeam, {
    teamSlugOrId,
    limit,
  });

  const list = useMemo(() => previewRuns ?? [], [previewRuns]);

  if (previewRuns === undefined) {
    return (
      <ul className="flex flex-col gap-px" aria-label="Loading previews">
        {Array.from({ length: 3 }).map((_, index) => (
          <li key={index} className="px-2 py-1.5">
            <div className="h-3 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          </li>
        ))}
      </ul>
    );
  }

  if (list.length === 0) {
    return (
      <p className="mt-1 pl-2 pr-3 py-2 text-xs text-neutral-500 dark:text-neutral-400 select-none">
        No preview runs
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-px">
      {list.map((run) => (
        <PreviewListItem
          key={run._id}
          run={run}
          teamSlugOrId={teamSlugOrId}
        />
      ))}
    </ul>
  );
}

type PreviewListItemProps = {
  run: PreviewRunWithConfig;
  teamSlugOrId: string;
};

function PreviewListItem({ run, teamSlugOrId }: PreviewListItemProps) {
  const repoName = run.repoFullName?.split("/")[1] || run.repoFullName || "";
  const statusIcon = getStatusIcon(run.status);
  const secondary = [repoName, run.headRef].filter(Boolean).join(" - ");

  // If there's a linked taskId, link to the task page; otherwise just show the item
  if (run.taskId) {
    return (
      <li className="rounded-md select-none">
        <Link
          to="/$teamSlugOrId/task/$taskId"
          params={{
            teamSlugOrId,
            taskId: run.taskId,
          }}
          search={{ runId: run.taskRunId }}
          className="group block"
        >
          <SidebarListItem
            paddingLeft={10}
            title={`PR #${run.prNumber}`}
            titleClassName="text-[13px] text-neutral-950 dark:text-neutral-100"
            secondary={secondary || undefined}
            meta={statusIcon}
          />
        </Link>
      </li>
    );
  }

  return (
    <li className="rounded-md select-none">
      <a
        href={run.prUrl}
        target="_blank"
        rel="noreferrer"
        className="group block"
      >
        <SidebarListItem
          paddingLeft={10}
          title={`PR #${run.prNumber}`}
          titleClassName="text-[13px] text-neutral-950 dark:text-neutral-100"
          secondary={secondary || undefined}
          meta={statusIcon}
        />
      </a>
    </li>
  );
}

export default SidebarPreviewList;
