CREATE TABLE `teamMemberships` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE INDEX `teamMemberships_by_team_user` ON `teamMemberships` (`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `teamMemberships_by_user` ON `teamMemberships` (`userId`);--> statement-breakpoint
CREATE INDEX `teamMemberships_by_team` ON `teamMemberships` (`teamId`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`slug` text,
	`displayName` text,
	`name` text,
	`profileImageUrl` text,
	`clientMetadata` text,
	`clientReadOnlyMetadata` text,
	`serverMetadata` text,
	`createdAtMillis` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_by_teamId` ON `teams` (`teamId`);--> statement-breakpoint
CREATE INDEX `teams_by_slug` ON `teams` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`primaryEmail` text,
	`primaryEmailVerified` integer,
	`primaryEmailAuthEnabled` integer,
	`displayName` text,
	`profileImageUrl` text,
	`selectedTeamId` text,
	`selectedTeamDisplayName` text,
	`selectedTeamProfileImageUrl` text,
	`hasPassword` integer,
	`otpAuthEnabled` integer,
	`passkeyAuthEnabled` integer,
	`signedUpAtMillis` integer,
	`lastActiveAtMillis` integer,
	`clientMetadata` text,
	`clientReadOnlyMetadata` text,
	`serverMetadata` text,
	`oauthProviders` text,
	`isAnonymous` integer,
	`onboardingCompletedAt` integer,
	`createdAt` integer,
	`updatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_by_userId` ON `users` (`userId`);--> statement-breakpoint
CREATE INDEX `users_by_email` ON `users` (`primaryEmail`);--> statement-breakpoint
CREATE INDEX `users_by_selected_team` ON `users` (`selectedTeamId`);--> statement-breakpoint
CREATE TABLE `taskVersions` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`version` integer NOT NULL,
	`diff` text NOT NULL,
	`summary` text NOT NULL,
	`createdAt` integer NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`files` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `taskVersions_by_task` ON `taskVersions` (`taskId`,`version`);--> statement-breakpoint
CREATE INDEX `taskVersions_by_team_user` ON `taskVersions` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`isCompleted` integer DEFAULT false,
	`isArchived` integer,
	`pinned` integer,
	`isPreview` integer,
	`isLocalWorkspace` integer,
	`isCloudWorkspace` integer,
	`linkedFromCloudTaskRunId` text,
	`description` text,
	`pullRequestTitle` text,
	`pullRequestDescription` text,
	`projectFullName` text,
	`baseBranch` text,
	`worktreePath` text,
	`generatedBranchName` text,
	`createdAt` integer,
	`updatedAt` integer,
	`lastActivityAt` integer,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`environmentId` text,
	`crownEvaluationStatus` text,
	`crownEvaluationError` text,
	`mergeStatus` text,
	`images` text,
	`screenshotStatus` text,
	`screenshotRunId` text,
	`screenshotRequestId` text,
	`screenshotRequestedAt` integer,
	`screenshotCompletedAt` integer,
	`screenshotError` text,
	`screenshotStorageId` text,
	`screenshotMimeType` text,
	`screenshotFileName` text,
	`screenshotCommitSha` text,
	`latestScreenshotSetId` text
);
--> statement-breakpoint
CREATE INDEX `tasks_by_created` ON `tasks` (`createdAt`);--> statement-breakpoint
CREATE INDEX `tasks_by_user` ON `tasks` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `tasks_by_team_user` ON `tasks` (`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `tasks_by_team_user_created` ON `tasks` (`teamId`,`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `tasks_by_pinned` ON `tasks` (`pinned`,`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `tasks_by_team_preview` ON `tasks` (`teamId`,`isPreview`);--> statement-breakpoint
CREATE INDEX `tasks_by_linked_cloud_task_run` ON `tasks` (`linkedFromCloudTaskRunId`);--> statement-breakpoint
CREATE TABLE `taskRunLogChunks` (
	`id` text PRIMARY KEY NOT NULL,
	`taskRunId` text NOT NULL,
	`content` text NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `taskRunLogChunks_by_taskRun` ON `taskRunLogChunks` (`taskRunId`);--> statement-breakpoint
CREATE INDEX `taskRunLogChunks_by_team_user` ON `taskRunLogChunks` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `taskRunPullRequests` (
	`id` text PRIMARY KEY NOT NULL,
	`taskRunId` text NOT NULL,
	`teamId` text NOT NULL,
	`repoFullName` text NOT NULL,
	`prNumber` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `taskRunPullRequests_by_task_run` ON `taskRunPullRequests` (`taskRunId`);--> statement-breakpoint
CREATE INDEX `taskRunPullRequests_by_pr` ON `taskRunPullRequests` (`teamId`,`repoFullName`,`prNumber`);--> statement-breakpoint
CREATE TABLE `taskRunScreenshotSets` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`runId` text NOT NULL,
	`status` text NOT NULL,
	`hasUiChanges` integer,
	`commitSha` text,
	`capturedAt` integer NOT NULL,
	`error` text,
	`images` text NOT NULL,
	`videos` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `taskRunScreenshotSets_by_task_capturedAt` ON `taskRunScreenshotSets` (`taskId`,`capturedAt`);--> statement-breakpoint
CREATE INDEX `taskRunScreenshotSets_by_run_capturedAt` ON `taskRunScreenshotSets` (`runId`,`capturedAt`);--> statement-breakpoint
CREATE TABLE `taskRuns` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`parentRunId` text,
	`prompt` text NOT NULL,
	`agentName` text,
	`summary` text,
	`status` text NOT NULL,
	`isArchived` integer,
	`isLocalWorkspace` integer,
	`isCloudWorkspace` integer,
	`isPreviewJob` integer,
	`log` text,
	`worktreePath` text,
	`newBranch` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`completedAt` integer,
	`exitCode` integer,
	`environmentError` text,
	`errorMessage` text,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`environmentId` text,
	`isCrowned` integer,
	`crownReason` text,
	`pullRequestUrl` text,
	`pullRequestIsDraft` integer,
	`pullRequestState` text,
	`pullRequestNumber` integer,
	`pullRequests` text,
	`diffsLastUpdated` integer,
	`screenshotStorageId` text,
	`screenshotCapturedAt` integer,
	`screenshotMimeType` text,
	`screenshotFileName` text,
	`screenshotCommitSha` text,
	`latestScreenshotSetId` text,
	`claims` text,
	`claimsGeneratedAt` integer,
	`vscode` text,
	`networking` text,
	`customPreviews` text
);
--> statement-breakpoint
CREATE INDEX `taskRuns_by_task` ON `taskRuns` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `taskRuns_by_parent` ON `taskRuns` (`parentRunId`);--> statement-breakpoint
CREATE INDEX `taskRuns_by_status` ON `taskRuns` (`status`);--> statement-breakpoint
CREATE INDEX `taskRuns_by_user` ON `taskRuns` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `taskRuns_by_team_user` ON `taskRuns` (`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `taskRuns_by_pull_request_url` ON `taskRuns` (`pullRequestUrl`);--> statement-breakpoint
CREATE TABLE `taskNotifications` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`taskRunId` text,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`message` text,
	`readAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `taskNotifications_by_team_user_created` ON `taskNotifications` (`teamId`,`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `taskNotifications_by_task` ON `taskNotifications` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `taskNotifications_by_task_user_unread` ON `taskNotifications` (`taskId`,`userId`,`readAt`);--> statement-breakpoint
CREATE TABLE `unreadTaskRuns` (
	`id` text PRIMARY KEY NOT NULL,
	`taskRunId` text NOT NULL,
	`taskId` text,
	`userId` text NOT NULL,
	`teamId` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `unreadTaskRuns_by_run_user` ON `unreadTaskRuns` (`taskRunId`,`userId`);--> statement-breakpoint
CREATE INDEX `unreadTaskRuns_by_user` ON `unreadTaskRuns` (`userId`);--> statement-breakpoint
CREATE INDEX `unreadTaskRuns_by_team_user` ON `unreadTaskRuns` (`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `unreadTaskRuns_by_task_user` ON `unreadTaskRuns` (`taskId`,`userId`);--> statement-breakpoint
CREATE TABLE `commentReplies` (
	`id` text PRIMARY KEY NOT NULL,
	`commentId` text NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`content` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `commentReplies_by_comment` ON `commentReplies` (`commentId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `commentReplies_by_user` ON `commentReplies` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `commentReplies_by_team_user` ON `commentReplies` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`page` text NOT NULL,
	`pageTitle` text NOT NULL,
	`nodeId` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`content` text NOT NULL,
	`resolved` integer,
	`archived` integer,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`profileImageUrl` text,
	`userAgent` text NOT NULL,
	`screenWidth` integer NOT NULL,
	`screenHeight` integer NOT NULL,
	`devicePixelRatio` real NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comments_by_url` ON `comments` (`url`,`createdAt`);--> statement-breakpoint
CREATE INDEX `comments_by_page` ON `comments` (`page`,`createdAt`);--> statement-breakpoint
CREATE INDEX `comments_by_user` ON `comments` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `comments_by_resolved` ON `comments` (`resolved`,`createdAt`);--> statement-breakpoint
CREATE INDEX `comments_by_team_user` ON `comments` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `taskComments` (
	`id` text PRIMARY KEY NOT NULL,
	`taskId` text NOT NULL,
	`content` text NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `taskComments_by_task` ON `taskComments` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `taskComments_by_team_task` ON `taskComments` (`teamId`,`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `taskComments_by_team_user` ON `taskComments` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `environmentSnapshotVersions` (
	`id` text PRIMARY KEY NOT NULL,
	`environmentId` text NOT NULL,
	`teamId` text NOT NULL,
	`morphSnapshotId` text NOT NULL,
	`incusSnapshotId` text,
	`firecrackerSnapshotId` text,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`createdByUserId` text NOT NULL,
	`label` text,
	`maintenanceScript` text,
	`devScript` text
);
--> statement-breakpoint
CREATE INDEX `environmentSnapshotVersions_by_environment_version` ON `environmentSnapshotVersions` (`environmentId`,`version`);--> statement-breakpoint
CREATE INDEX `environmentSnapshotVersions_by_environment_createdAt` ON `environmentSnapshotVersions` (`environmentId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `environmentSnapshotVersions_by_team_createdAt` ON `environmentSnapshotVersions` (`teamId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `environmentSnapshotVersions_by_team_snapshot` ON `environmentSnapshotVersions` (`teamId`,`morphSnapshotId`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`morphSnapshotId` text NOT NULL,
	`dataVaultKey` text NOT NULL,
	`selectedRepos` text,
	`description` text,
	`maintenanceScript` text,
	`devScript` text,
	`exposedPorts` text,
	`provider` text,
	`incusSnapshotId` text,
	`firecrackerSnapshotId` text,
	`firecrackerVmSize` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `environments_by_team` ON `environments` (`teamId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `environments_by_team_user` ON `environments` (`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `environments_by_dataVaultKey` ON `environments` (`dataVaultKey`);--> statement-breakpoint
CREATE TABLE `apiKeys` (
	`id` text PRIMARY KEY NOT NULL,
	`envVar` text NOT NULL,
	`value` text NOT NULL,
	`displayName` text NOT NULL,
	`description` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `apiKeys_by_envVar` ON `apiKeys` (`envVar`);--> statement-breakpoint
CREATE INDEX `apiKeys_by_team_user` ON `apiKeys` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `containerSettings` (
	`id` text PRIMARY KEY NOT NULL,
	`maxRunningContainers` integer,
	`reviewPeriodMinutes` integer,
	`autoCleanupEnabled` integer,
	`stopImmediatelyOnCompletion` integer,
	`minContainersToKeep` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `containerSettings_by_team_user` ON `containerSettings` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `userEditorSettings` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`settingsJson` text,
	`keybindingsJson` text,
	`snippets` text,
	`extensions` text,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `userEditorSettings_by_team_user` ON `userEditorSettings` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `workspaceConfigs` (
	`id` text PRIMARY KEY NOT NULL,
	`projectFullName` text NOT NULL,
	`maintenanceScript` text,
	`dataVaultKey` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspaceConfigs_by_team_user_repo` ON `workspaceConfigs` (`teamId`,`userId`,`projectFullName`);--> statement-breakpoint
CREATE TABLE `workspaceSettings` (
	`id` text PRIMARY KEY NOT NULL,
	`worktreePath` text,
	`autoPrEnabled` integer,
	`autoSyncEnabled` integer,
	`nextLocalWorkspaceSequence` integer,
	`heatmapModel` text,
	`heatmapThreshold` real,
	`heatmapTooltipLanguage` text,
	`heatmapColors` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaceSettings_by_team_user` ON `workspaceSettings` (`teamId`,`userId`);--> statement-breakpoint
CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`repo` text NOT NULL,
	`repoId` text,
	`name` text NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`lastCommitSha` text,
	`lastActivityAt` integer,
	`lastKnownBaseSha` text,
	`lastKnownMergeCommitSha` text
);
--> statement-breakpoint
CREATE INDEX `branches_by_repo` ON `branches` (`repo`);--> statement-breakpoint
CREATE INDEX `branches_by_repoId` ON `branches` (`repoId`);--> statement-breakpoint
CREATE INDEX `branches_by_team_user` ON `branches` (`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `branches_by_team` ON `branches` (`teamId`);--> statement-breakpoint
CREATE TABLE `providerConnections` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text,
	`connectedByUserId` text,
	`type` text DEFAULT 'github_app' NOT NULL,
	`installationId` integer NOT NULL,
	`accountLogin` text,
	`accountId` integer,
	`accountType` text,
	`isActive` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `providerConnections_by_installationId` ON `providerConnections` (`installationId`);--> statement-breakpoint
CREATE INDEX `providerConnections_by_team` ON `providerConnections` (`teamId`);--> statement-breakpoint
CREATE INDEX `providerConnections_by_team_type` ON `providerConnections` (`teamId`,`type`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`fullName` text NOT NULL,
	`org` text NOT NULL,
	`name` text NOT NULL,
	`gitRemote` text NOT NULL,
	`provider` text,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`providerRepoId` integer,
	`ownerLogin` text,
	`ownerType` text,
	`visibility` text,
	`defaultBranch` text,
	`connectionId` text,
	`lastSyncedAt` integer,
	`lastPushedAt` integer,
	`manual` integer,
	`incusSnapshotId` text
);
--> statement-breakpoint
CREATE INDEX `repos_by_org` ON `repos` (`org`);--> statement-breakpoint
CREATE INDEX `repos_by_gitRemote` ON `repos` (`gitRemote`);--> statement-breakpoint
CREATE INDEX `repos_by_team_user` ON `repos` (`teamId`,`userId`);--> statement-breakpoint
CREATE INDEX `repos_by_team` ON `repos` (`teamId`);--> statement-breakpoint
CREATE INDEX `repos_by_team_fullName` ON `repos` (`teamId`,`fullName`);--> statement-breakpoint
CREATE TABLE `warmPool` (
	`id` text PRIMARY KEY NOT NULL,
	`instanceId` text NOT NULL,
	`snapshotId` text NOT NULL,
	`status` text NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`repoUrl` text,
	`branch` text,
	`vscodeUrl` text,
	`workerUrl` text,
	`claimedAt` integer,
	`claimedByTaskRunId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`errorMessage` text
);
--> statement-breakpoint
CREATE INDEX `warmPool_by_status` ON `warmPool` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `warmPool_by_instanceId` ON `warmPool` (`instanceId`);--> statement-breakpoint
CREATE INDEX `warmPool_by_team_status` ON `warmPool` (`teamId`,`status`,`createdAt`);