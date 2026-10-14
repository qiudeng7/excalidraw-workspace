import { db } from "@nuxthub/db";
import { and, count, eq, gt, like, lte, sql } from "drizzle-orm";
import { canvasSessions } from "#server/db/schema";
import { digest } from "#server/utils/passwords";
import { fail } from "#server/utils/http";
import type { Access } from "#shared/collaboration/types";

// Background tabs commonly throttle timers to one minute. No client timestamp is trusted.
export const CANVAS_SESSION_TTL = 150_000;

/** A tab identifier is untrusted and only unique inside its authorized principal. */
export async function canvasSessionKey(
  access: Pick<Access, "principalId">,
  clientId: unknown,
) {
  if (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(clientId))
    return fail(400, "INVALID_CLIENT", "画布会话标识无效");

  return `presence:${await digest(JSON.stringify([access.principalId, clientId]))}`;
}

// Ignore the former unscoped leases during rolling upgrades; their TTL still cleans them up.
export async function countCanvasSessions(canvasId: string, now = Date.now()) {
  const [active] = await db
    .select({ participants: count() })
    .from(canvasSessions)
    .where(
      and(
        eq(canvasSessions.canvasId, canvasId),
        gt(canvasSessions.expiresAt, now),
        like(canvasSessions.clientId, "presence:%"),
      ),
    );

  return active!.participants;
}

export async function touchCanvasSession(
  canvasId: string,
  clientId: string,
  now = Date.now(),
) {
  const [, lease, active] = await db.batch([
    db.delete(canvasSessions).where(lte(canvasSessions.expiresAt, now)),
    db
      .insert(canvasSessions)
      .values({ canvasId, clientId, expiresAt: now + CANVAS_SESSION_TTL })
      .onConflictDoUpdate({
        target: [canvasSessions.canvasId, canvasSessions.clientId],
        set: {
          expiresAt: sql`max(${now + CANVAS_SESSION_TTL}, ${canvasSessions.expiresAt} + 1)`,
        },
      })
      .returning({ leaseExpiresAt: canvasSessions.expiresAt }),
    db
      .select({ participants: count() })
      .from(canvasSessions)
      .where(
        and(
          eq(canvasSessions.canvasId, canvasId),
          gt(canvasSessions.expiresAt, now),
          like(canvasSessions.clientId, "presence:%"),
        ),
      ),
  ]);

  return {
    participants: active[0]!.participants,
    leaseExpiresAt: lease[0]!.leaseExpiresAt,
  };
}

export async function leaveCanvasSession(
  canvasId: string,
  clientId: string,
  leaseExpiresAt?: number,
) {
  await db
    .delete(canvasSessions)
    .where(
      and(
        eq(canvasSessions.canvasId, canvasId),
        eq(canvasSessions.clientId, clientId),
        leaseExpiresAt === undefined
          ? undefined
          : eq(canvasSessions.expiresAt, leaseExpiresAt),
      ),
    );
}
