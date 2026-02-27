import { SignJWT, importJWK } from "jose";

// Static ECDSA P-256 key pair for local dev use only.
// These are NOT secret — they exist solely to let Convex validate JWTs via JWKS
// in AUTH_MODE=local without an external identity provider.
const PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
  d: "jpsQnnGQmL-YBIffS1BSyVKhrlRhMTpIRNH0t2duouc",
  kid: "cmux-local-1",
} as const;

const PUBLIC_JWK = {
  kty: PRIVATE_JWK.kty,
  crv: PRIVATE_JWK.crv,
  x: PRIVATE_JWK.x,
  y: PRIVATE_JWK.y,
  kid: PRIVATE_JWK.kid,
  use: "sig",
  alg: "ES256",
} as const;

export const LOCAL_AUTH_ISSUER = "cmux-local-auth";
export const LOCAL_AUTH_AUDIENCE = "convex";

export interface LocalUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
  teamSlug: string;
  teamId: string;
}

export const LOCAL_USERS: LocalUser[] = [
  {
    id: "local-user-00000000-0000-0000-0000-000000000010",
    email: "justin@getsenes.com",
    password: "password",
    displayName: "Justin",
    teamSlug: "justin",
    teamId: "local-team-00000000-0000-0000-0000-000000000010",
  },
  {
    id: "local-user-00000000-0000-0000-0000-000000000020",
    email: "colby@getsenes.com",
    password: "password",
    displayName: "Colby",
    teamSlug: "colby",
    teamId: "local-team-00000000-0000-0000-0000-000000000020",
  },
];

let _privateKey: CryptoKey | null = null;

async function getPrivateKey(): Promise<CryptoKey> {
  if (!_privateKey) {
    const key = await importJWK(PRIVATE_JWK, "ES256");
    if (!(key instanceof CryptoKey)) {
      throw new Error("Expected CryptoKey from importJWK");
    }
    _privateKey = key;
  }
  return _privateKey;
}

export async function mintLocalJwt(userId: string): Promise<string> {
  const user = LOCAL_USERS.find((u) => u.id === userId);
  const key = await getPrivateKey();

  return new SignJWT({
    sub: userId,
    email: user?.email,
    name: user?.displayName,
  })
    .setProtectedHeader({ alg: "ES256", kid: PRIVATE_JWK.kid })
    .setIssuer(LOCAL_AUTH_ISSUER)
    .setAudience(LOCAL_AUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

export function getLocalJwks() {
  return {
    keys: [exportJWK_sync()],
  };
}

// Synchronous export since the public JWK is a static literal (no async import needed)
function exportJWK_sync() {
  return { ...PUBLIC_JWK };
}
