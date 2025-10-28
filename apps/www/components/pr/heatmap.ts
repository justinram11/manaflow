import {
  computeNewLineNumber,
  computeOldLineNumber,
  type FileData,
} from "react-diff-view";
import type { RangeTokenNode } from "react-diff-view";

export type ReviewHeatmapLine = {
  lineNumber: number | null;
  lineText: string | null;
  score: number | null;
  reason: string | null;
  mostImportantCharacterIndex: number | null;
};

export type DiffHeatmap = {
  lineClasses: Map<number, string>;
  oldLineClasses: Map<number, string>;
  newRanges: HeatmapRangeNode[];
  entries: Map<number, ResolvedHeatmapLine>;
  oldEntries: Map<number, ResolvedHeatmapLine>;
  totalEntries: number;
};

export type HeatmapRangeNode = RangeTokenNode & {
  className: string;
};

export type ResolvedHeatmapLine = {
  side: DiffLineSide;
  lineNumber: number;
  score: number | null;
  reason: string | null;
  mostImportantCharacterIndex: number | null;
};

type DiffLineSide = "new" | "old";

type CollectedLineContent = {
  newLines: Map<number, string>;
  oldLines: Map<number, string>;
};

const SCORE_CLAMP_MIN = 0;
const SCORE_CLAMP_MAX = 1;

const HEATMAP_TIERS = [0.2, 0.4, 0.6, 0.8] as const;

export function parseReviewHeatmap(raw: unknown): ReviewHeatmapLine[] {
  const payload = unwrapCodexPayload(raw);
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const lines = Array.isArray((payload as { lines?: unknown }).lines)
    ? ((payload as { lines: unknown[] }).lines ?? [])
    : [];

  const parsed: ReviewHeatmapLine[] = [];

  for (const entry of lines) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const lineNumber = parseLineNumber(record.line);
    const lineText =
      typeof record.line === "string" ? record.line.trim() : null;

    if (lineNumber === null && !lineText) {
      continue;
    }

    const rawScore = parseNullableNumber(record.shouldBeReviewedScore);
    const normalizedScore =
      rawScore === null
        ? null
        : clamp(rawScore, SCORE_CLAMP_MIN, SCORE_CLAMP_MAX);

    if (normalizedScore === null || normalizedScore <= 0) {
      continue;
    }

    const reason = parseNullableString(record.shouldReviewWhy);
    const mostImportantCharacterIndex = parseNullableInteger(
      record.mostImportantCharacterIndex
    );

    parsed.push({
      lineNumber,
      lineText,
      score: normalizedScore,
      reason,
      mostImportantCharacterIndex,
    });
  }

  parsed.sort((a, b) => {
    const aLine = a.lineNumber ?? Number.MAX_SAFE_INTEGER;
    const bLine = b.lineNumber ?? Number.MAX_SAFE_INTEGER;
    if (aLine !== bLine) {
      return aLine - bLine;
    }
    return (a.lineText ?? "").localeCompare(b.lineText ?? "");
  });
  return parsed;
}

export function buildDiffHeatmap(
  diff: FileData | null,
  reviewHeatmap: ReviewHeatmapLine[]
): DiffHeatmap | null {
  if (!diff || reviewHeatmap.length === 0) {
    return null;
  }

  const lineContent = collectLineContent(diff);

  const resolvedEntries = resolveLineNumbers(reviewHeatmap, lineContent);
  if (resolvedEntries.length === 0) {
    return null;
  }

  const aggregated = aggregateEntries(resolvedEntries);
  if (aggregated.size === 0) {
    return null;
  }

  const lineClasses = new Map<number, string>();
  const oldLineClasses = new Map<number, string>();
  const characterRanges: HeatmapRangeNode[] = [];
  const entries = new Map<number, ResolvedHeatmapLine>();
  const oldEntries = new Map<number, ResolvedHeatmapLine>();

  for (const entry of aggregated.values()) {
    const targetEntries = entry.side === "new" ? entries : oldEntries;
    targetEntries.set(entry.lineNumber, entry);

    const normalizedScore =
      entry.score === null
        ? null
        : clamp(entry.score, SCORE_CLAMP_MIN, SCORE_CLAMP_MAX);
    const tier = computeHeatmapTier(normalizedScore);

    if (tier > 0) {
      const targetClassMap =
        entry.side === "new" ? lineClasses : oldLineClasses;
      targetClassMap.set(entry.lineNumber, `cmux-heatmap-tier-${tier}`);
    }

    if (
      entry.side === "old" ||
      entry.mostImportantCharacterIndex === null
    ) {
      continue;
    }

    const content = lineContent.newLines.get(entry.lineNumber);
    if (!content || content.length === 0) {
      continue;
    }

    const highlightIndex = clamp(
      Math.floor(entry.mostImportantCharacterIndex),
      0,
      Math.max(content.length - 1, 0)
    );

    const charTier = tier > 0 ? tier : 1;
    const range: HeatmapRangeNode = {
      type: "span",
      lineNumber: entry.lineNumber,
      start: highlightIndex,
      length: Math.min(1, Math.max(content.length - highlightIndex, 1)),
      className: `cmux-heatmap-char cmux-heatmap-char-tier-${charTier}`,
    };
    characterRanges.push(range);
  }

  if (
    lineClasses.size === 0 &&
    oldLineClasses.size === 0 &&
    characterRanges.length === 0
  ) {
    return null;
  }

  return {
    lineClasses,
    oldLineClasses,
    newRanges: characterRanges,
    entries,
    oldEntries,
    totalEntries: aggregated.size,
  };
}

