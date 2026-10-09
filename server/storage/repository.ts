import type { User, CanvasMeta, Navigation } from "../../shared/contracts";
import type {
  Row,
  RepositoryPort,
  SqlDriver,
  ObjectStore,
  Statement,
  StoredCanvas,
  StoredLibrary,
  StoredCredentials,
} from "./ports";
import {
  text,
  integer,
  nullableText,
  decodeUser,
  decodeWorkspace,
  decodeCanvas,
} from "./rows";

export type * from "./ports";

const wc =
  "id,name,catalog_revision AS catalogRevision,created_at AS createdAt,updated_at AS updatedAt";

const cc =
  "c.id,c.workspace_id AS workspaceId,c.name,c.revision,c.position,c.created_at AS createdAt,c.updated_at AS updatedAt";

export class Repository implements RepositoryPort {
  constructor(private sql: SqlDriver) {}

  private async one(sql: string, ...values: unknown[]) {
    return (await this.sql.query(sql, values)).rows[0] ?? null;
  }

  private async all(sql: string, ...values: unknown[]) {
    return (await this.sql.query(sql, values)).rows;
  }

  private async run(sql: string, ...values: unknown[]) {
    return (await this.sql.query(sql, values)).changes;
  }

  async administrator() {
    const row = await this.one(
      "SELECT id FROM users WHERE role='admin' LIMIT 1",
    );

    return row ? { id: text(row, "id") } : null;
  }

  async registration() {
    const row = await this.one(
      "SELECT registration_enabled FROM settings WHERE id=1",
    );

    return row
      ? { registration_enabled: integer(row, "registration_enabled") }
      : null;
  }

  async session(hash: string, now: number): Promise<User | null> {
    const row = await this.one(
      "SELECT u.id,u.email,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
      hash,
      now,
    );

    return row ? decodeUser(row) : null;
  }

  createSession(hash: string, user: string, expires: number) {
    return this.run(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      hash,
      user,
      expires,
    );
  }

  deleteSession(hash: string) {
    return this.run("DELETE FROM sessions WHERE token_hash=?", hash);
  }

  async rateLimit(key: string, expires: number) {
    const row = await this.one(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
      key,
      expires,
    );

    return row ? { count: integer(row, "count") } : null;
  }

  async purgeExpired(now: number) {
    await this.sql.transaction([
      { sql: "DELETE FROM rate_limits WHERE expires_at<?", values: [now] },
      { sql: "DELETE FROM sessions WHERE expires_at<?", values: [now] },
    ]);
  }

  async userByEmail(email: string): Promise<StoredCredentials | null> {
    const row = await this.one(
      "SELECT id,email,name,role,password_hash FROM users WHERE email=?",
      email,
    );

    return row
      ? { ...decodeUser(row), password_hash: text(row, "password_hash") }
      : null;
  }

  async createAccount(
    user: User,
    hash: string,
    workspace: string,
    canvas: string,
    now: string,
  ) {
    const insert =
      user.role === "admin"
        ? "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)"
        : "INSERT INTO users(id,email,name,role,password_hash,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE role='admin') AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND registration_enabled=1)";
    const result = await this.sql.transaction([
      {
        sql: insert,
        values: [user.id, user.email, user.name, user.role, hash, now],
      },
      {
        sql: "INSERT INTO workspaces(id,user_id,name,created_at,updated_at) SELECT ?,id,'我的工作区',?,? FROM users WHERE id=?",
        values: [workspace, now, now, user.id],
      },
      {
        sql: "INSERT INTO canvases(id,workspace_id,name,created_at,updated_at) SELECT ?,id,'未命名画布',?,? FROM workspaces WHERE id=?",
        values: [canvas, now, now, workspace],
      },
      {
        sql: "INSERT INTO libraries(user_id,updated_at) SELECT id,? FROM users WHERE id=?",
        values: [now, user.id],
      },
      {
        sql: "INSERT OR IGNORE INTO user_navigation(user_id) SELECT id FROM users WHERE id=?",
        values: [user.id],
      },
    ]);

    return result[0]!.changes;
  }

  setRegistration(enabled: boolean) {
    return this.run(
      "UPDATE settings SET registration_enabled=? WHERE id=1",
      enabled ? 1 : 0,
    );
  }

  async workspace(id: string, user: string) {
    const row = await this.one(
      `SELECT ${wc} FROM workspaces WHERE id=? AND user_id=?`,
      id,
      user,
    );

    return row ? decodeWorkspace(row) : null;
  }

  async workspaces(user: string) {
    const rows = await this.all(
      `SELECT ${wc} FROM workspaces WHERE user_id=? ORDER BY created_at,id`,
      user,
    );

    return rows.map(decodeWorkspace);
  }

