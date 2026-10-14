import { db } from "@nuxthub/db";
import { eq } from "drizzle-orm";
import { getRequestURL, type H3Event } from "h3";
import * as tables from "#server/db/schema";
import { createAccount } from "#server/db/accounts";
import {
  parseDevelopmentAccounts,
  type DevelopmentAccount,
} from "#shared/development";
import { fail } from "#server/utils/http";
import { hashPassword, verifyPassword } from "#server/utils/passwords";

/** Only explicitly enabled local runtimes expose credentials, never normal builds. */
export function developmentAccounts(event: H3Event) {
  const environment = event.context.cloudflare?.env ?? process.env;

  if (
    environment.WORKSPACE_DEVSERVER !== "1" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(getRequestURL(event).hostname)
  )
    return undefined;

  const encoded = environment.WORKSPACE_DEVELOPMENT_ACCOUNTS_BASE64;
  const value = encoded
    ? new TextDecoder().decode(
        Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
      )
    : environment.WORKSPACE_DEVELOPMENT_ACCOUNTS;

  return parseDevelopmentAccounts(value || "");
}

export async function prepareDevelopmentAccounts(
  accounts: DevelopmentAccount[],
) {
  const existing = await db.select().from(tables.users);

  // Validate every account before any write; never adopt ordinary user IDs.
  for (const account of accounts) {
    const id = `development:${account.role}`;
    const conflict = existing.find(
      (user) =>
        (user.email === account.email ||
          (account.role === "admin" && user.role === "admin")) &&
        user.id !== id,
    );
    const managed = existing.find((user) => user.id === id);

    if (conflict || (managed && managed.role !== account.role))
      fail(
        409,
        "DEVELOPMENT_ACCOUNT_CONFLICT",
        `开发 ${account.role} 账号与已有账号冲突；未修改数据。请使用独立的 --data-dir 目录。`,
      );
  }

  for (const account of accounts) {
    const id = `development:${account.role}`;
    const managed = existing.find((user) => user.id === id);
    const samePassword =
      managed && (await verifyPassword(account.password, managed.passwordHash));
    const passwordHash = samePassword
      ? managed.passwordHash
      : await hashPassword(account.password);

    if (managed) {
      await db.batch([
        db
          .update(tables.users)
          .set({ email: account.email, name: account.name, passwordHash })
          .where(eq(tables.users.id, id)),
        ...(samePassword
          ? []
          : [db.delete(tables.sessions).where(eq(tables.sessions.userId, id))]),
      ]);
    } else {
      // Only the explicitly enabled development bootstrap bypasses registration.
      try {
        await createAccount(
          { id, email: account.email, name: account.name, role: account.role },
          passwordHash,
          crypto.randomUUID(),
          crypto.randomUUID(),
          new Date().toISOString(),
          false,
        );
      } catch (error) {
        // A second Worker isolate may have created the same fixture atomically.
        const winner = (
          await db.select().from(tables.users).where(eq(tables.users.id, id))
        )[0];

        if (
          !winner ||
          winner.email !== account.email ||
          winner.role !== account.role ||
          !(await verifyPassword(account.password, winner.passwordHash))
        )
          throw error;
      }
    }
  }
}
