import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    PORT: z
      .string()
      .transform((s) => parseInt(s, 10))
      .pipe(z.number().int().positive())
      .optional(),
    COMPUTE_PROVIDER_API_KEY: z.string().min(1),
    SANDBOX_HOST: z.string().optional(),
    INCUS_IMAGE: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
