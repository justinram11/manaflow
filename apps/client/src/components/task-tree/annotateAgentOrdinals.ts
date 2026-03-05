import type { TaskRunWithChildren, AnnotatedTaskRun } from "./types";

/**
 * Assigns stable ordinals to agents that share a name.
 * Runs are walked twice: first to tally name frequencies, then to annotate each
 * node with its DFS order (ordinal) and a duplicate flag. Returns a tree that
 * mirrors the original structure so consumers can read from `agentOrdinal`
 * without tracking additional lookup state.
 */
export function annotateAgentOrdinals(
  runs: TaskRunWithChildren[]
): AnnotatedTaskRun[] {
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();

  const collectTotals = (items: TaskRunWithChildren[]) => {
    for (const item of items) {
      const name = item.agentName?.trim();
      if (name) {
        totals.set(name, (totals.get(name) ?? 0) + 1);
      }
      if (item.children && item.children.length > 0) {
        collectTotals(item.children);
      }
    }
  };

  collectTotals(runs);

  const annotate = (items: TaskRunWithChildren[]): AnnotatedTaskRun[] =>
    items.map((item) => {
      const name = item.agentName?.trim();
      let ordinal: number | undefined;
      if (name) {
        const next = (counts.get(name) ?? 0) + 1;
        counts.set(name, next);
        ordinal = next;
      }
      const hasDuplicate = name ? (totals.get(name) ?? 0) > 1 : false;

      return {
        ...item,
        agentOrdinal: ordinal,
        hasDuplicateAgentName: hasDuplicate,
        children:
          item.children && item.children.length > 0 ? annotate(item.children) : [],
      };
    });

  return annotate(runs);
}
