import type { CanvasScene } from "../../../shared/contracts";
import type { RepositoryPort } from "../../storage/repository";
import type { Authentication } from "../auth";
import type { OwnedResources } from "../access";
import type { Snapshots } from "../snapshots";
import { meta } from "../snapshots";
import {
  ApiError,
  fail,
  json,
  body,
  name,
  isObject,
  validRevision,
} from "../http";
import type { RouteHandler } from "../routing";

const EMPTY_SCENE: CanvasScene = { elements: [], appState: {}, files: {} };

export interface CanvasRoutesDependencies {
  request: Request;
  repository: Pick<RepositoryPort, "renameCanvas" | "deleteCanvas">;
  authentication: Authentication;
  ownedResources: OwnedResources;
  snapshots: Snapshots;
  waitUntil: (promise: Promise<unknown>) => void;
}

export function createCanvasRoutes({
  request,
  repository,
  authentication,
  ownedResources,
  snapshots,
  waitUntil,
}: CanvasRoutesDependencies): RouteHandler {
  return {
    async handle() {
      const req = request;
      const path = new URL(req.url).pathname;
      const method = req.method;
      const user = await authentication.requireUser();
      const canvasMatch = path.match(/^\/api\/canvases\/([^/]+)$/);

      if (canvasMatch) {
        const id = canvasMatch[1]!;
        const row = await ownedResources.canvas(id, user);

        if (method === "GET") {
          try {
            return json({
              canvas: {
                ...meta(row),
                scene: await snapshots.read(row.objectKey, EMPTY_SCENE),
              },
            });
          } catch (error) {
            // An autosave may have replaced and removed this immutable object after the D1 read.
            if (
              !(error instanceof ApiError) ||
              error.code !== "STORAGE_UNAVAILABLE"
            )
              throw error;
            const latest = await ownedResources.canvas(id, user);

            return json({
              canvas: {
                ...meta(latest),
                scene: await snapshots.read(latest.objectKey, EMPTY_SCENE),
              },
            });
          }
        }

        if (method === "PATCH") {
          const data = await body(req);

          await repository.renameCanvas(
            id,
            user.id,
            name(data.name),
            new Date().toISOString(),
          );

          return json({ canvas: meta(await ownedResources.canvas(id, user)) });
        }

        if (method === "DELETE") {
          const ws = await ownedResources.workspace(row.workspaceId, user);
          const data = req.body ? await body(req) : {};
          const revision = validRevision(
            data.catalogRevision ?? ws.catalogRevision,
          );
          const result = await repository.deleteCanvas(
            id,
            user.id,
            row.workspaceId,
            revision,
          );

          if (!result.changed)
            return fail(
              409,
              "CATALOG_CONFLICT",
              "列表已在其他页面更新，请重新加载",
            );
          if (result.objectKey) waitUntil(snapshots.delete([result.objectKey]));

          return json({ catalogRevision: revision + 1 });
        }

        if (method === "PUT") {
          const data = await body(req);
          const scene = data.scene;

          if (
            !isObject(scene) ||
            !Array.isArray(scene.elements) ||
            !isObject(scene.appState) ||
            !isObject(scene.files)
          )
            return fail(400, "INVALID_SCENE", "画布数据格式无效");

          return json(
            await snapshots.save(user, "canvas", id, row, data.revision, scene),
          );
        }
      }

      return undefined;
    },
  };
}
