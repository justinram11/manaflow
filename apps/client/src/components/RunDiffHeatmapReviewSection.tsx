import { gitDiffQueryOptions } from "@/queries/git-diff";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReplaceDiffEntry } from "@cmux/shared/diff-types";
import {
  GitDiffHeatmapReviewViewer,
  type StreamFileState,
  type StreamFileStatus,
} from "@/components/heatmap-diff-viewer";
import type { HeatmapColorSettings } from "@/components/heatmap-diff-viewer/heatmap-gradient";
import {
  DEFAULT_HEATMAP_MODEL,
  DEFAULT_TOOLTIP_LANGUAGE,
  normalizeHeatmapModel,
  normalizeTooltipLanguage,
  type HeatmapModelOptionValue,
  type TooltipLanguageValue,
} from "@/lib/heatmap-settings";
import type { DiffViewerControls } from "@/components/heatmap-diff-viewer";
import { cachedGetUser } from "@/lib/cachedGetUser";
import type { ReviewHeatmapLine } from "@/lib/heatmap";
import { stackClientApp } from "@/lib/stack";
import { WWW_ORIGIN } from "@/lib/wwwOrigin";
import { buildDiffText } from "@/components/heatmap-diff-viewer/git-diff-review-viewer";

export interface RunDiffHeatmapReviewSectionProps {
  repoFullName: string;
  ref1: string;
  ref2: string;
  onControlsChange?: (controls: DiffViewerControls) => void;
  additionalRepoFullNames?: string[];
  withRepoPrefix?: boolean;
  metadataByRepo?: Record<
    string,
    {
      lastKnownBaseSha?: string;
      lastKnownMergeCommitSha?: string;
    }
  >;
  heatmapThreshold: number;
  heatmapColors: HeatmapColorSettings;
  heatmapModel: HeatmapModelOptionValue;
  heatmapTooltipLanguage: TooltipLanguageValue;
  reviewLabel: string;
  fileOutputs?: Array<{
    filePath: string;
    codexReviewOutput: unknown;
  }>;
  onHeatmapThresholdChange?: (next: number) => void;
  onHeatmapColorsChange?: (next: HeatmapColorSettings) => void;
  onHeatmapModelChange?: (next: HeatmapModelOptionValue) => void;
  onHeatmapTooltipLanguageChange?: (next: TooltipLanguageValue) => void;
}

function applyRepoPrefix(
  entry: ReplaceDiffEntry,
  prefix: string | null,
): ReplaceDiffEntry {
  if (!prefix) {
    return entry;
  }
  const normalizedPrefix = prefix.endsWith(":") ? prefix : `${prefix}:`;
  return {
    ...entry,
    filePath: `${normalizedPrefix}${entry.filePath}`,
    oldPath: entry.oldPath
      ? `${normalizedPrefix}${entry.oldPath}`
      : entry.oldPath,
  };
}

const DIFF_HEADER_PREFIXES = [
  "diff --git ",
  "index ",
  "--- ",
  "+++ ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "rename from ",
  "rename to ",
  "old mode ",
  "new mode ",
  "copy from ",
  "copy to ",
];

function stripDiffHeaders(diffText: string): string {
  const lines = diffText.split("\n");
  const filtered = lines.filter(
    (line) =>
      !DIFF_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))
  );
  return filtered.join("\n").trimEnd();
}

function convertDiffsToFileDiffs(
  diffs: ReplaceDiffEntry[],
): Array<{ filePath: string; diffText: string }> {
  return diffs
    .filter((entry) => !entry.isBinary)
    .map((entry) => {
      const diffText = buildDiffText(entry);
      if (!diffText) {
        return null;
      }
      const stripped = stripDiffHeaders(diffText);
      if (!stripped) {
        return null;
      }
      return { filePath: entry.filePath, diffText: stripped };
    })
    .filter(
      (entry): entry is { filePath: string; diffText: string } =>
        entry !== null
    );
}

