// Use process.env directly to avoid Convex CLI scanning all env vars from convex-env module
const stackProjectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID;
if (!stackProjectId) {
  throw new Error("NEXT_PUBLIC_STACK_PROJECT_ID environment variable is required");
}

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: stackProjectId,
      issuer: `https://api.stack-auth.com/api/v1/projects/${stackProjectId}`,
      jwks: `https://api.stack-auth.com/api/v1/projects/${stackProjectId}/.well-known/jwks.json?include_anonymous=true`,
      algorithm: "ES256",
    },
    {
      type: "customJwt",
      applicationID: `${stackProjectId}:anon`,
      issuer: `https://api.stack-auth.com/api/v1/projects-anonymous-users/${stackProjectId}`,
      jwks: `https://api.stack-auth.com/api/v1/projects/${stackProjectId}/.well-known/jwks.json?include_anonymous=true`,
      algorithm: "ES256",
    },
  ],
};
