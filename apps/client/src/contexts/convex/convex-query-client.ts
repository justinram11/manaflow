import { env } from "@/client-env";
import { ConvexQueryClient } from "@convex-dev/react-query";

export const convexQueryClient = new ConvexQueryClient(
  env.NEXT_PUBLIC_CONVEX_URL,
  {
    // Always expect auth — local mode now uses real JWTs
    expectAuth: true,
  }
);
