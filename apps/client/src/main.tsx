import { init } from "@sentry/react";
import { SENTRY_WEB_DSN } from "./sentry-config";
init({
  dsn: SENTRY_WEB_DSN,
  integrations: [
    /* integrations */
  ],
  /* Other Electron and React SDK config */
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
