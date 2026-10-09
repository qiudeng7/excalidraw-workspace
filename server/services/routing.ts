import type { Authentication } from "./auth";
import { assertOrigin, fail } from "./http";
export interface RouteHandler {
  handle(): Promise<Response | undefined>;
}
export interface ApiRouter {
  handle(): Promise<Response>;
}
export interface RouterDependencies {
  request: Request;
  publicOrigin: string;
  authentication: Authentication;
  accountsRoutes: RouteHandler;
  settingsRoutes: RouteHandler;
  navigationRoutes: RouteHandler;
  workspaceRoutes: RouteHandler;
  canvasRoutes: RouteHandler;
  libraryRoutes: RouteHandler;
}
export function createApiRouter({
  request,
  publicOrigin,
  authentication,
  accountsRoutes,
  settingsRoutes,
  navigationRoutes,
  workspaceRoutes,
  canvasRoutes,
  libraryRoutes,
}: RouterDependencies): ApiRouter {
  return {
    async handle() {
      assertOrigin(request, publicOrigin);
      const publicResponse = await accountsRoutes.handle();
      if (publicResponse) return publicResponse;
      await authentication.requireUser();
      for (const route of [
        settingsRoutes,
        navigationRoutes,
        workspaceRoutes,
        canvasRoutes,
        libraryRoutes,
      ]) {
        const response = await route.handle();
        if (response) return response;
      }
      return fail(404, "NOT_FOUND", "接口不存在");
    },
  };
}
