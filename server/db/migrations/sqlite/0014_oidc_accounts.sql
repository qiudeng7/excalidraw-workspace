ALTER TABLE `users` ADD `provider` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `issuer` text;--> statement-breakpoint
ALTER TABLE `users` ADD `subject` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_identity` ON `users` (`provider`, `issuer`, `subject`);
