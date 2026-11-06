-- Drawings laid out on push and stored (issue #131), by the SHA-256 of the
-- engine's graph and the layout that made them, so no page lays one out
-- while a visitor waits.
CREATE TABLE `drawing` (
	`graph` text NOT NULL,
	`layout` text NOT NULL,
	`drawn` text NOT NULL,
	PRIMARY KEY(`graph`, `layout`)
);
