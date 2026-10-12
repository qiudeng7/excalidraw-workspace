import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const settings = sqliteTable(
  "settings",
  {
    id: integer().primaryKey(),
    registrationEnabled: integer("registration_enabled").notNull().default(1),
  },
  (table) => [check("settings_singleton", sql`${table.id} = 1`)],
);

export const users = sqliteTable(
  "users",
  {
    id: text().primaryKey(),
    email: text().notNull().unique(),
    name: text().notNull(),
    role: text({ enum: ["admin", "user"] }).notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("users_role", sql`${table.role} IN ('admin', 'user')`),
    uniqueIndex("one_administrator")
      .on(table.role)
      .where(sql`${table.role} = 'admin'`),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("sessions_expiry").on(table.expiresAt)],
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    catalogRevision: integer("catalog_revision").notNull().default(0),
  },
  (table) => [index("workspace_owner").on(table.userId)],
);

export const canvases = sqliteTable(
  "canvases",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    revision: integer().notNull().default(0),
    objectKey: text("object_key"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    position: integer().notNull().default(0),
  },
  (table) => [
    index("canvas_workspace").on(table.workspaceId),
    index("canvas_position").on(table.workspaceId, table.position, table.id),
    index("canvas_object_key").on(table.objectKey),
  ],
);

export const libraries = sqliteTable(
  "libraries",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: integer().notNull().default(0),
    objectKey: text("object_key"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("library_object_key").on(table.objectKey)],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text().primaryKey(),
    count: integer().notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("rate_limit_expiry").on(table.expiresAt)],
);

export const userNavigation = sqliteTable("user_navigation", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  lastWorkspaceId: text("last_workspace_id").references(() => workspaces.id, {
    onDelete: "set null",
  }),
  lastCanvasId: text("last_canvas_id").references(() => canvases.id, {
    onDelete: "set null",
  }),
  revision: integer().notNull().default(0),
});

export const workspaceNavigation = sqliteTable(
  "workspace_navigation",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    lastCanvasId: text("last_canvas_id").references(() => canvases.id, {
      onDelete: "set null",
    }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.workspaceId] })],
);

export const userSettings = sqliteTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    settingsJson: text("settings_json").notNull(),
    revision: integer().notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [check("user_settings_revision", sql`${table.revision} >= 1`)],
);
