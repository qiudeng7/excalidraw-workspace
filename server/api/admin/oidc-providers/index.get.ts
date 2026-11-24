import { oidcProviders } from "#server/db/oidc-providers";
import { defineApiHandler } from "#server/utils/api";
import { requireAdministrator } from "#server/utils/auth";
import { json } from "#server/utils/http";
import { providerRecord } from "#server/utils/oidc-providers";

export default defineApiHandler(async (event) => {
  await requireAdministrator(event);
  const rows = await oidcProviders();

  return json({ providers: rows.map(providerRecord) });
});
