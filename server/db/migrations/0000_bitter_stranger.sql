CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`current` text NOT NULL,
	`head` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revisions` (
	`board_id` text NOT NULL,
	`n` integer NOT NULL,
	`created_at` integer NOT NULL,
	`author` text NOT NULL,
	`how` text NOT NULL,
	`target` integer,
	`summary` text NOT NULL,
	`board` text NOT NULL,
	PRIMARY KEY(`board_id`, `n`)
);
--> statement-breakpoint
CREATE INDEX `revisions_board_idx` ON `revisions` (`board_id`);