function aggregateEntries(
  entries: ResolvedHeatmapLine[]
): Map<string, ResolvedHeatmapLine> {
  const aggregated = new Map<string, ResolvedHeatmapLine>();

  for (const entry of entries) {
    const key = buildLineKey(entry.side, entry.lineNumber);
    const current = aggregated.get(key);

    if (!current) {
      aggregated.set(key, { ...entry });
      continue;
    }

    const currentScore = current.score ?? SCORE_CLAMP_MIN;
    const nextScore = entry.score ?? SCORE_CLAMP_MIN;
    const shouldReplaceScore = nextScore > currentScore;

    aggregated.set(key, {
      lineNumber: entry.lineNumber,
      side: entry.side,
      score: shouldReplaceScore ? entry.score : current.score,
      reason: entry.reason ?? current.reason,
      mostImportantCharacterIndex:
        entry.mostImportantCharacterIndex ?? current.mostImportantCharacterIndex,
    });
  }

  return aggregated;
}

function buildLineKey(side: DiffLineSide, lineNumber: number): string {
  return `${side}:${lineNumber}`;
}

function resolveLineNumbers(
  entries: ReviewHeatmapLine[],
  lineContent: CollectedLineContent
): ResolvedHeatmapLine[] {
  const resolved: ResolvedHeatmapLine[] = [];
  const { newLines, oldLines } = lineContent;
  const newLineEntries = Array.from(newLines.entries());
  const oldLineEntries = Array.from(oldLines.entries());
  const newSearchOffsets = new Map<string, number>();
  const oldSearchOffsets = new Map<string, number>();

  for (const entry of entries) {
    if (entry.score === null) {
      continue;
    }

    const directMatch = resolveDirectLineNumber(
      entry,
      lineContent
    );

    if (directMatch) {
      resolved.push({
        side: directMatch.side,
        lineNumber: directMatch.lineNumber,
        score: entry.score,
        reason: entry.reason,
        mostImportantCharacterIndex: entry.mostImportantCharacterIndex,
      });
      continue;
    }

    const normalizedTarget = normalizeLineText(entry.lineText);
    if (!normalizedTarget) {
      continue;
    }

    const newCandidate = findLineByText(
      normalizedTarget,
      newLineEntries,
      newSearchOffsets
    );
    if (newCandidate !== null) {
      resolved.push({
        side: "new",
        lineNumber: newCandidate,
        score: entry.score,
        reason: entry.reason,
        mostImportantCharacterIndex: entry.mostImportantCharacterIndex,
      });
      continue;
    }

    const oldCandidate = findLineByText(
      normalizedTarget,
      oldLineEntries,
      oldSearchOffsets
    );
    if (oldCandidate !== null) {
      resolved.push({
        side: "old",
        lineNumber: oldCandidate,
        score: entry.score,
        reason: entry.reason,
        mostImportantCharacterIndex: entry.mostImportantCharacterIndex,
      });
    }
  }

  return resolved;
}

