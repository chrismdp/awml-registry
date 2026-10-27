-- Each ref a version's file holds to another workflow's part, as
-- owner/slug#id, so a workflow's page can list the workflows that refer to it.
CREATE TABLE `workflow_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`part` text NOT NULL,
	`target_owner` text NOT NULL,
	`target_slug` text NOT NULL,
	`target_part` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_ref_target_idx` ON `workflow_ref` (`target_owner`,`target_slug`);--> statement-breakpoint
CREATE INDEX `workflow_ref_version_idx` ON `workflow_ref` (`version_id`);
