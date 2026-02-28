import { AGENT_CONFIGS } from "@cmux/shared/agentConfig";
import { spawnAgent } from "../agentSpawner.ts";
import { getDb } from "../utils/dbClient.ts";
import { createTask } from "@cmux/db/mutations/tasks";

const agentConfig = AGENT_CONFIGS.find(
  (agent) => agent.name === "codex/gpt-5.1-codex-high"
);

if (!agentConfig) {
  throw new Error("Agent config not found");
}

console.log("Running with agent config:", agentConfig);

const db = getDb();
const { taskId } = createTask(db, {
  teamSlugOrId: "default",
  userId: "test-user",
  projectFullName: "manaflow-ai/manaflow",
  text: "whats the time rn?",
});

console.log("Created task:", taskId);
const result = await spawnAgent(
  agentConfig,
  taskId,
  {
    repoUrl: "https://github.com/manaflow-ai/manaflow",
    branch: "main",
    taskDescription: "whats the time rn?",
    isCloudMode: true,
  },
  "default"
);

console.log("Spawned agent:", result);
