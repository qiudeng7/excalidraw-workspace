import type {
  User,
  CanvasMeta,
  Navigation,
  Workspace,
  CanvasCatalog,
} from "../../shared/contracts";

export type Row = Record<string, unknown>;

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

export interface StoredCanvas extends CanvasMeta {
  objectKey: string | null;
}

export interface StoredLibrary {
  revision: number;
  objectKey: string | null;
}

export interface StoredCredentials extends User {
  password_hash: string;
}

export interface Registration {
  registration_enabled: number;
}

export interface StoredUserSettings {
  settingsJson: string;
  revision: number;
  updatedAt: string;
}

/** Application port: no SQL rows or platform handles cross this boundary. */
export interface RepositoryPort {
  administrator(): Promise<{ id: string } | null>;

  registration(): Promise<Registration | null>;

  session(hash: string, now: number): Promise<User | null>;

  createSession(hash: string, user: string, expires: number): Promise<number>;

  deleteSession(hash: string): Promise<number>;

  rateLimit(key: string, expires: number): Promise<{ count: number } | null>;

  purgeExpired(now: number): Promise<void>;

  userByEmail(email: string): Promise<StoredCredentials | null>;

  createAccount(
    user: User,
    hash: string,
    workspace: string,
    canvas: string,
    now: string,
  ): Promise<number>;

  setRegistration(enabled: boolean): Promise<number>;

  workspace(id: string, user: string): Promise<Workspace | null>;

  workspaces(user: string): Promise<Workspace[]>;

  createWorkspace(
    id: string,
    user: string,
    name: string,
    now: string,
  ): Promise<number>;

  renameWorkspace(
    id: string,
    user: string,
    name: string,
    now: string,
  ): Promise<number>;

  deleteWorkspace(id: string, user: string): Promise<string[]>;

  canvas(id: string, user: string): Promise<StoredCanvas | null>;

  canvases(workspace: string): Promise<CanvasMeta[]>;

  createCanvas(
    id: string,
    workspace: string,
    user: string,
    name: string,
    now: string,
    catalogRevision: number,
  ): Promise<number>;

  renameCanvas(
    id: string,
    user: string,
    name: string,
    now: string,
  ): Promise<number>;

  deleteCanvas(
    id: string,
    user: string,
    workspace: string,
    catalogRevision: number,
  ): Promise<{ changed: number; objectKey: string | null | undefined }>;

  reorderCanvases(
    workspace: string,
    user: string,
    ids: string[],
    revision: number,
  ): Promise<number>;

  canvasCatalog(workspace: string, user: string): Promise<CanvasCatalog | null>;

  navigation(user: string): Promise<Navigation>;

  recordNavigation(
    user: string,
    canvas: string,
    revision: number,
  ): Promise<number>;

  library(user: string): Promise<StoredLibrary | null>;

  saveSnapshot(
    type: "canvas" | "library",
    id: string,
    user: string,
    key: string,
    revision: number,
    now: string,
  ): Promise<number>;

  userSettings(user: string): Promise<StoredUserSettings | null>;

  saveUserSettings(
    user: string,
    settingsJson: string,
    revision: number,
    now: string,
  ): Promise<number | undefined>;

  objectReferenced(key: string): Promise<boolean>;
}
