CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`scopes` text DEFAULT 'openid profile email' NOT NULL,
	`icon` text,
	`enabled` integer DEFAULT true NOT NULL,
	`auto_register` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `oidc_provider_type` CHECK(`type` IN ('microsoft', 'gitlab', 'google', 'custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_provider_identity` ON `oidc_providers` (`type`, `issuer`, `client_id`);
