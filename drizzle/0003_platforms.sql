CREATE TABLE `platform` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text,
	`owner_organisation_id` text,
	`slug` text NOT NULL,
	`label` text NOT NULL,
	`visibility` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_organisation_id`) REFERENCES `organisation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "platform_one_owner" CHECK(("platform"."owner_user_id" IS NULL) <> ("platform"."owner_organisation_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_user_slug_idx` ON `platform` (`owner_user_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_org_slug_idx` ON `platform` (`owner_organisation_id`,`slug`);--> statement-breakpoint
CREATE INDEX `platform_visibility_updated_idx` ON `platform` (`visibility`,`updated_at`);--> statement-breakpoint
CREATE TABLE `platform_version` (
	`id` text PRIMARY KEY NOT NULL,
	`platform_id` text NOT NULL,
	`number` integer NOT NULL,
	`pushed_by` text NOT NULL,
	`pushed_at` integer NOT NULL,
	`description` text NOT NULL,
	`recipe` text,
	FOREIGN KEY (`platform_id`) REFERENCES `platform`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pushed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_version_platform_number_idx` ON `platform_version` (`platform_id`,`number`);