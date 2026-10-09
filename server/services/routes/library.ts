import type { RepositoryPort } from "../../storage/repository";
import type { Authentication } from "../auth";
import type { Snapshots } from "../snapshots";
import { ApiError, fail, json, body, assertOwner } from "../http";
import type { RouteHandler } from "../routing";

export interface LibraryRoutesDependencies {
  request: Request;
  repository: Pick<RepositoryPort, "library">;
  authentication: Authentication;
  snapshots: Snapshots;
}

export function createLibraryRoutes({
  request,
  repository,
  authentication,
  snapshots,
}: LibraryRoutesDependencies): RouteHandler {
  return {
    async handle() {
      const req = request;
      const path = new URL(req.url).pathname;
      const method = req.method;
      const user = await authentication.requireUser();

      if (path === "/api/library") {
        assertOwner(req, user.id, "x-resource-owner");
        const row = await repository.library(user.id);

        if (!row) return fail(500, "LIBRARY_MISSING", "素材库未初始化");
        if (method === "GET") {
          try {
            return json({
              revision: row.revision,
              items: await snapshots.read(row.objectKey, []),
            });
          } catch (error) {
            if (
              !(error instanceof ApiError) ||
              error.code !== "STORAGE_UNAVAILABLE"
            )
              throw error;
            const latest = await repository.library(user.id);

            if (!latest) throw error;

            return json({
              revision: latest.revision,
              items: await snapshots.read(latest.objectKey, []),
            });
          }
        }

        if (method === "PUT") {
          const data = await body(req);

          if (!Array.isArray(data.items))
            return fail(400, "INVALID_LIBRARY", "素材库数据格式无效");

          return json(
            await snapshots.save(
              user,
              "library",
              user.id,
              row,
              data.revision,
              data.items,
            ),
          );
        }
      }

      return undefined;
    },
  };
}
