import { db } from "@nuxthub/db";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import * as tables from "./schema";
import type { User } from "../../shared/contracts";

const userColumns = {
  id: tables.users.id,
  email: tables.users.email,
  name: tables.users.name,
  role: tables.users.role,
};

export async function session(hash: string, now: number): Promise<User | null> {
  return (
    (
      await db
        .select(userColumns)
        .from(tables.users)
        .innerJoin(tables.sessions, eq(tables.sessions.userId, tables.users.id))
        .where(
          and(
            eq(tables.sessions.tokenHash, hash),
            gt(tables.sessions.expiresAt, now),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

export async function createSession(
  hash: string,
  user: string,
  expires: number,
  expectedPasswordHash: string,
) {
  // Check credentials in the insert itself: a password change can finish after
  // verification but before this write, and must prevent the stale session.
  const created = await db
    .insert(tables.sessions)
    .select(
      db
        .select({
          tokenHash: sql<string>`${hash}`.as("tokenHash"),
          userId: tables.users.id,
          expiresAt: sql<number>`${expires}`.as("expiresAt"),
        })
        .from(tables.users)
        .where(
          and(
            eq(tables.users.id, user),
            eq(tables.users.passwordHash, expectedPasswordHash),
          ),
        ),
    )
    .returning({ tokenHash: tables.sessions.tokenHash });

  return created.length > 0;
}

export async function deleteSession(hash: string) {
  await db.delete(tables.sessions).where(eq(tables.sessions.tokenHash, hash));
}

export async function rateLimit(key: string, expires: number) {
  return (
    (
      await db
        .insert(tables.rateLimits)
        .values({ key, count: 1, expiresAt: expires })
        .onConflictDoUpdate({
          target: tables.rateLimits.key,
          set: { count: sql`${tables.rateLimits.count} + 1` },
        })
        .returning({ count: tables.rateLimits.count })
    )[0] ?? null
  );
}

export async function purgeExpired(now: number) {
  await db.batch([
    db.delete(tables.rateLimits).where(lt(tables.rateLimits.expiresAt, now)),
    db.delete(tables.sessions).where(lt(tables.sessions.expiresAt, now)),
  ]);
}
