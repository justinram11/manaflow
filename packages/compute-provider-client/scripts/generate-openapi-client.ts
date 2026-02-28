import { app } from "@cmux/compute-provider/app";
import { createClient } from "@hey-api/openapi-ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quiet = !!process.env.CLAUDECODE;
const log = quiet ? () => {} : console.log.bind(console);

const startTime = performance.now();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fetchStart = performance.now();
const doc = await app.request("/api/doc", {
  method: "GET",
});
log(`[${(performance.now() - fetchStart).toFixed(2)}ms] fetch /api/doc`);

const outputPath = path.join(__dirname, "../src/client");

// write to tmp file
const tmpFile = path.join(
  os.tmpdir(),
  `compute-provider-openapi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
);
fs.writeFileSync(tmpFile, await doc.text());

const genStart = performance.now();
await createClient({
  input: tmpFile,
  output: {
    path: outputPath,
  },
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/typescript",
  ],
  logs: quiet ? { level: "silent" } : undefined,
});
log(`[${(performance.now() - genStart).toFixed(2)}ms] generate client`);

// Post-process: Remove .js extensions from imports for compatibility
const postStart = performance.now();
const removeJsExtensions = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeJsExtensions(fullPath);
    } else if (entry.name.endsWith(".ts")) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const updated = content.replace(
        /from\s+(['"])(.+?)\.js\1/g,
        "from $1$2$1",
      );
      if (content !== updated) {
        fs.writeFileSync(fullPath, updated);
      }
    }
  }
};
removeJsExtensions(outputPath);
log(`[${(performance.now() - postStart).toFixed(2)}ms] post-process imports`);

try {
  fs.unlinkSync(tmpFile);
} catch {
  // ignore
}

log(`[${(performance.now() - startTime).toFixed(2)}ms] generate-openapi-client complete`);
console.log("[compute-provider-client] client generation complete");
