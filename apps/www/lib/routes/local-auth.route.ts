import {
  LOCAL_USERS,
  getLocalJwks,
  mintLocalJwt,
  LOCAL_AUTH_ISSUER,
} from "@/lib/utils/local-jwt";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { decodeJwt } from "jose";
import { z } from "zod";

export const localAuthRouter = new OpenAPIHono();

// POST /local-auth/login
localAuthRouter.openapi(
  createRoute({
    method: "post",
    path: "/local-auth/login",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              email: z.string().email(),
              password: z.string(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Login successful",
        content: {
          "application/json": {
            schema: z.object({
              token: z.string(),
              user: z.object({
                id: z.string(),
                email: z.string(),
                displayName: z.string(),
                teamSlug: z.string(),
                teamId: z.string(),
              }),
            }),
          },
        },
      },
      401: {
        description: "Invalid credentials",
      },
    },
  }),
  async (c) => {
    const { email, password } = c.req.valid("json");
    const user = LOCAL_USERS.find(
      (u) => u.email === email && u.password === password
    );

    if (!user) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const token = await mintLocalJwt(user.id);

    return c.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        teamSlug: user.teamSlug,
        teamId: user.teamId,
      },
    });
  }
);

// POST /local-auth/refresh
localAuthRouter.openapi(
  createRoute({
    method: "post",
    path: "/local-auth/refresh",
    responses: {
      200: {
        description: "Token refreshed",
        content: {
          "application/json": {
            schema: z.object({
              token: z.string(),
            }),
          },
        },
      },
      401: {
        description: "Invalid or missing token",
      },
    },
  }),
  async (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing bearer token" }, 401);
    }

    const rawToken = authHeader.slice(7);
    try {
      const claims = decodeJwt(rawToken);
      if (claims.iss !== LOCAL_AUTH_ISSUER || !claims.sub) {
        return c.json({ error: "Invalid token" }, 401);
      }

      const user = LOCAL_USERS.find((u) => u.id === claims.sub);
      if (!user) {
        return c.json({ error: "Unknown user" }, 401);
      }

      const token = await mintLocalJwt(user.id);
      return c.json({ token });
    } catch (e) {
      console.error("Token refresh failed:", e);
      return c.json({ error: "Invalid token" }, 401);
    }
  }
);

// GET /local-auth/.well-known/jwks.json
localAuthRouter.openapi(
  createRoute({
    method: "get",
    path: "/local-auth/.well-known/jwks.json",
    responses: {
      200: {
        description: "JWKS public keys",
      },
    },
  }),
  (c) => {
    return c.json(getLocalJwks());
  }
);
