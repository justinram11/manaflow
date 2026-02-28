const TEMP_ID_PREFIX = "fake-";

export function isTempId(id: string) {
  return id.startsWith(TEMP_ID_PREFIX);
}

export function createTempId() {
  return `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
}

// Backward-compatible aliases
export const isFakeConvexId = isTempId;
export const createFakeConvexId = createTempId;
