import {
  oidcProvider,
  oidcProviderByIdentity,
  updateOidcProvider,
} from "#server/db/oidc-providers";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireAdministrator } from "#server/utils/auth";
import { body, fail, json } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import {
  providerInput,
  providerRecord,
  providerTypeInput,
} from "#server/utils/oidc-providers";

export default defineApiHandler(async (event) => {
  await requireAdministrator(event);
  const id = resourceId(event);
  const current = await oidcProvider(id);

  if (!current) return fail(404, "NOT_FOUND", "身份源不存在");
  const data = await body(apiRequest(event));

  // 类型决定预设 issuer 与图标来源，创建后不再修改。
  if (data.type !== undefined && providerTypeInput(data.type) !== current.type)
    return fail(400, "INVALID_PROVIDER_TYPE", "不支持修改身份源类型");
  const input = providerInput({
    id,
    type: current.type,
    name: data.name ?? current.name,
    issuer: data.issuer ?? current.issuer,
    clientId: data.clientId ?? current.clientId,
    clientSecret: data.clientSecret ?? current.clientSecret,
    scopes: data.scopes ?? current.scopes,
    enabled: data.enabled ?? current.enabled,
    autoRegister: data.autoRegister ?? current.autoRegister,
  });
  const conflict = await oidcProviderByIdentity(input, id);

  if (conflict)
    return fail(
      409,
      "OIDC_PROVIDER_EXISTS",
      "已存在相同类型、issuer 与客户端 ID 的身份源",
    );
  await updateOidcProvider(id, input);
  const row = await oidcProvider(id);

  if (!row) return fail(404, "NOT_FOUND", "身份源不存在");

  return json({ provider: providerRecord(row) });
});
