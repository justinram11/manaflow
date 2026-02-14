import { env } from "@/client-env";
import { SignInComponent } from "@/components/sign-in-component";
import { stackClientApp } from "@/lib/stack";
import { createFileRoute, redirect } from "@tanstack/react-router";
import z from "zod";

export const Route = createFileRoute("/sign-in")({
  validateSearch: z.object({
    after_auth_return_to: z.string().optional(),
  }),
  beforeLoad: async ({ search }) => {
    if (env.NEXT_PUBLIC_AUTH_MODE === "local") {
      throw redirect({ to: "/$teamSlugOrId/dashboard", params: { teamSlugOrId: "local" } });
    }
    const user = await stackClientApp.getUser();
    if (user) {
      const after_auth_redirect_to = search.after_auth_return_to || "/";
      throw redirect({ to: after_auth_redirect_to });
    }
  },
  component: SignInComponent,
});
