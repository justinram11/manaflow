import { env } from "./www-env";

export const githubPrivateKey = env.CMUX_GITHUB_APP_PRIVATE_KEY?.replace(
  /\\n/g,
  "\n"
) ?? "";
