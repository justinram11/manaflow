import { env } from "@/client-env";
import { LocalSignInForm } from "@/components/local-sign-in-form";
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
      // If already logged in, redirect to their team dashboard
      const jwt = localStorage.getItem("cmux-local-jwt");
      if (jwt) {
        const userJson = localStorage.getItem("cmux-local-user");
        if (userJson) {
          const user = JSON.parse(userJson) as { teamSlug: string };
          throw redirect({
            to: "/$teamSlugOrId/dashboard",
            params: { teamSlugOrId: user.teamSlug },
          });
        }
      }
      // Otherwise, show the login form (component below)
      return;
    }
    const user = await stackClientApp.getUser();
    if (user) {
      const after_auth_redirect_to = search.after_auth_return_to || "/";
      throw redirect({ to: after_auth_redirect_to });
    }
  },
  component: SignInPage,
});

function SignInPage() {
  if (env.NEXT_PUBLIC_AUTH_MODE === "local") {
    return <LocalSignInForm />;
  }
  return <SignInComponent />;
}
