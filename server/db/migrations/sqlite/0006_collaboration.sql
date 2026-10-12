CREATE TABLE `collaboration_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shared_canvases` (
	`canvas_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`canvas_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `shared_canvas_user` ON `shared_canvases` (`user_id`);--> statement-breakpoint
ALTER TABLE `canvases` ADD `sync_mode` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `room_epoch` text;