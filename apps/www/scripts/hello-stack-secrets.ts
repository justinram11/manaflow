import { env } from "@/lib/utils/www-env";
import { StackServerApp } from "@stackframe/js";

const stackAdminApp = new StackServerApp({
  tokenStore: "memory",
  projectId: env.NEXT_PUBLIC_STACK_PROJECT_ID,
  publishableClientKey: env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY,
  secretServerKey: env.STACK_SECRET_SERVER_KEY,
});
const store = await stackAdminApp.getDataVaultStore("cmux-snapshot-envs");
console.log("setting value");
await store.setValue("testing123", "a very secure cat", {
  secret: env.STACK_DATA_VAULT_SECRET ?? "",
});

console.log("getting value");
const value = await store.getValue("testing123", {
  secret: env.STACK_DATA_VAULT_SECRET ?? "",
});
console.log("value", value);
