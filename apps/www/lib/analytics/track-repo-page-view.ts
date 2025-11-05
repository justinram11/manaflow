import { PostHog } from "posthog-node";

function PostHogClient() {
  return new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
    host: "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  });
}

type RepoPageViewEvent = {
  repo: string;
  pageType: "pull_request" | "comparison";
  pullNumber?: number;
  comparison?: string;
  userId?: string;
};

export async function trackRepoPageView(
  event: RepoPageViewEvent
): Promise<void> {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    console.warn("[analytics] PostHog client not initialized - missing API key");
    return;
  }

  const posthog = PostHogClient();

  try {
    posthog.capture({
      distinctId: event.userId ?? "anonymous",
      event: "repo_page_viewed",
      properties: {
        repo: event.repo,
        page_type: event.pageType,
        pull_number: event.pullNumber,
        comparison: event.comparison,
      },
    });

    await posthog.shutdown();
  } catch (error) {
    console.error("[analytics] Failed to track repo page view", error);
  }
}
