INSERT OR IGNORE INTO `thread_user_state` (`thread_id`, `user_id`, `last_read_at`, `pinned_at`, `pin_sort_key`)
SELECT `id`, 'usr_local_owner', `last_read_at`, `pinned_at`, `pin_sort_key`
FROM `threads`
WHERE EXISTS (SELECT 1 FROM `user` WHERE `id` = 'usr_local_owner');
--> statement-breakpoint
DROP TABLE `app_theme`;--> statement-breakpoint
DROP TABLE `ui_preferences`;--> statement-breakpoint
DROP INDEX `threads_pin_sort_idx`;--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `pinned_at`;--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `pin_sort_key`;--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `last_read_at`;