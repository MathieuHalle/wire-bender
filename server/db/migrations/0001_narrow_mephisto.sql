CREATE TABLE `identities` (
	`provider` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`provider`, `provider_id`)
);
--> statement-breakpoint
CREATE TABLE `link_visits` (
	`user_id` text NOT NULL,
	`board_id` text NOT NULL,
	`link_id` text NOT NULL,
	`last_opened` integer NOT NULL,
	PRIMARY KEY(`user_id`, `board_id`)
);
--> statement-breakpoint
CREATE TABLE `setup` (
	`code_hash` text,
	`done_at` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`is_premium` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`suspended_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
-- Hand-edited. boards is rebuilt because SQLite can't add a NOT NULL UNIQUE column with a
-- per-row value (link_id needs a fresh UUID per existing board). No foreign keys point at it,
-- and the net effect only adds columns: every old column and row is copied unchanged.
CREATE TABLE `__new_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`current` text NOT NULL,
	`head` integer NOT NULL,
	`owner_id` text DEFAULT 'local' NOT NULL,
	`link_id` text NOT NULL,
	`visibility` text DEFAULT 'view' NOT NULL,
	`password_hash` text,
	`trashed_at` integer,
	`forked_from` text
);
--> statement-breakpoint
INSERT INTO `__new_boards` (`id`, `name`, `created_at`, `updated_at`, `current`, `head`, `link_id`)
SELECT `id`, `name`, `created_at`, `updated_at`, `current`, `head`,
	lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
FROM `boards`;
--> statement-breakpoint
DROP TABLE `boards`;
--> statement-breakpoint
ALTER TABLE `__new_boards` RENAME TO `boards`;
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_link_id_unique` ON `boards` (`link_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `users` (`id`, `name`, `is_admin`, `is_premium`, `created_at`)
VALUES ('local', 'Local', 1, 1, CAST(strftime('%s', 'now') AS integer) * 1000);
--> statement-breakpoint
ALTER TABLE `revisions` ADD `author_id` text;