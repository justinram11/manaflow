import { env } from "@/lib/utils/www-env";
import { StackServerApp as StackServerAppJs } from "@stackframe/js";
import { StackServerApp } from "@stackframe/stack";

const isLocalAuth = env.AUTH_MODE === "local";
const hasStackConfig = !!(env.NEXT_PUBLIC_STACK_PROJECT_ID && env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY && env.STACK_SECRET_SERVER_KEY);

function createStackServerApp(): StackServerApp<true, string> {
  if (isLocalAuth || !hasStackConfig) {
    // Return a safe stub so callers don't need null checks.
    // In local auth mode, Stack Auth features are unused.
    return {
      getUser: async () => null,
      getUsers: async () => ({ items: [], nextCursor: null }),
    } as unknown as StackServerApp<true, string>;
  }
  return new StackServerApp({
    projectId: env.NEXT_PUBLIC_STACK_PROJECT_ID!,
    publishableClientKey: env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY!,
    secretServerKey: env.STACK_SECRET_SERVER_KEY!,
    tokenStore: "nextjs-cookie",
    urls: {
      afterSignIn: "/handler/after-sign-in",
      afterSignUp: "/handler/after-sign-in",
    },
  });
}

function createStackServerAppJs(): StackServerAppJs {
  if (isLocalAuth || !hasStackConfig) {
    // Return a safe stub that returns null for getUser() so routes with
    // `if (!user) return 401` patterns gracefully handle local auth mode.
    return {
      getUser: async () => null,
      getDataVaultStore: async () => ({
        getValue: async () => null,
        setValue: async () => undefined,
      }),
    } as unknown as StackServerAppJs;
  }
  return new StackServerAppJs({
    projectId: env.NEXT_PUBLIC_STACK_PROJECT_ID!,
    publishableClientKey: env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY!,
    secretServerKey: env.STACK_SECRET_SERVER_KEY!,
    tokenStore: "cookie",
  });
}

export const stackServerApp = createStackServerApp();
export const stackServerAppJs = createStackServerAppJs();
