import type { RepositoryPort } from "../../storage/repository";
import type { Authentication } from "../auth";
import type { OwnedResources } from "../access";
import { fail, json, body, validRevision } from "../http";
import type { RouteHandler } from "../routing";

export interface NavigationRoutesDependencies {
  request: Request;
  repository: Pick<
    RepositoryPort,
    "navigation" | "recordNavigation" | "canvasCatalog" | "reorderCanvases"
  >;
  authentication: Authentication;
  ownedResources: OwnedResources;
}

export function createNavigationRoutes({
  request,
  repository,
  authentication,
  ownedResources,
}: NavigationRoutesDependencies): RouteHandler {
  return {
    async handle() {
      const req = request;
      const path = new URL(req.url).pathname;
      const method = req.method;
      const user = await authentication.requireUser();

      if (path === "/api/navigation") {
        if (method === "GET") return json(await repository.navigation(user.id));
        if (method === "PUT") {
          const data = await body(req);
          const revision = validRevision(data.revision);

          if (typeof data.canvasId !== "string")
            return fail(400, "INVALID_NAVIGATION", "请选择有效画布");
          await ownedResources.canvas(data.canvasId, user);
          if (
            !(await repository.recordNavigation(
              user.id,
              data.canvasId,
              revision,
            ))
          )
            return fail(
              409,
              "NAVIGATION_CONFLICT",
              "当前画布已打开，最近位置未更新，请读取最新版本",
            );

          return json(await repository.navigation(user.id));
        }

        return fail(405, "METHOD_NOT_ALLOWED", "请求方法不支持");
      }

      const orderMatch = path.match(
        /^\/api\/workspaces\/([^/]+)\/canvas-order$/,
      );

      if (orderMatch) {
        const id = orderMatch[1]!;

        await ownedResources.workspace(id, user);
        if (method !== "PUT")
          return fail(405, "METHOD_NOT_ALLOWED", "请求方法不支持");
        const data = await body(req);
        const revision = validRevision(data.catalogRevision);
        const ids = data.canvasIds;
        const catalog = await repository.canvasCatalog(id, user.id);

        if (!catalog) return fail(404, "NOT_FOUND", "工作区不存在");
        if (catalog.catalogRevision !== revision)
          return fail(
            409,
            "CATALOG_CONFLICT",
            "列表已在其他页面更新，请重新排序",
          );
        if (
          !Array.isArray(ids) ||
          ids.some((id) => typeof id !== "string") ||
          new Set(ids).size !== ids.length ||
          ids.length !== catalog.canvases.length ||
          ids.some((id) => !catalog.canvases.some((canvas) => canvas.id === id))
        )
          return fail(
            400,
            "INVALID_CANVAS_ORDER",
            "画布顺序必须包含该空间所有画布且不可重复",
          );
        if (!(await repository.reorderCanvases(id, user.id, ids, revision)))
          return fail(
            409,
            "CATALOG_CONFLICT",
            "列表已在其他页面更新，请重新排序",
          );

        return json(await repository.canvasCatalog(id, user.id));
      }

      return undefined;
    },
  };
}
