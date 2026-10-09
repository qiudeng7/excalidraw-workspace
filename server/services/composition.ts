import {
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
} from "awilix/browser";
import type { BackendContext } from "./api";
import { createAuthentication, type Authentication } from "./auth";
import { createOwnedResources, type OwnedResources } from "./access";
import { createSnapshots, type Snapshots } from "./snapshots";
import { createApiRouter, type ApiRouter, type RouteHandler } from "./routing";
import { createAccountsRoutes } from "./routes/accounts";
import { createSettingsRoutes } from "./routes/settings";
import { createNavigationRoutes } from "./routes/navigation";
import { createWorkspaceRoutes } from "./routes/workspaces";
import { createCanvasRoutes } from "./routes/canvases";
import { createLibraryRoutes } from "./routes/library";

interface RequestDependencies extends BackendContext {
  request: Request;
  authentication: Authentication;
  ownedResources: OwnedResources;
  snapshots: Snapshots;
  accountsRoutes: RouteHandler;
  settingsRoutes: RouteHandler;
  navigationRoutes: RouteHandler;
  workspaceRoutes: RouteHandler;
  canvasRoutes: RouteHandler;
  libraryRoutes: RouteHandler;
  apiRouter: ApiRouter;
}

/** Only this composition root knows Awilix. Resources are externally owned, never disposed by a request. */
export async function dispatchRequest(
  request: Request,
  context: BackendContext,
): Promise<Response> {
  const container = createContainer<RequestDependencies>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  container.register({
    repository: asValue(context.repository),
    objects: asValue(context.objects),
    publicOrigin: asValue(context.publicOrigin),
    clientIp: asValue(context.clientIp),
    waitUntil: asValue((promise: Promise<unknown>) =>
      context.waitUntil(promise),
    ),
    authentication: asFunction(createAuthentication).scoped(),
    ownedResources: asFunction(createOwnedResources).scoped(),
    snapshots: asFunction(createSnapshots).scoped(),
    accountsRoutes: asFunction(createAccountsRoutes).scoped(),
    settingsRoutes: asFunction(createSettingsRoutes).scoped(),
    navigationRoutes: asFunction(createNavigationRoutes).scoped(),
    workspaceRoutes: asFunction(createWorkspaceRoutes).scoped(),
    canvasRoutes: asFunction(createCanvasRoutes).scoped(),
    libraryRoutes: asFunction(createLibraryRoutes).scoped(),
    apiRouter: asFunction(createApiRouter).scoped(),
  });
  const scope = container.createScope();

  scope.register({ request: asValue(request) });
  try {
    return await scope.resolve("apiRouter").handle();
  } finally {
    await scope.dispose();
    await container.dispose();
  }
}
