import type { User, Workspace, CanvasMeta } from "../../shared/contracts";
import type { Row } from "./ports";

export function text(row: Row, key: string): string {
  const value = row[key];

  if (typeof value !== "string")
    throw new Error(`Invalid stored string: ${key}`);

  return value;
}

export function integer(row: Row, key: string): number {
  const value = row[key];

  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`Invalid stored integer: ${key}`);

  return value;
}

export function nullableText(row: Row, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

export function decodeUser(row: Row): User {
  const role = text(row, "role");

  if (role !== "admin" && role !== "user")
    throw new Error("Invalid stored role");

  return {
    id: text(row, "id"),
    email: text(row, "email"),
    name: text(row, "name"),
    role,
  };
}

export function decodeWorkspace(row: Row): Workspace {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    catalogRevision: integer(row, "catalogRevision"),
    createdAt: text(row, "createdAt"),
    updatedAt: text(row, "updatedAt"),
  };
}

export function decodeCanvas(row: Row): CanvasMeta {
  return {
    id: text(row, "id"),
    workspaceId: text(row, "workspaceId"),
    name: text(row, "name"),
    revision: integer(row, "revision"),
    position: integer(row, "position"),
    createdAt: text(row, "createdAt"),
    updatedAt: text(row, "updatedAt"),
  };
}