  createWorkspace(id: string, user: string, name: string, now: string) {
    return this.run(
      "INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)",
      id,
      user,
      name,
      now,
      now,
    );
  }

  renameWorkspace(id: string, user: string, name: string, now: string) {
    return this.run(
      "UPDATE workspaces SET name=?,updated_at=? WHERE id=? AND user_id=?",
      name,
      now,
      id,
      user,
    );
  }

  async deleteWorkspace(id: string, user: string) {
    const r = await this.sql.transaction([
      {
        sql: "DELETE FROM canvases WHERE workspace_id=? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id=?) RETURNING object_key",
        values: [id, user],
      },
      {
        sql: "DELETE FROM workspaces WHERE id=? AND user_id=?",
        values: [id, user],
      },
    ]);

    return r[0]!.rows.flatMap((r) =>
      nullableText(r, "object_key") ? [text(r, "object_key")] : [],
    );
  }

  async canvas(id: string, user: string): Promise<StoredCanvas | null> {
    const row = await this.one(
      `SELECT ${cc},c.object_key AS objectKey FROM canvases c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND w.user_id=?`,
      id,
      user,
    );

    return row
      ? { ...decodeCanvas(row), objectKey: nullableText(row, "objectKey") }
      : null;
  }

  async canvases(workspace: string): Promise<CanvasMeta[]> {
    return (
      await this.all(
        `SELECT ${cc} FROM canvases c WHERE c.workspace_id=? ORDER BY c.position,c.id`,
        workspace,
      )
    ).map(decodeCanvas);
  }

  async createCanvas(
    id: string,
    workspace: string,
    user: string,
    name: string,
    now: string,
    catalogRevision: number,
  ) {
    const result = await this.sql.transaction([
      {
        sql: "INSERT INTO canvases(id,workspace_id,name,position,created_at,updated_at) SELECT ?,w.id,?,COALESCE((SELECT MAX(position)+1 FROM canvases WHERE workspace_id=w.id),0),?,? FROM workspaces w WHERE w.id=? AND w.user_id=? AND w.catalog_revision=?",
        values: [id, name, now, now, workspace, user, catalogRevision],
      },
      {
        sql: "UPDATE workspaces SET catalog_revision=catalog_revision+1 WHERE id=? AND user_id=? AND catalog_revision=?",
        values: [workspace, user, catalogRevision],
      },
    ]);

    return result[1]!.changes;
  }

  renameCanvas(id: string, user: string, name: string, now: string) {
    return this.run(
      "UPDATE canvases SET name=?,updated_at=? WHERE id=? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id=?)",
      name,
      now,
      id,
      user,
    );
  }

  async deleteCanvas(
    id: string,
    user: string,
    workspace: string,
    catalogRevision: number,
  ) {
    const result = await this.sql.transaction([
      {
        sql: "DELETE FROM canvases WHERE id=? AND workspace_id=? AND EXISTS(SELECT 1 FROM workspaces WHERE id=? AND user_id=? AND catalog_revision=?) RETURNING object_key",
        values: [id, workspace, workspace, user, catalogRevision],
      },
      {
        sql: "UPDATE workspaces SET catalog_revision=catalog_revision+1 WHERE id=? AND user_id=? AND catalog_revision=?",
        values: [workspace, user, catalogRevision],
      },
    ]);

    return {
      changed: result[1]!.changes,
      objectKey: result[0]!.rows[0]
        ? nullableText(result[0]!.rows[0]!, "object_key")
        : undefined,
    };
  }

  async reorderCanvases(
    workspace: string,
    user: string,
    ids: string[],
    revision: number,
  ) {
    const statements: Statement[] = ids.map((id, position) => ({
      sql: "UPDATE canvases SET position=? WHERE id=? AND workspace_id=? AND EXISTS(SELECT 1 FROM workspaces WHERE id=? AND user_id=? AND catalog_revision=?)",
      values: [position, id, workspace, workspace, user, revision],
    }));

    statements.push({
      sql: "UPDATE workspaces SET catalog_revision=catalog_revision+1 WHERE id=? AND user_id=? AND catalog_revision=?",
      values: [workspace, user, revision],
    });
    const result = await this.sql.transaction(statements);

    return result[result.length - 1]!.changes;
  }

  async canvasCatalog(workspace: string, user: string) {
    const result = await this.sql.transaction([
      {
        sql: "SELECT catalog_revision AS catalogRevision FROM workspaces WHERE id=? AND user_id=?",
        values: [workspace, user],
      },
      {
        sql: `SELECT ${cc} FROM canvases c JOIN workspaces w ON w.id=c.workspace_id WHERE w.id=? AND w.user_id=? ORDER BY c.position,c.id`,
        values: [workspace, user],
      },
    ]);
    const row = result[0]!.rows[0];

    return row
      ? {
          catalogRevision: integer(row, "catalogRevision"),
          canvases: result[1]!.rows.map(decodeCanvas),
        }
      : null;
  }

