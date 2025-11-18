import { init } from "@sentry/electron/renderer";
import { init as reactInit } from "@sentry/react";

init(
  {
    dsn: "https://6112bebb24a138e3efe0faee803521fe@o4507547940749312.ingest.us.sentry.io/4510383103344640",
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
