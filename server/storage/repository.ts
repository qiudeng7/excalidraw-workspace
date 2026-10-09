import type { User, CanvasMeta, Navigation } from "../../shared/contracts";
export type Row = Record<string, any>;
export interface Statement {
  sql: string;
  values: unknown[];
}
export interface QueryResult {
  rows: Row[];
  changes: number;
}
/** Platform drivers stay private to storage; business code calls Repository operations. */
export interface SqlDriver {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  transaction(statements: Statement[]): Promise<QueryResult[]>;
}
export interface ObjectStore {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<void>;
  list(cursor?: string): Promise<{
    objects: {
      key: string;
      modified: number;
    }[];
    cursor?: string;
  }>;
}
const wc =
  "id,name,catalog_revision AS catalogRevision,created_at AS createdAt,updated_at AS updatedAt";
const cc =
  "c.id,c.workspace_id AS workspaceId,c.name,c.revision,c.position,c.created_at AS createdAt,c.updated_at AS updatedAt";
export class Repository {
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
  administrator() {
    return this.one("SELECT id FROM users WHERE role='admin' LIMIT 1");
  }
  registration() {
    return this.one("SELECT registration_enabled FROM settings WHERE id=1");
  }
  session(hash: string, now: number): Promise<User | null> {
    return this.one(
      "SELECT u.id,u.email,u.name,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
      hash,
      now,
    ) as Promise<User | null>;
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
  rateLimit(key: string, expires: number) {
    return this.one(
      "INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
      key,
      expires,
    );
  }
  purgeExpired(now: number) {
    return this.sql.transaction([
      { sql: "DELETE FROM rate_limits WHERE expires_at<?", values: [now] },
      { sql: "DELETE FROM sessions WHERE expires_at<?", values: [now] },
    ]);
  }
  userByEmail(email: string): Promise<
    | (User & {
        password_hash: string;
      })
    | null
  > {
    return this.one(
      "SELECT id,email,name,role,password_hash FROM users WHERE email=?",
      email,
    ) as Promise<
      | (User & {
          password_hash: string;
        })
      | null
    >;
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
        sql: "INSERT INTO user_navigation(user_id) SELECT id FROM users WHERE id=?",
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
  workspace(id: string, user: string) {
    return this.one(
      `SELECT ${wc} FROM workspaces WHERE id=? AND user_id=?`,
      id,
      user,
    );
  }
  workspaces(user: string) {
    return this.all(
      `SELECT ${wc} FROM workspaces WHERE user_id=? ORDER BY created_at,id`,
      user,
    );
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
      r.object_key ? [r.object_key as string] : [],
    );
  }
  canvas(
    id: string,
    user: string,
  ): Promise<
    | (CanvasMeta & {
        objectKey: string | null;
      })
    | null
  > {
    return this.one(
      `SELECT ${cc},c.object_key AS objectKey FROM canvases c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND w.user_id=?`,
      id,
      user,
    ) as Promise<
      | (CanvasMeta & {
          objectKey: string | null;
        })
      | null
    >;
  }
  canvases(workspace: string) {
    return this.all(
      `SELECT ${cc} FROM canvases c WHERE c.workspace_id=? ORDER BY c.position,c.id`,
      workspace,
    );
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
      objectKey: result[0]!.rows[0]?.object_key as string | null | undefined,
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
          catalogRevision: row.catalogRevision as number,
          canvases: result[1]!.rows,
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
    return { ...row, workspaces: result[1]!.rows } as Navigation;
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
  library(user: string): Promise<{
    revision: number;
    objectKey: string | null;
  } | null> {
    return this.one(
      "SELECT revision,object_key AS objectKey FROM libraries WHERE user_id=?",
      user,
    ) as Promise<{
      revision: number;
      objectKey: string | null;
    } | null>;
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
  repository: Repository,
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
