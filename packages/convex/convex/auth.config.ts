// Use process.env directly to avoid Convex CLI scanning all env vars from convex-env module
const stackProjectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID;
const authMode = process.env.AUTH_MODE;

// Production Stack Auth project ID for CLI login via cmux.dev
const prodStackProjectId = "8a877114-b905-47c5-8b64-3a2d90679577";

// Build provider config for a Stack Auth project
function makeStackAuthProviders(projectId: string) {
  return [
    {
      type: "customJwt" as const,
      applicationID: projectId,
      issuer: `https://api.stack-auth.com/api/v1/projects/${projectId}`,
      jwks: `https://api.stack-auth.com/api/v1/projects/${projectId}/.well-known/jwks.json?include_anonymous=true`,
      algorithm: "ES256" as const,
    },
    {
      type: "customJwt" as const,
      applicationID: `${projectId}:anon`,
      issuer: `https://api.stack-auth.com/api/v1/projects-anonymous-users/${projectId}`,
      jwks: `https://api.stack-auth.com/api/v1/projects/${projectId}/.well-known/jwks.json?include_anonymous=true`,
      algorithm: "ES256" as const,
    },
  ];
}

// Port where www dev server runs locally
const wwwPort = process.env.NEXT_PUBLIC_WWW_PORT || "9779";

function buildProviders() {
  if (authMode === "local") {
    return [
      {
        type: "customJwt" as const,
        applicationID: "cmux-local-auth",
        issuer: "cmux-local-auth",
        jwks: `http://localhost:${wwwPort}/api/local-auth/.well-known/jwks.json`,
        algorithm: "ES256" as const,
      },
    ];
  }

  if (!stackProjectId) {
    return [];
  }

  return [
    // Primary Stack Auth project (from env)
    ...makeStackAuthProviders(stackProjectId),
    // Also accept production Stack Auth tokens (for devbox CLI using cmux.dev login)
    ...(stackProjectId !== prodStackProjectId ? makeStackAuthProviders(prodStackProjectId) : []),
  ];
}

export default {
  providers: buildProviders(),
};
