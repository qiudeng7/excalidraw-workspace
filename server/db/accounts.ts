import { db } from "@nuxthub/db";
import { and, eq, ne, exists, sql } from "drizzle-orm";
import * as tables from "./schema";
import type { User } from "../../shared/contracts";

const userColumns = {
  id: tables.users.id,
  email: tables.users.email,
  name: tables.users.name,
  role: tables.users.role,
};

export async function administrator() {
  return (
    (
      await db
        .select({ id: tables.users.id })
        .from(tables.users)
        .where(eq(tables.users.role, "admin"))
        .limit(1)
    )[0] ?? null
  );
}

export async function registration() {
  return (
    (
      await db
        .select({ registrationEnabled: tables.settings.registrationEnabled })
        .from(tables.settings)
        .where(eq(tables.settings.id, 1))
    )[0] ?? null
  );
}

export async function userByEmail(email: string) {
  return (
    (
      await db
        .select({ ...userColumns, passwordHash: tables.users.passwordHash })
        .from(tables.users)
        .where(eq(tables.users.email, email))
        .limit(1)
    )[0] ?? null
  );
}

/** Every dependent insert is guarded; registration and initial resources publish together. */

export async function createAccount(
  user: User,
  hash: string,
  workspace: string,
  canvas: string,
  now: string,
) {
  const result = await db.batch([
    db
      .insert(tables.users)
      .select(
        db
          .select({
            id: sql<string>`${user.id}`.as("id"),
            email: sql<string>`${user.email}`.as("email"),
            name: sql<string>`${user.name}`.as("name"),
            role: sql<User["role"]>`${user.role}`.as("role"),
            passwordHash: sql<string>`${hash}`.as("passwordHash"),
            createdAt: sql<string>`${now}`.as("createdAt"),
          })
          .from(tables.settings)
          .where(
            and(
              eq(tables.settings.id, 1),
              user.role === "admin"
                ? undefined
                : and(
                    eq(tables.settings.registrationEnabled, 1),
                    exists(
                      db
                        .select({ id: tables.users.id })
                        .from(tables.users)
                        .where(eq(tables.users.role, "admin")),
                    ),
                  ),
            ),
          ),
      )
      .returning({ id: tables.users.id }),
    db.insert(tables.workspaces).select(
      db
        .select({
          id: sql<string>`${workspace}`.as("id"),
          userId: tables.users.id,
          name: sql<string>`'我的工作区'`.as("name"),
          createdAt: sql<string>`${now}`.as("createdAt"),
          updatedAt: sql<string>`${now}`.as("updatedAt"),
          catalogRevision: sql<number>`0`.as("catalogRevision"),
          deleting: sql<number>`0`.as("deleting"),
        })
        .from(tables.users)
        .where(eq(tables.users.id, user.id)),
    ),
    db.insert(tables.canvases).select(
      db
        .select({
          id: sql<string>`${canvas}`.as("id"),
          workspaceId: tables.workspaces.id,
          name: sql<string>`'未命名画布'`.as("name"),
          revision: sql<number>`0`.as("revision"),
          objectKey: sql<string | null>`NULL`.as("objectKey"),
          syncMode: sql<"legacy">`'legacy'`.as("syncMode"),
          roomEpoch: sql<string | null>`NULL`.as("roomEpoch"),
          createdAt: sql<string>`${now}`.as("createdAt"),
          updatedAt: sql<string>`${now}`.as("updatedAt"),
          position: sql<number>`0`.as("position"),
        })
        .from(tables.workspaces)
        .where(eq(tables.workspaces.id, workspace)),
    ),
    db.insert(tables.libraries).select(
      db
        .select({
          userId: tables.users.id,
          revision: sql<number>`0`.as("revision"),
          objectKey: sql<string | null>`NULL`.as("objectKey"),
          updatedAt: sql<string>`${now}`.as("updatedAt"),
        })
        .from(tables.users)
        .where(eq(tables.users.id, user.id)),
    ),
    db
      .insert(tables.userNavigation)
      .select(
        db
          .select({
            userId: tables.users.id,
            lastWorkspaceId: sql<string | null>`NULL`.as("lastWorkspaceId"),
            lastCanvasId: sql<string | null>`NULL`.as("lastCanvasId"),
            revision: sql<number>`0`.as("revision"),
          })
          .from(tables.users)
          .where(eq(tables.users.id, user.id)),
      )
      .onConflictDoNothing({ target: tables.userNavigation.userId }),
  ]);

  return result[0].length;
}

export async function setRegistration(enabled: boolean) {
  await db
    .update(tables.settings)
    .set({ registrationEnabled: enabled ? 1 : 0 })
    .where(eq(tables.settings.id, 1));
}

/** Compare the verified hash and revoke other sessions in the same atomic batch. */
export async function changeAccountPassword(
  user: string,
  expectedHash: string,
  passwordHash: string,
  currentSession: string,
) {
  const result = await db.batch([
    db
      .update(tables.users)
      .set({ passwordHash })
      .where(
        and(
          eq(tables.users.id, user),
          eq(tables.users.passwordHash, expectedHash),
        ),
      )
      .returning({ id: tables.users.id }),
    db.delete(tables.sessions).where(
      and(
        eq(tables.sessions.userId, user),
        ne(tables.sessions.tokenHash, currentSession),
        exists(
          db
            .select({ id: tables.users.id })
            .from(tables.users)
            .where(
              and(
                eq(tables.users.id, user),
                eq(tables.users.passwordHash, passwordHash),
              ),
            ),
        ),
      ),
    ),
  ]);

  return result[0].length > 0;
}