function resolveDirectLineNumber(
  entry: ReviewHeatmapLine,
  lineContent: CollectedLineContent
): { side: DiffLineSide; lineNumber: number } | null {
  const { lineNumber } = entry;
  if (!lineNumber) {
    return null;
  }

  const { newLines, oldLines } = lineContent;
  const hasNew = newLines.has(lineNumber);
  const hasOld = oldLines.has(lineNumber);

  if (!hasNew && !hasOld) {
    return null;
  }

  if (hasNew && !hasOld) {
    return { side: "new", lineNumber };
  }

  if (!hasNew && hasOld) {
    return { side: "old", lineNumber };
  }

  const targetLooksLikeCode = isLikelyCodeFragment(entry.lineText);
  const normalizedTarget = targetLooksLikeCode
    ? normalizeLineText(entry.lineText)
    : null;

  if (targetLooksLikeCode && normalizedTarget) {
    const normalizedNew = normalizeLineText(newLines.get(lineNumber));
    const normalizedOld = normalizeLineText(oldLines.get(lineNumber));
    const matchesNew =
      normalizedTarget && normalizedNew
        ? normalizedNew === normalizedTarget ||
          normalizedNew.includes(normalizedTarget)
        : false;
    const matchesOld =
      normalizedTarget && normalizedOld
        ? normalizedOld === normalizedTarget ||
          normalizedOld.includes(normalizedTarget)
        : false;

    if (matchesNew && !matchesOld) {
      return { side: "new", lineNumber };
    }

    if (matchesOld && !matchesNew) {
      return { side: "old", lineNumber };
    }
  }

  return { side: "new", lineNumber };
}

function findLineByText(
  normalizedTarget: string,
  lineEntries: Array<[number, string]>,
  searchOffsets: Map<string, number>
): number | null {
  const entriesCount = lineEntries.length;
  const startIndex = searchOffsets.get(normalizedTarget) ?? 0;

  for (let index = startIndex; index < entriesCount; index += 1) {
    const [lineNumber, rawText] = lineEntries[index]!;
    const normalizedSource = normalizeLineText(rawText);
    if (!normalizedSource) {
      continue;
    }

    if (normalizedSource === normalizedTarget) {
      searchOffsets.set(normalizedTarget, index + 1);
      return lineNumber;
    }

    if (normalizedSource.includes(normalizedTarget)) {
      searchOffsets.set(normalizedTarget, index + 1);
      return lineNumber;
    }
  }

  searchOffsets.set(normalizedTarget, entriesCount);
  return null;
}

function normalizeLineText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value.replace(/\s+/g, " ").trim();
}

function isLikelyCodeFragment(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  return /[A-Za-z_]/.test(value);
}

function collectLineContent(diff: FileData): CollectedLineContent {
  const newLines = new Map<number, string>();
  const oldLines = new Map<number, string>();

  for (const hunk of diff.hunks) {
    for (const change of hunk.changes) {
      const newLineNumber = computeNewLineNumber(change);
      if (newLineNumber > 0) {
        newLines.set(newLineNumber, change.content ?? "");
      }

      const oldLineNumber = computeOldLineNumber(change);
      if (oldLineNumber > 0) {
        oldLines.set(oldLineNumber, change.content ?? "");
      }
    }
  }

  return {
    newLines,
    oldLines,
  };
}

function computeHeatmapTier(score: number | null): number {
  if (score === null) {
    return 0;
  }

  for (let index = HEATMAP_TIERS.length - 1; index >= 0; index -= 1) {
    if (score >= HEATMAP_TIERS[index]!) {
      return index + 1;
    }
  }

  return score > 0 ? 1 : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function parseLineNumber(value: unknown): number | null {
  const numeric = parseNullableNumber(value);
  if (numeric === null) {
    return null;
  }

  const integer = Math.floor(numeric);
  return Number.isFinite(integer) && integer > 0 ? integer : null;
}

function parseNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const match = value.match(/-?\d+(\.\d+)?/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseFloat(match[0] ?? "");
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseNullableInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const match = value.match(/-?\d+/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[0] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function unwrapCodexPayload(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return unwrapCodexPayload(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (typeof record.response === "string" || typeof record.response === "object") {
      return unwrapCodexPayload(record.response);
    }

    if (
      typeof record.payload === "string" ||
      typeof record.payload === "object"
    ) {
      return unwrapCodexPayload(record.payload);
    }

    if (Array.isArray(record.lines)) {
      return record;
    }
  }

  return null;
}
