export const LOCAL_USER_ID =
  "local-admin-00000000-0000-0000-0000-000000000001";
export const LOCAL_TEAM_ID =
  "local-team-00000000-0000-0000-0000-000000000001";
export const LOCAL_TEAM_SLUG = "local";

export function isLocalAuthMode(): boolean {
  return process.env.AUTH_MODE === "local";
}

export function getLocalIdentity() {
  return {
    subject: LOCAL_USER_ID,
    issuer: "local",
    tokenIdentifier: `local|${LOCAL_USER_ID}`,
  };
}
