import { insertOidcProvider, oidcProvider } from "#server/db/oidc-providers";
import { defineApiHandler } from "#server/utils/api";
import { requireAdministrator } from "#server/utils/auth";
import { body, fail, json } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import { providerInput, providerRecord } from "#server/utils/oidc-providers";

export default defineApiHandler(async (event) => {
  await requireAdministrator(event);
  const input = providerInput(await body(apiRequest(event)));
  const now = new Date().toISOString();
  const inserted = await insertOidcProvider({
    ...input,
    icon: null,
    createdAt: now,
    updatedAt: now,
  });

  if (!inserted)
    return fail(
      409,
      "OIDC_PROVIDER_EXISTS",
      "已存在相同类型、issuer 与客户端 ID 的身份源",
    );
  const row = await oidcProvider(input.id);

  if (!row) return fail(404, "NOT_FOUND", "身份源不存在");

  return json({ provider: providerRecord(row) }, 201);
});
