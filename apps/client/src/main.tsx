import { init } from "@sentry/react";
init({
  dsn: "https://30696b8d01b42a15ca11a60ed22a18ca@o4507547940749312.ingest.us.sentry.io/4510378034462720",
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