export function RunDiffHeatmapReviewSection(
  props: RunDiffHeatmapReviewSectionProps,
) {
  const {
    repoFullName,
    ref1,
    ref2,
    onControlsChange,
    additionalRepoFullNames,
    withRepoPrefix,
    metadataByRepo,
    heatmapThreshold,
    heatmapColors,
    heatmapModel,
    heatmapTooltipLanguage,
    reviewLabel,
    fileOutputs,
    onHeatmapThresholdChange,
    onHeatmapColorsChange,
    onHeatmapModelChange,
    onHeatmapTooltipLanguageChange,
  } = props;

  const [streamStateByFile, setStreamStateByFile] = useState<
    Map<string, StreamFileState>
  >(() => new Map());
  const deferredStreamStateByFile = useDeferredValue(streamStateByFile);
  const streamStateRef = useRef<Map<string, StreamFileState>>(new Map());
  const streamStateRafRef = useRef<number | null>(null);
  const activeReviewControllerRef = useRef<AbortController | null>(null);
  const activeReviewKeyRef = useRef<string | null>(null);

  const repoFullNames = useMemo(() => {
    const unique = new Set<string>();
    if (repoFullName?.trim()) {
      unique.add(repoFullName.trim());
    }
    additionalRepoFullNames
      ?.map((name) => name?.trim())
      .filter((name): name is string => Boolean(name))
      .forEach((name) => unique.add(name));
    return Array.from(unique);
  }, [repoFullName, additionalRepoFullNames]);

  const canFetch = repoFullNames.length > 0 && Boolean(ref1) && Boolean(ref2);

  const flushStreamState = useCallback(() => {
    streamStateRafRef.current = null;
    setStreamStateByFile(new Map(streamStateRef.current));
  }, []);

  const scheduleStreamStateUpdate = useCallback(
    (updater: (draft: Map<string, StreamFileState>) => void) => {
      updater(streamStateRef.current);
      if (typeof window === "undefined") {
        flushStreamState();
        return;
      }
      if (streamStateRafRef.current === null) {
        streamStateRafRef.current = window.requestAnimationFrame(() => {
          flushStreamState();
        });
      }
    },
    [flushStreamState]
  );

  const resetStreamState = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      streamStateRafRef.current !== null
    ) {
      window.cancelAnimationFrame(streamStateRafRef.current);
      streamStateRafRef.current = null;
    }
    streamStateRef.current = new Map();
    setStreamStateByFile(new Map());
  }, []);

  useEffect(() => {
    return () => {
      if (
        typeof window !== "undefined" &&
        streamStateRafRef.current !== null
      ) {
        window.cancelAnimationFrame(streamStateRafRef.current);
      }
    };
  }, []);

  const queries = useQueries({
    queries: repoFullNames.map((repo) => ({
      ...gitDiffQueryOptions({
        repoFullName: repo,
        baseRef: ref1,
        headRef: ref2,
        lastKnownBaseSha: metadataByRepo?.[repo]?.lastKnownBaseSha,
        lastKnownMergeCommitSha:
          metadataByRepo?.[repo]?.lastKnownMergeCommitSha,
      }),
      enabled: canFetch,
    })),
  });

  const effectiveHeatmapModel = useMemo(
    () => normalizeHeatmapModel(heatmapModel ?? DEFAULT_HEATMAP_MODEL),
    [heatmapModel]
  );
  const effectiveTooltipLanguage = useMemo(
    () =>
      normalizeTooltipLanguage(
        heatmapTooltipLanguage ?? DEFAULT_TOOLTIP_LANGUAGE
      ),
    [heatmapTooltipLanguage]
  );

  const combinedDiffsRef = useRef<ReplaceDiffEntry[]>([]);
  const prevDepsRef = useRef<{
    queryData: Array<ReplaceDiffEntry[] | undefined>;
    repoFullNames: string[];
    shouldPrefix: boolean;
  }>({ queryData: [], repoFullNames: [], shouldPrefix: false });

  const isPending = queries.some(
    (query) => query.isPending || query.isFetching,
  );
  const firstError = queries.find((query) => query.isError);

  const shouldPrefix = withRepoPrefix ?? repoFullNames.length > 1;

  const currentQueryData = queries.map((q) => q.data);
  const depsChanged =
    currentQueryData.length !== prevDepsRef.current.queryData.length ||
    currentQueryData.some((data, i) => data !== prevDepsRef.current.queryData[i]) ||
    repoFullNames.length !== prevDepsRef.current.repoFullNames.length ||
    repoFullNames.some((name, i) => name !== prevDepsRef.current.repoFullNames[i]) ||
    shouldPrefix !== prevDepsRef.current.shouldPrefix;

  if (depsChanged) {
    prevDepsRef.current = {
      queryData: currentQueryData,
      repoFullNames: [...repoFullNames],
      shouldPrefix,
    };
    combinedDiffsRef.current = repoFullNames.flatMap((repo, index) => {
      const data = queries[index]?.data ?? [];
      const prefix = shouldPrefix ? `${repo}:` : null;
      return data.map((entry) => applyRepoPrefix(entry, prefix));
    });
  }

  const combinedDiffs = combinedDiffsRef.current;

  if (combinedDiffs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-neutral-500 dark:text-neutral-400 text-sm select-none">
          No changes to display
        </div>
      </div>
    );
  }

  return (
    <GitDiffHeatmapReviewViewer
      diffs={combinedDiffs}
      fileOutputs={fileOutputs}
      streamStateByFile={streamStateByFile}
      primaryRepoFullName={repoFullName}
      shouldPrefixDiffs={shouldPrefix}
      heatmapThreshold={heatmapThreshold}
      heatmapColors={heatmapColors}
      heatmapModel={heatmapModel}
      heatmapTooltipLanguage={heatmapTooltipLanguage}
      onHeatmapThresholdChange={onHeatmapThresholdChange}
      onHeatmapColorsChange={onHeatmapColorsChange}
      onHeatmapModelChange={onHeatmapModelChange}
      onHeatmapTooltipLanguageChange={onHeatmapTooltipLanguageChange}
      onControlsChange={onControlsChange}
    />
  );
}
