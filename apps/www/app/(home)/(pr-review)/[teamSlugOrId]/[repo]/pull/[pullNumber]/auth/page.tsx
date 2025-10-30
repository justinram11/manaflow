import { redirect } from "next/navigation";
import { isRepoPublic } from "@/lib/github/check-repo-visibility";
import { stackServerApp } from "@/lib/utils/stack";
import { PublicRepoAnonymousPrompt } from "../../../_components/public-repo-anonymous-prompt";
import { PrivateRepoPrompt } from "../../../_components/private-repo-prompt";
import { AnonymousToSignInPrompt } from "../../../_components/anonymous-to-signin-prompt";
import { env } from "@/lib/utils/www-env";

type PageParams = {
  teamSlugOrId: string;
  repo: string;
  pullNumber: string;
};

type PageProps = {
  params: Promise<PageParams>;
};

function parsePullNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const numericValue = Number.parseInt(raw, 10);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return numericValue;
}

export default async function AuthPage({ params }: PageProps) {
  const resolvedParams = await params;
  const {
    teamSlugOrId: githubOwner,
    repo,
    pullNumber: pullNumberRaw,
  } = resolvedParams;

  const pullNumber = parsePullNumber(pullNumberRaw);
  if (pullNumber === null) {
    redirect(`/${githubOwner}/${repo}/pull/${pullNumberRaw}`);
  }

  // Check if repository is public
  const repoIsPublic = await isRepoPublic(githubOwner, repo);

  // For private repos, use Stack Auth's automatic redirect for non-authenticated users
  // For public repos, allow anonymous users by using return-null
  const user = await stackServerApp.getUser({
    or: repoIsPublic ? "return-null" : "redirect"
  });

  // For private repos with anonymous users (no email), show sign-in prompt
  // Stack Auth's "redirect" may not catch anonymous users since they have valid sessions
  if (!repoIsPublic && user && !user.primaryEmail) {
    console.log("[AuthPage] Anonymous user attempting private repo, showing sign-in prompt");
    return (
      <AnonymousToSignInPrompt
        returnUrl={`/${githubOwner}/${repo}/pull/${pullNumber}`}
      />
    );
  }

  // If user exists and has email, they're authenticated - redirect back to PR page
  if (user && user.primaryEmail) {
    console.log("[AuthPage] User already authenticated, redirecting to PR page");
    redirect(`/${githubOwner}/${repo}/pull/${pullNumber}`);
  }

  // For public repos with anonymous users or no user, show anonymous auth prompt
  if (repoIsPublic) {
    return (
      <PublicRepoAnonymousPrompt
        teamSlugOrId={githubOwner}
        repo={repo}
        githubOwner={githubOwner}
        pullNumber={pullNumber}
      />
    );
  }

  // For private repos, if we got here, user is authenticated (Stack Auth handled redirect)
  // Show GitHub app install prompt
  return (
    <PrivateRepoPrompt
      teamSlugOrId={githubOwner}
      repo={repo}
      githubOwner={githubOwner}
      githubAppSlug={env.NEXT_PUBLIC_GITHUB_APP_SLUG}
    />
  );
}
