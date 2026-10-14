CREATE TABLE `turn_request_authors` (
	`thread_id` text NOT NULL,
	`request_id` text NOT NULL,
	`author_user_id` text,
	`author_role_ceiling` text,
	PRIMARY KEY(`thread_id`, `request_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
