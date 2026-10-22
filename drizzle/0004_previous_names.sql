-- Usernames people gave up: an old name's address redirects to the person's
-- new one while nobody holds it. The audit log's new action, member_renamed,
-- needs no change here, since SQLite keeps an action as plain text.
CREATE TABLE `previous_name` (
	`name` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`given_up_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
