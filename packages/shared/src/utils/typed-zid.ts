import { z } from "zod";

// IDs are plain strings (UUIDs) in the SQLite layer.
// This helper exists for schema compatibility — it simply validates as a string.
export function typedZid(_tableName: string) {
  return z.string();
}
