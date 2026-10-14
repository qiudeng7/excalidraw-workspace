CREATE TABLE `canvas_sessions` (
	`canvas_id` text NOT NULL,
	`client_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`canvas_id`, `client_id`),
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `canvas_session_expiry` ON `canvas_sessions` (`expires_at`);
--> statement-breakpoint
ALTER TABLE `canvases` ADD `migration_epoch` text;