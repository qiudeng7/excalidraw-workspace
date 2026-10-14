ALTER TABLE `canvases` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `canvases` ADD `recycle_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `recycle_pending` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `canvases` ADD `purging` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `canvas_deleted_at` ON `canvases` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `canvas_recycle_pending` ON `canvases` (`recycle_pending`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `workspace_deleted_at` ON `workspaces` (`deleted_at`);