  async navigation(user: string): Promise<Navigation> {
    const result = await this.sql.transaction([
      {
        sql: "SELECT revision,last_workspace_id AS lastWorkspaceId,last_canvas_id AS lastCanvasId FROM user_navigation WHERE user_id=?",
        values: [user],
      },
      {
        sql: "SELECT workspace_id AS workspaceId,last_canvas_id AS lastCanvasId FROM workspace_navigation WHERE user_id=? ORDER BY workspace_id",
        values: [user],
      },
    ]);
    const row = result[0]!.rows[0];

    if (!row) throw new Error("Navigation row missing");

    return {
      revision: integer(row, "revision"),
      lastWorkspaceId: nullableText(row, "lastWorkspaceId"),
      lastCanvasId: nullableText(row, "lastCanvasId"),
      workspaces: result[1]!.rows.map((row) => ({
        workspaceId: text(row, "workspaceId"),
        lastCanvasId: nullableText(row, "lastCanvasId"),
      })),
    };
  }

  async recordNavigation(user: string, canvas: string, revision: number) {
    const result = await this.sql.transaction([
      {
        sql: "INSERT INTO workspace_navigation(user_id,workspace_id,last_canvas_id) SELECT ?,c.workspace_id,c.id FROM canvases c JOIN workspaces w ON w.id=c.workspace_id JOIN user_navigation n ON n.user_id=w.user_id WHERE c.id=? AND w.user_id=? AND n.revision=? ON CONFLICT(user_id,workspace_id) DO UPDATE SET last_canvas_id=excluded.last_canvas_id",
        values: [user, canvas, user, revision],
      },
      {
        sql: "UPDATE user_navigation SET last_workspace_id=(SELECT workspace_id FROM canvases WHERE id=?),last_canvas_id=?,revision=revision+1 WHERE user_id=? AND revision=? AND EXISTS(SELECT 1 FROM canvases c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND w.user_id=?)",
        values: [canvas, canvas, user, revision, canvas, user],
      },
    ]);

    return result[1]!.changes;
  }

  async library(user: string): Promise<StoredLibrary | null> {
    const row = await this.one(
      "SELECT revision,object_key AS objectKey FROM libraries WHERE user_id=?",
      user,
    );

    return row
      ? {
          revision: integer(row, "revision"),
          objectKey: nullableText(row, "objectKey"),
        }
      : null;
  }

  saveSnapshot(
    type: "canvas" | "library",
    id: string,
    user: string,
    key: string,
    revision: number,
    now: string,
  ) {
    return type === "canvas"
      ? this.run(
          "UPDATE canvases SET object_key=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id=?)",
          key,
          now,
          id,
          revision,
          user,
        )
      : this.run(
          "UPDATE libraries SET object_key=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?",
          key,
          now,
          user,
          revision,
        );
  }

  async userSettings(user: string) {
    const row = await this.one(
      "SELECT settings_json AS settingsJson,revision,updated_at AS updatedAt FROM user_settings WHERE user_id=?",
      user,
    );

    return row
      ? {
          settingsJson: text(row, "settingsJson"),
          revision: integer(row, "revision"),
          updatedAt: text(row, "updatedAt"),
        }
      : null;
  }

  async saveUserSettings(
    user: string,
    settingsJson: string,
    revision: number,
    now: string,
  ) {
    const row = await this.one(
      "INSERT INTO user_settings(user_id,settings_json,revision,updated_at) SELECT ?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM user_settings WHERE user_id=? AND revision=?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,revision=user_settings.revision+1,updated_at=excluded.updated_at WHERE user_settings.revision=? RETURNING revision",
      user,
      settingsJson,
      now,
      revision,
      user,
      revision,
      revision,
    );

    return row ? integer(row, "revision") : undefined;
  }

  async objectReferenced(key: string) {
    return !!(await this.one(
      "SELECT object_key FROM canvases WHERE object_key=? UNION ALL SELECT object_key FROM libraries WHERE object_key=? LIMIT 1",
      key,
      key,
    ));
  }
}

/** Never collect fresh objects: a write may not have reached its metadata CAS yet. */
export async function collectOrphans(
  repository: Pick<RepositoryPort, "objectReferenced">,
  objects: ObjectStore,
  now = Date.now(),
  grace = 24 * 60 * 60 * 1000,
) {
  let cursor: string | undefined;

  do {
    const page = await objects.list(cursor);
    const abandoned: string[] = [];

    for (const object of page.objects)
      if (
        object.modified < now - grace &&
        !(await repository.objectReferenced(object.key))
      )
        abandoned.push(object.key);
    if (abandoned.length) await objects.delete(abandoned);
    cursor = page.cursor;
  } while (cursor);
}
