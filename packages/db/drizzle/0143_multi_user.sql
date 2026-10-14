CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`userId`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`userId`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `thread_user_state` (
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_at` integer,
	`pinned_at` integer,
	`pin_sort_key` text,
	PRIMARY KEY(`thread_id`, `user_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_user_state_user_pin_sort_idx` ON `thread_user_state` (`user_id`,`pin_sort_key`,`thread_id`) WHERE "thread_user_state"."pinned_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `user` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `pending_interactions` ADD `resolved_by_user_id` text REFERENCES `user`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `prompt_history_entries` ADD `user_id` text REFERENCES `user`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `author_user_id` text REFERENCES `user`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `threads` ADD `created_by_user_id` text REFERENCES `user`(`id`) ON DELETE set null;--> statement-breakpoint
INSERT OR IGNORE INTO `user` (`id`, `name`, `email`, `emailVerified`, `image`, `role`, `createdAt`, `updatedAt`)
VALUES ('usr_local_owner', 'Local owner', 'local-owner@bb.internal', 1, NULL, 'admin', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--> statement-breakpoint
INSERT OR IGNORE INTO `thread_user_state` (`thread_id`, `user_id`, `last_read_at`, `pinned_at`, `pin_sort_key`)
SELECT `id`, 'usr_local_owner', `last_read_at`, `pinned_at`, `pin_sort_key`
FROM `threads`
WHERE `last_read_at` IS NOT NULL OR `pinned_at` IS NOT NULL OR `pin_sort_key` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `user_settings` (`user_id`, `key`, `value_json`, `revision`, `updated_at`)
SELECT 'usr_local_owner', `key`, `value_json`, `revision`, `updated_at`
FROM `ui_preferences`;
--> statement-breakpoint
INSERT OR IGNORE INTO `user_settings` (`user_id`, `key`, `value_json`, `revision`, `updated_at`)
SELECT 'usr_local_owner', 'appearance', json_object('themeId', `theme_id`, 'faviconColor', `favicon_color`), 1, `updated_at`
FROM `app_theme`
WHERE `id` = 'current';
--> statement-breakpoint
UPDATE `threads` SET `created_by_user_id` = 'usr_local_owner' WHERE `created_by_user_id` IS NULL;
--> statement-breakpoint
UPDATE `prompt_history_entries` SET `user_id` = 'usr_local_owner' WHERE `user_id` IS NULL;
--> statement-breakpoint
UPDATE `queued_thread_messages` SET `author_user_id` = 'usr_local_owner'
WHERE `author_user_id` IS NULL AND `system_notice` IS NULL AND `sender_thread_id` IS NULL;
--> statement-breakpoint
UPDATE `pending_interactions` SET `resolved_by_user_id` = 'usr_local_owner'
WHERE `resolved_by_user_id` IS NULL AND `status` = 'resolved';
