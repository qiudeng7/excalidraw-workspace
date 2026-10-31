CREATE TABLE `folders` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `parent_id` text,
  `name` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `deleted_at` text,
  `delete_batch_id` text,
  `purging` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX `folder_workspace_parent` ON `folders` (`workspace_id`, `parent_id`, `position`, `id`);--> statement-breakpoint
CREATE INDEX `folder_deleted_at` ON `folders` (`deleted_at`);--> statement-breakpoint
ALTER TABLE `canvases` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `canvases` ADD `delete_batch_id` text;--> statement-breakpoint
CREATE TABLE `directory_favorites` (
  `workspace_id` text NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
  `item_kind` text NOT NULL CHECK (`item_kind` IN ('folder', 'canvas')),
  `item_id` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  PRIMARY KEY (`workspace_id`, `item_kind`, `item_id`)
);--> statement-breakpoint
CREATE INDEX `directory_favorite_order` ON `directory_favorites` (`workspace_id`, `position`, `item_kind`, `item_id`);--> statement-breakpoint
INSERT INTO `directory_favorites` (`workspace_id`, `item_kind`, `item_id`, `position`)
SELECT `workspace_id`, 'canvas', `id`, row_number() OVER (PARTITION BY `workspace_id` ORDER BY `position`, `id`) - 1
FROM `canvases` WHERE `pinned` = 1 AND `deleted_at` IS NULL;
