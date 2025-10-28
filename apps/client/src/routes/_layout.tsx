import { convexAuthReadyPromise } from "@/contexts/convex/convex-auth-ready";
import { ConvexClientProvider } from "@/contexts/convex/convex-client-provider";
import { RealSocketProvider } from "@/contexts/socket/real-socket-provider";
import { cachedGetUser } from "@/lib/cachedGetUser";
import { stackClientApp } from "@/lib/stack";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  localVSCodeServeWebQueryOptions,
  useLocalVSCodeServeWebQuery,
} from "@/queries/local-vscode-serve-web";

export const Route = createFileRoute("/_layout")({
  component: Layout,
  beforeLoad: async ({ context }) => {
    const user = await cachedGetUser(stackClientApp);
    if (!user) {
      throw redirect({
        to: "/sign-in",
        search: {
          after_auth_return_to: location.pathname,
        },
      });
    }
    const convexAuthReady = await convexAuthReadyPromise;
    if (!convexAuthReady) {
      console.log("[Route.beforeLoad] convexAuthReady:", convexAuthReady);
    }
    void context.queryClient
      .ensureQueryData(localVSCodeServeWebQueryOptions())
      .catch(() => undefined);
  },
});

function Layout() {
  useLocalVSCodeServeWebQuery();
  return (
    <ConvexClientProvider>
      <RealSocketProvider>
        <Outlet />
      </RealSocketProvider>
    </ConvexClientProvider>
  );
}
