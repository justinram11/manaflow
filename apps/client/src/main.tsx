// Polyfill crypto.randomUUID for non-secure contexts (e.g., http://hostname:port via Tailscale).
// Stack Auth's StackClientApp constructor requires it, but it's only natively available
// in secure contexts (HTTPS or localhost).
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<Crypto["randomUUID"]>;
  };
}

import { init, tanstackRouterBrowserTracingIntegration } from "@sentry/react";
import { router } from "./router";
import { SENTRY_WEB_DSN } from "./sentry-config";

init({
  dsn: SENTRY_WEB_DSN,
  integrations: [tanstackRouterBrowserTracingIntegration(router)],
  // Setting a sample rate is required for sending performance data.
  // Adjust this value in production or use tracesSampler for finer control.
  tracesSampleRate: 1.0,
});

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app";

const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
