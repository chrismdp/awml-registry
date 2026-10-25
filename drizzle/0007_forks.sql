-- A fork's source: the id of the version it was copied from. Not a foreign
-- key, so a fork whose original is deleted still says it is a fork.
ALTER TABLE `workflow` ADD `forked_from` text;--> statement-breakpoint
CREATE INDEX `workflow_forked_from_idx` ON `workflow` (`forked_from`);
