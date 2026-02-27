// Legacy single-user IDs — kept for backward compat with existing seeded data
export const LOCAL_USER_ID =
  "local-admin-00000000-0000-0000-0000-000000000001";
export const LOCAL_TEAM_ID =
  "local-team-00000000-0000-0000-0000-000000000001";
export const LOCAL_TEAM_SLUG = "local";

export interface LocalUserInfo {
  id: string;
  email: string;
  displayName: string;
  teamSlug: string;
  teamId: string;
}

export const LOCAL_USERS: LocalUserInfo[] = [
  {
    id: "local-user-00000000-0000-0000-0000-000000000010",
    email: "justin@getsenes.com",
    displayName: "Justin",
    teamSlug: "justin",
    teamId: "local-team-00000000-0000-0000-0000-000000000010",
  },
  {
    id: "local-user-00000000-0000-0000-0000-000000000020",
    email: "colby@getsenes.com",
    displayName: "Colby",
    teamSlug: "colby",
    teamId: "local-team-00000000-0000-0000-0000-000000000020",
  },
];

export function isLocalAuthMode(): boolean {
  return process.env.AUTH_MODE === "local";
}

export function getLocalIdentity() {
  return {
    subject: LOCAL_USER_ID,
    issuer: "cmux-local-auth",
    tokenIdentifier: `cmux-local-auth|${LOCAL_USER_ID}`,
  };
}
