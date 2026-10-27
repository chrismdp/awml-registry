-- Systems: several workflows stored and seen together, each version with a
-- title, a Markdown description and its members, which follow their latest
-- version.
CREATE TABLE `system` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_organisation_id` text,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`visibility` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_organisation_id`) REFERENCES `organisation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "system_one_owner" CHECK(("system"."owner_user_id" IS NULL) <> ("system"."owner_organisation_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_user_slug_idx` ON `system` (`owner_user_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `system_org_slug_idx` ON `system` (`owner_organisation_id`,`slug`);--> statement-breakpoint
CREATE INDEX `system_visibility_updated_idx` ON `system` (`visibility`,`updated_at`);--> statement-breakpoint
CREATE TABLE `system_version` (
	`id` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
	`number` integer NOT NULL,
	`pushed_by` text NOT NULL,
	`pushed_at` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `system`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pushed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_version_system_number_idx` ON `system_version` (`system_id`,`number`);--> statement-breakpoint
CREATE TABLE `system_member` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`position` integer NOT NULL,
	`workflow_id` text NOT NULL,
	`owner` text NOT NULL,
	`slug` text NOT NULL,
	`owner_user_id` text,
	`owner_organisation_id` text,
	FOREIGN KEY (`version_id`) REFERENCES `system_version`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "system_member_one_owner" CHECK(("system_member"."owner_user_id" IS NULL) <> ("system_member"."owner_organisation_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `system_member_version_idx` ON `system_member` (`version_id`);--> statement-breakpoint
CREATE INDEX `system_member_workflow_idx` ON `system_member` (`workflow_id`);
