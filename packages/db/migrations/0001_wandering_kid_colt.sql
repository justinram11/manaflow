CREATE TABLE `installStates` (
	`id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`iat` integer NOT NULL,
	`exp` integer NOT NULL,
	`status` text NOT NULL,
	`createdAt` integer NOT NULL,
	`returnUrl` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installStates_by_nonce` ON `installStates` (`nonce`);--> statement-breakpoint
CREATE TABLE `pullRequests` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'github' NOT NULL,
	`installationId` integer NOT NULL,
	`repositoryId` integer,
	`repoFullName` text NOT NULL,
	`number` integer NOT NULL,
	`providerPrId` integer,
	`teamId` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`merged` integer,
	`draft` integer,
	`authorLogin` text,
	`authorId` integer,
	`htmlUrl` text,
	`baseRef` text,
	`headRef` text,
	`baseSha` text,
	`headSha` text,
	`mergeCommitSha` text,
	`createdAt` integer,
	`updatedAt` integer,
	`closedAt` integer,
	`mergedAt` integer,
	`commentsCount` integer,
	`reviewCommentsCount` integer,
	`commitsCount` integer,
	`additions` integer,
	`deletions` integer,
	`changedFiles` integer
);
--> statement-breakpoint
CREATE INDEX `pullRequests_by_team` ON `pullRequests` (`teamId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `pullRequests_by_team_state` ON `pullRequests` (`teamId`,`state`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `pullRequests_by_team_repo_number` ON `pullRequests` (`teamId`,`repoFullName`,`number`);--> statement-breakpoint
CREATE INDEX `pullRequests_by_installation` ON `pullRequests` (`installationId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `pullRequests_by_repo` ON `pullRequests` (`repoFullName`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `morphInstanceActivity` (
	`id` text PRIMARY KEY NOT NULL,
	`instanceId` text NOT NULL,
	`lastPausedAt` integer,
	`lastResumedAt` integer,
	`stoppedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `morphInstanceActivity_by_instanceId` ON `morphInstanceActivity` (`instanceId`);--> statement-breakpoint
CREATE TABLE `previewConfigs` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`createdByUserId` text,
	`repoFullName` text NOT NULL,
	`repoProvider` text,
	`repoInstallationId` integer,
	`repoDefaultBranch` text,
	`environmentId` text,
	`status` text,
	`lastRunAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `previewConfigs_by_team_repo` ON `previewConfigs` (`teamId`,`repoFullName`);--> statement-breakpoint
CREATE INDEX `previewConfigs_by_team` ON `previewConfigs` (`teamId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `previewConfigs_by_team_status` ON `previewConfigs` (`teamId`,`status`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `previewConfigs_by_environment` ON `previewConfigs` (`environmentId`);--> statement-breakpoint
CREATE INDEX `previewConfigs_by_installation_repo` ON `previewConfigs` (`repoInstallationId`,`repoFullName`);--> statement-breakpoint
CREATE TABLE `previewRuns` (
	`id` text PRIMARY KEY NOT NULL,
	`previewConfigId` text NOT NULL,
	`teamId` text NOT NULL,
	`repoFullName` text NOT NULL,
	`repoInstallationId` integer,
	`prNumber` integer NOT NULL,
	`prUrl` text NOT NULL,
	`prTitle` text,
	`prDescription` text,
	`headSha` text NOT NULL,
	`baseSha` text,
	`headRef` text,
	`headRepoFullName` text,
	`headRepoCloneUrl` text,
	`taskRunId` text,
	`status` text NOT NULL,
	`supersededBy` text,
	`stateReason` text,
	`dispatchedAt` integer,
	`startedAt` integer,
	`completedAt` integer,
	`screenshotSetId` text,
	`githubCommentUrl` text,
	`githubCommentId` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `previewRuns_by_config_status` ON `previewRuns` (`previewConfigId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `previewRuns_by_config_head` ON `previewRuns` (`previewConfigId`,`headSha`);--> statement-breakpoint
CREATE INDEX `previewRuns_by_config_pr` ON `previewRuns` (`previewConfigId`,`prNumber`,`createdAt`);--> statement-breakpoint
CREATE INDEX `previewRuns_by_config_pr_head` ON `previewRuns` (`previewConfigId`,`prNumber`,`headSha`);--> statement-breakpoint
CREATE INDEX `previewRuns_by_team_created` ON `previewRuns` (`teamId`,`createdAt`);