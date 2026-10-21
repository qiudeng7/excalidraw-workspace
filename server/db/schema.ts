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
    deleting: integer().notNull().default(0),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("workspace_owner").on(table.userId),
    index("workspace_deleted_at").on(table.deletedAt),
  ],
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
    syncMode: text("sync_mode", {
      enum: ["legacy", "preparing", "collaborative"],
    })
      .notNull()
      .default("legacy"),
    roomEpoch: text("room_epoch"),
    migrationEpoch: text("migration_epoch"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    position: integer().notNull().default(0),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    deletedAt: text("deleted_at"),
    recycleRevision: integer("recycle_revision").notNull().default(0),
    recyclePending: integer("recycle_pending").notNull().default(0),
    purging: integer().notNull().default(0),
  },
  (table) => [
    index("canvas_workspace").on(table.workspaceId),
    index("canvas_position").on(table.workspaceId, table.position, table.id),
    index("canvas_active_catalog")
      .on(
        table.workspaceId,
        sql`${table.pinned} DESC`,
        table.position,
        table.id,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("canvas_object_key").on(table.objectKey),
    index("canvas_deleted_at").on(table.deletedAt),
    index("canvas_recycle_pending").on(table.recyclePending),
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

// Node's authoritative rooms. Cloudflare stores these in each CanvasRoom's SQLite.
// Deliberately no canvas FK: deletion tombstones must survive catalog deletion.
export const collaborationRooms = sqliteTable("collaboration_rooms", {
  id: text().primaryKey(),
  generation: integer().notNull().default(0),
  state: text().notNull(),
});

// Directory projection only. Every read rechecks the authoritative room grant.
export const sharedCanvases = sqliteTable(
  "shared_canvases",
  {
    canvasId: text("canvas_id").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.canvasId, table.userId] }),
    index("shared_canvas_user").on(table.userId),
  ],
);

export const collaborationDirectory = sqliteTable("collaboration_directory", {
  canvasId: text("canvas_id").primaryKey(),
  revision: integer().notNull().default(-1),
});

// Short-lived opens only; no scene, permissions, operation log or Durable Object.
export const canvasSessions = sqliteTable(
  "canvas_sessions",
  {
    canvasId: text("canvas_id")
      .notNull()
      .references(() => canvases.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.canvasId, table.clientId] }),
    index("canvas_session_expiry").on(table.expiresAt),
  ],
);
