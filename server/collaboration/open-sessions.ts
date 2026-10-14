import { db } from "@nuxthub/db";
import { and, eq, gt, lte } from "drizzle-orm";
import { canvasSessions } from "#server/db/schema";

// Background tabs commonly throttle timers to one minute. No client timestamp is trusted.
export const CANVAS_SESSION_TTL = 150_000;

export async function touchCanvasSession(
  canvasId: string,
  clientId: string,
  now = Date.now(),
) {
  const [, , active] = await db.batch([
    db.delete(canvasSessions).where(lte(canvasSessions.expiresAt, now)),
    db
      .insert(canvasSessions)
      .values({ canvasId, clientId, expiresAt: now + CANVAS_SESSION_TTL })
      .onConflictDoUpdate({
        target: [canvasSessions.canvasId, canvasSessions.clientId],
        set: { expiresAt: now + CANVAS_SESSION_TTL },
      }),
    db
      .select({ clientId: canvasSessions.clientId })
      .from(canvasSessions)
      .where(
        and(
          eq(canvasSessions.canvasId, canvasId),
          gt(canvasSessions.expiresAt, now),
        ),
      )
      .limit(2),
  ]);

  return active.length > 1;
}

export async function leaveCanvasSession(canvasId: string, clientId: string) {
  await db
    .delete(canvasSessions)
    .where(
      and(
        eq(canvasSessions.canvasId, canvasId),
        eq(canvasSessions.clientId, clientId),
      ),
    );
}
