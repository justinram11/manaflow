import { useStackApp } from "@stackframe/react";
import { RouterProvider } from "@tanstack/react-router";
import { isLocalAuth } from "./lib/stack";
import { queryClient } from "./query-client";
import { router } from "./router";

function useAuth() {
  if (isLocalAuth) {
    return null;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- conditional is stable (env-based, never changes at runtime)
  return useStackApp();
}

export function RouterProviderWithAuth() {
  const auth = useAuth();
  return <RouterProvider router={router} context={{ queryClient, auth }} />;
}
