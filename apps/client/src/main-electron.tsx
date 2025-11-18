import { init } from "@sentry/electron/renderer";
import { init as reactInit } from "@sentry/react";
import { SENTRY_ELECTRON_DSN } from "./sentry-config.ts";

init(
  {
    dsn: SENTRY_ELECTRON_DSN,
    integrations: [
      /* integrations */
    ],
  },
  reactInit
);


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
