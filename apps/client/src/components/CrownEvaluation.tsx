interface CrownEvaluationProps {
  taskId: string;
  teamSlugOrId: string;
}

export function CrownEvaluation({
  taskId: _taskId,
  teamSlugOrId: _teamSlugOrId,
}: CrownEvaluationProps) {
  // TODO: Replace with HTTP API when available (api.crown.getCrownEvaluation, api.crown.getCrownedRun)
  // Crown evaluation endpoints are not yet available in the HTTP API.
  // Returning null to hide the component until the endpoints are implemented.
  return null;
}
