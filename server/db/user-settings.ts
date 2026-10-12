import { db } from "@nuxthub/db";
import { and, eq, sql } from "drizzle-orm";
import * as tables from "#server/db/schema";

export async function userSettings(user: string) {
  return (
    (
      await db
        .select({
          settingsJson: tables.userSettings.settingsJson,
          revision: tables.userSettings.revision,
          updatedAt: tables.userSettings.updatedAt,
        })
        .from(tables.userSettings)
        .where(eq(tables.userSettings.userId, user))
    )[0] ?? null
  );
}

export async function saveUserSettings(
  user: string,
  settingsJson: string,
  revision: number,
  now: string,
) {
  const rows =
    revision === 0
      ? await db
          .insert(tables.userSettings)
          .values({ userId: user, settingsJson, revision: 1, updatedAt: now })
          .onConflictDoNothing({ target: tables.userSettings.userId })
          .returning({ revision: tables.userSettings.revision })
      : await db
          .update(tables.userSettings)
          .set({
            settingsJson,
            revision: sql`${tables.userSettings.revision}+1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(tables.userSettings.userId, user),
              eq(tables.userSettings.revision, revision),
            ),
          )
          .returning({ revision: tables.userSettings.revision });

  return rows[0]?.revision;
}
