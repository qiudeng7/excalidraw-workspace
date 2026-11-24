import { oidcProvider, setOidcProviderIcon } from "#server/db/oidc-providers";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireAdministrator } from "#server/utils/auth";
import { body, fail, json } from "#server/utils/http";
import { apiRequest } from "#server/utils/request";
import {
  dropProviderIcon,
  iconInput,
  providerRecord,
  storeProviderIcon,
} from "#server/utils/oidc-providers";

export default defineApiHandler(async (event) => {
  await requireAdministrator(event);
  const id = resourceId(event);
  const current = await oidcProvider(id);

  if (!current) return fail(404, "NOT_FOUND", "身份源不存在");
  // 预设类型的图标是前端内置资源，不接受上传。
  if (current.type !== "custom")
    return fail(400, "INVALID_ICON", "预设类型使用内置图标，不能上传");
  const icon = iconInput((await body(apiRequest(event))).dataUrl);
  const key = await storeProviderIcon(id, icon);

  // 先写新对象再改引用，失败时旧图标仍是有效引用。
  if (current.icon && current.icon !== key)
    await dropProviderIcon([current.icon]);
  await setOidcProviderIcon(id, key);
  const row = await oidcProvider(id);

  if (!row) return fail(404, "NOT_FOUND", "身份源不存在");

  return json({ provider: providerRecord(row) });
});
