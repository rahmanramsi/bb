CREATE TABLE `plugin_caller_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`user_id` text NOT NULL,
	`max_role` text NOT NULL,
	`purpose` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plugin_caller_grants_user_idx` ON `plugin_caller_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `plugin_caller_grants_plugin_idx` ON `plugin_caller_grants` (`plugin_id`);