export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
}
export interface Bootstrap {
  needsSetup: boolean;
  registrationEnabled: boolean;
  emailVerification: false;
}
export interface Workspace {
  catalogRevision: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface CanvasMeta {
  position: number;
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CanvasScene {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}
export interface CanvasDocument extends CanvasMeta {
  scene: CanvasScene;
}
export interface LibraryDocument {
  items: unknown[];
  revision: number;
}
export interface SaveResult {
  revision: number;
  updatedAt: string;
}
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface WorkspaceNavigation {
  workspaceId: string;
  lastCanvasId: string | null;
}
export interface Navigation {
  revision: number;
  lastWorkspaceId: string | null;
  lastCanvasId: string | null;
  workspaces: WorkspaceNavigation[];
}
export interface CanvasCatalog {
  canvases: CanvasMeta[];
  catalogRevision: number;
}
