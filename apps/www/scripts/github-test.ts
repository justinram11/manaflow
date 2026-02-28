/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck - Legacy script, uses removed Convex APIs
import { githubPrivateKey } from "@/lib/utils/githubPrivateKey";
import { env } from "@/lib/utils/www-env";
import { api } from "@cmux/convex/api";
import { createAppAuth } from "@octokit/auth-app";
import { StackAdminApp } from "@stackframe/js";
import { ConvexHttpClient } from "convex/browser";
import { Octokit } from "octokit";

const stackAdminApp = new StackAdminApp({
  tokenStore: "memory",
  projectId: env.NEXT_PUBLIC_STACK_PROJECT_ID,
  publishableClientKey: env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY,
  secretServerKey: env.STACK_SECRET_SERVER_KEY,
  superSecretAdminKey: env.STACK_SUPER_SECRET_ADMIN_KEY,
});

const user = await stackAdminApp.getUser(
  "487b5ddc-0da0-4f12-8834-f452863a83f5"
);

if (!user) {
  throw new Error("User not found");
}

const session = await user.createSession({ expiresInMillis: 10_000_000 });
const stackAuthTokens = await session.getTokens();

const stackAuthToken = stackAuthTokens.accessToken;
if (!stackAuthToken) {
  throw new Error("Token not found");
}

const url = "https://polite-canary-804.convex.cloud";

const client = new ConvexHttpClient(url);
client.setAuth(stackAuthToken);

const result = await client.query(api.github.listProviderConnections, {
  teamSlugOrId: "manaflow",
});

console.log(result);

// For each provider connection (GitHub App installation), use an installation token
// so private repos are included. Do NOT use the user's OAuth token here.
const appId = env.CMUX_GITHUB_APP_ID;

await Promise.all(
  result
    .filter((c) => c.isActive)
    .map(async (connection) => {
      if (!connection.installationId) {
        throw new Error("Missing installationId for connection");
      }

      // Create an Octokit client authenticated as the app installation
      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId,
          privateKey: githubPrivateKey,
          installationId: connection.installationId,
        },
      });

      // List repositories accessible to this installation (includes private)
      try {
        const { data } = await octokit.request(
          "GET /installation/repositories",
          { per_page: 100 }
        );

        const repos = data.repositories.map((r) => ({
          name: r.name,
          full_name: r.full_name,
          private: r.private,
        }));

        console.log(repos);
      } catch (err) {
        const e = err as { status?: number; message?: string };
        console.error(
          `Failed to list repos for installation ${connection.installationId} (${connection.accountLogin ?? "unknown"})`,
          e
        );
      }
    })
);
