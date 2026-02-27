import { env } from "@/client-env";
import { ConvexQueryClient } from "@convex-dev/react-query";

export const convexQueryClient = new ConvexQueryClient(
  env.NEXT_PUBLIC_CONVEX_URL,
  {
    // In local mode, Convex can't validate JWTs (cloud can't reach localhost JWKS),
    // so don't wait for auth. The www API validates JWTs directly.
    expectAuth: env.NEXT_PUBLIC_AUTH_MODE !== "local",
  }
);
