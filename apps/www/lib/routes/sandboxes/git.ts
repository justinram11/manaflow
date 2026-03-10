import { fetchGithubUserInfoForRequest } from "@/lib/utils/githubUserInfo";
import { getDb } from "@cmux/db";
import { getCurrentBasic } from "@cmux/db/queries/users";

import type { SandboxInstance } from "./sandbox-instance";
import { singleQuote } from "./shell";

export type MorphInstance = SandboxInstance;

export const fetchGitIdentityInputs = (
  userId: string,
  githubAccessToken: string
) =>
  Promise.all([
    Promise.resolve(getCurrentBasic(getDb(), userId)),
    fetchGithubUserInfoForRequest(githubAccessToken),
  ] as const);

export const configureGitIdentity = async (
  instance: MorphInstance,
  identity: { name: string; email: string }
) => {
  const gitCfgRes = await instance.exec(
    `bash -lc "git config --global user.name ${singleQuote(identity.name)} && git config --global user.email ${singleQuote(identity.email)} && git config --global init.defaultBranch main && git config --global push.autoSetupRemote true && echo NAME:$(git config --global --get user.name) && echo EMAIL:$(git config --global --get user.email) || true"`
  );
  if (gitCfgRes.exit_code !== 0) {
    console.error(
      `[sandboxes.start] GIT CONFIG: Failed to configure git identity, exit=${gitCfgRes.exit_code}`
    );
  }
};

export const configureGitlabAccess = async (
  instance: MorphInstance,
  token: string,
) => {
  const res = await instance.exec(
    `bash -lc "git config --global credential.https://gitlab.com.helper ${singleQuote(`!f() { echo "password=${token}"; }; f`)} && git config --global credential.https://gitlab.com.username oauth2"`
  );

  if (res.exit_code !== 0) {
    const maskedError = (res.stderr || res.stdout || "Unknown error").replace(/:[^@]*@/g, ":***@");
    console.error(
      `[sandboxes.start] GIT AUTH: GitLab credential helper setup failed: exit=${res.exit_code} stderr=${maskedError.slice(0, 200)}`
    );
    throw new Error(`GitLab auth setup failed: ${maskedError.slice(0, 500)}`);
  }
};

export const configureGithubAccess = async (
  instance: MorphInstance,
  token: string,
  maxRetries = 5
) => {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const ghAuthRes = await instance.exec(
        `bash -lc "printf %s ${singleQuote(token)} | gh auth login --with-token && gh auth setup-git 2>&1"`
      );

      if (ghAuthRes.exit_code === 0) {
        return;
      }

      const errorMessage =
        ghAuthRes.stderr || ghAuthRes.stdout || "Unknown error";
      const maskedError = errorMessage.replace(/:[^@]*@/g, ":***@");
      lastError = new Error(`GitHub auth failed: ${maskedError.slice(0, 500)}`);

      console.error(
        `[sandboxes.start] GIT AUTH: Attempt ${attempt}/${maxRetries} failed: exit=${ghAuthRes.exit_code} stderr=${maskedError.slice(0, 200)}`
      );

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `[sandboxes.start] GIT AUTH: Attempt ${attempt}/${maxRetries} threw error:`,
        error
      );

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error(
    `[sandboxes.start] GIT AUTH: GitHub authentication failed after ${maxRetries} attempts`
  );
  throw new Error(
    `GitHub authentication failed after ${maxRetries} attempts: ${lastError?.message || "Unknown error"}`
  );
};
