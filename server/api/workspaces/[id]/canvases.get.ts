import { canvasCatalog } from "#server/db/canvases";
import {
  canvasCatalogPage,
  catalogPageRequest,
} from "#server/db/canvas-catalog";
import { apiRequest } from "#server/utils/request";
import { defineApiHandler, resourceId } from "#server/utils/api";
import { requireUser } from "#server/utils/auth";
import { requireWorkspace } from "#server/utils/access";
import { json } from "#server/utils/http";

export default defineApiHandler(async (event) => {
  const id = resourceId(event);

  const user = await requireUser(event);

  await requireWorkspace(id, user);

  const page = catalogPageRequest(new URL(apiRequest(event).url).searchParams);

  if (page) {
    return json(await canvasCatalogPage(id, user.id, page.limit, page.cursor));
  }

  return json(await canvasCatalog(id, user.id));
});
