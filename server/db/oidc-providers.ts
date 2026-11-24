import { db } from "@nuxthub/db";
import { and, asc, eq, ne } from "drizzle-orm";
import * as tables from "#server/db/schema";

export type OidcProviderRow = typeof tables.oidcProviders.$inferSelect;

const ordered = [
  asc(tables.oidcProviders.createdAt),
  asc(tables.oidcProviders.name),
] as const;

export async function oidcProviders() {
  return db
    .select()
    .from(tables.oidcProviders)
    .orderBy(...ordered);
}

/** 登录页与 bootstrap 只看到已启用的身份源。 */
export async function enabledOidcProviders() {
  return db
    .select()
    .from(tables.oidcProviders)
    .where(eq(tables.oidcProviders.enabled, true))
    .orderBy(...ordered);
}

/** Bearer tokens select a trusted, enabled issuer without trusting unverified claims as authority. */
export async function oidcProviderByIssuer(issuer: string) {
  return (
    (
      await db
        .select()
        .from(tables.oidcProviders)
        .where(
          and(
            eq(tables.oidcProviders.issuer, issuer),
            eq(tables.oidcProviders.enabled, true),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

export async function oidcProvider(id: string) {
  if (!id) return null;

  return (
    (
      await db
        .select()
        .from(tables.oidcProviders)
        .where(eq(tables.oidcProviders.id, id))
        .limit(1)
    )[0] ?? null
  );
}

/** 唯一约束是 (type, issuer, client_id)；返回已占用该组合的其它身份源。 */
export async function oidcProviderByIdentity(
  identity: {
    type: OidcProviderRow["type"];
    issuer: string;
    clientId: string;
  },
  exceptId?: string,
) {
  return (
    (
      await db
        .select({ id: tables.oidcProviders.id })
        .from(tables.oidcProviders)
        .where(
          and(
            eq(tables.oidcProviders.type, identity.type),
            eq(tables.oidcProviders.issuer, identity.issuer),
            eq(tables.oidcProviders.clientId, identity.clientId),
            exceptId ? ne(tables.oidcProviders.id, exceptId) : undefined,
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

/** 并发创建由唯一索引裁决：返回 false 表示组合已被占用。 */
export async function insertOidcProvider(row: OidcProviderRow) {
  const inserted = await db
    .insert(tables.oidcProviders)
    .values(row)
    .onConflictDoNothing()
    .returning({ id: tables.oidcProviders.id });

  return inserted.length > 0;
}

export async function updateOidcProvider(
  id: string,
  patch: Partial<OidcProviderRow>,
) {
  const updated = await db
    .update(tables.oidcProviders)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(tables.oidcProviders.id, id))
    .returning({ id: tables.oidcProviders.id });

  return updated.length > 0;
}

/** 删除身份源不影响已映射的账户；返回被删除行的图标对象键。 */
export async function deleteOidcProvider(id: string) {
  const deleted = await db
    .delete(tables.oidcProviders)
    .where(eq(tables.oidcProviders.id, id))
    .returning({ icon: tables.oidcProviders.icon });

  return deleted[0] ?? null;
}

export async function setOidcProviderIcon(id: string, icon: string | null) {
  const updated = await db
    .update(tables.oidcProviders)
    .set({ icon, updatedAt: new Date().toISOString() })
    .where(eq(tables.oidcProviders.id, id))
    .returning({ id: tables.oidcProviders.id });

  return updated.length > 0;
}
