import type { RepositoryPort } from "../../storage/repository";
import type { Authentication } from "../auth";
import type { OwnedResources } from "../access";
import type { Snapshots } from "../snapshots";
import { meta } from "../snapshots";
import { fail, json, body, name, validRevision } from "../http";
import type { RouteHandler } from "../routing";
export interface WorkspaceRoutesDependencies {
  request: Request;
  repository: Pick<
    RepositoryPort,
    | "workspaces"
    | "createWorkspace"
    | "canvasCatalog"
    | "createCanvas"
    | "renameWorkspace"
    | "deleteWorkspace"
  >;
  authentication: Authentication;
  ownedResources: OwnedResources;
  snapshots: Snapshots;
  waitUntil: (promise: Promise<unknown>) => void;
}
export function createWorkspaceRoutes({
  request,
  repository,
  authentication,
  ownedResources,
  snapshots,
  waitUntil,
}: WorkspaceRoutesDependencies): RouteHandler {
  return {
    async handle() {
      const req = request;
      const path = new URL(req.url).pathname;
      const method = req.method;
      const user = await authentication.requireUser();
      if (path === "/api/workspaces") {
        if (method === "GET")
          return json({ workspaces: await repository.workspaces(user.id) });
        if (method === "POST") {
          const data = await body(req);
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          await repository.createWorkspace(id, user.id, name(data.name), now);
          return json({ workspace: await ownedResources.workspace(id, user) });
        }
      }
      const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)(\/canvases)?$/);
      if (wsMatch) {
        const id = wsMatch[1]!;
        const ws = await ownedResources.workspace(id, user);
        if (wsMatch[2]) {
          if (method === "GET")
            return json(await repository.canvasCatalog(id, user.id));
          if (method === "POST") {
            const data = await body(req);
            const canvasId = crypto.randomUUID();
            const now = new Date().toISOString();
            const revision = validRevision(
              data.catalogRevision ?? ws.catalogRevision,
            );
            const changed = await repository.createCanvas(
              canvasId,
              id,
              user.id,
              name(data.name, "未命名画布"),
              now,
              revision,
            );
            if (!changed)
              return fail(
                409,
                "CATALOG_CONFLICT",
                "列表已在其他页面更新，请重新加载",
              );
            return json({
              canvas: meta(await ownedResources.canvas(canvasId, user)),
              catalogRevision: revision + 1,
            });
          }
        } else {
          if (method === "PATCH") {
            const data = await body(req);
            await repository.renameWorkspace(
              id,
              user.id,
              name(data.name),
              new Date().toISOString(),
            );
            return json({
              workspace: await ownedResources.workspace(id, user),
            });
          }
          if (method === "DELETE") {
            const keys = await repository.deleteWorkspace(id, user.id);
            if (keys.length) waitUntil(snapshots.delete(keys));
            return json({});
          }
        }
      }

      return undefined;
    },
  };
}
