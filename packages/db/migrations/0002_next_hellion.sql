CREATE TABLE `resourceAllocations` (
	`id` text PRIMARY KEY NOT NULL,
	`resourceProviderId` text NOT NULL,
	`taskRunId` text,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`buildDir` text,
	`simulatorUdid` text,
	`simulatorDeviceType` text,
	`simulatorRuntime` text,
	`platform` text DEFAULT 'ios' NOT NULL,
	`createdAt` integer NOT NULL,
	`releasedAt` integer
);
--> statement-breakpoint
CREATE INDEX `resourceAllocations_by_provider` ON `resourceAllocations` (`resourceProviderId`);--> statement-breakpoint
CREATE INDEX `resourceAllocations_by_taskRun` ON `resourceAllocations` (`taskRunId`);--> statement-breakpoint
CREATE INDEX `resourceAllocations_by_status` ON `resourceAllocations` (`status`);--> statement-breakpoint
CREATE INDEX `resourceAllocations_by_team` ON `resourceAllocations` (`teamId`);--> statement-breakpoint
CREATE TABLE `resourceProviders` (
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
	`maxConcurrentBuilds` integer DEFAULT 2,
	`status` text DEFAULT 'offline' NOT NULL,
	`lastHeartbeatAt` integer,
	`xcodeVersion` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `resourceProviders_by_team` ON `resourceProviders` (`teamId`);--> statement-breakpoint
CREATE INDEX `resourceProviders_by_status` ON `resourceProviders` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `resourceProviders_by_token` ON `resourceProviders` (`registrationToken`);