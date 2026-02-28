CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`registrationToken` text NOT NULL,
	`platform` text NOT NULL,
	`arch` text NOT NULL,
	`osVersion` text,
	`hostname` text,
	`capabilities` text,
	`maxConcurrentSlots` integer DEFAULT 4,
	`status` text DEFAULT 'offline' NOT NULL,
	`lastHeartbeatAt` integer,
	`metadata` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `providers_by_team` ON `providers` (`teamId`);--> statement-breakpoint
CREATE INDEX `providers_by_status` ON `providers` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `providers_by_token` ON `providers` (`registrationToken`);--> statement-breakpoint
CREATE TABLE `providerAllocations` (
	`id` text PRIMARY KEY NOT NULL,
	`providerId` text NOT NULL,
	`taskRunId` text,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`data` text,
	`createdAt` integer NOT NULL,
	`releasedAt` integer
);
--> statement-breakpoint
CREATE INDEX `providerAllocations_by_provider` ON `providerAllocations` (`providerId`);--> statement-breakpoint
CREATE INDEX `providerAllocations_by_taskRun` ON `providerAllocations` (`taskRunId`);--> statement-breakpoint
CREATE INDEX `providerAllocations_by_status` ON `providerAllocations` (`status`);--> statement-breakpoint
CREATE INDEX `providerAllocations_by_team` ON `providerAllocations` (`teamId`);--> statement-breakpoint
CREATE TABLE `providerSnapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`providerId` text NOT NULL,
	`teamId` text NOT NULL,
	`externalId` text NOT NULL,
	`name` text NOT NULL,
	`stateful` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `providerSnapshots_by_provider` ON `providerSnapshots` (`providerId`);--> statement-breakpoint
CREATE INDEX `providerSnapshots_by_team` ON `providerSnapshots` (`teamId`);--> statement-breakpoint
ALTER TABLE `environments` ADD `providerId` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `snapshotId` text;--> statement-breakpoint
ALTER TABLE `environmentSnapshotVersions` ADD `snapshotId` text;--> statement-breakpoint
DROP TABLE IF EXISTS `resourceAllocations`;--> statement-breakpoint
DROP TABLE IF EXISTS `resourceProviders`;
