import { deleteOidcProvider } from "#server/db/oidc-providers";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireAdministrator } from "#server/utils/auth";
import { fail, json } from "#server/utils/http";
import { dropProviderIcon } from "#server/utils/oidc-providers";

/** 删除身份源不删除已映射的账户；它们仍以普通用户身份保留。 */
export default defineApiHandler(async (event) => {
  await requireAdministrator(event);
  const id = resourceId(event);
  const deleted = await deleteOidcProvider(id);

  if (!deleted) return fail(404, "NOT_FOUND", "身份源不存在");
  await dropProviderIcon([deleted.icon]);

  return json({ id });
});
