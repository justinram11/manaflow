CREATE TABLE `teamSettings` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`tailscaleAuthKey` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teamSettings_by_team` ON `teamSettings` (`teamId`);
