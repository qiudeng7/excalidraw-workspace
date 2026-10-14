import type { DevelopmentAccount } from "#shared/development";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
}

export interface Bootstrap {
  developmentAccounts?: DevelopmentAccount[];
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
  syncMode?: "legacy" | "preparing" | "collaborative";
  roomEpoch?: string | null;
  migrationEpoch?: string | null;
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

export interface UserSettings {
  version: 1;
  features: {
    edgeBinding: boolean;
    nunitoFont: boolean;
    formalLines: boolean;
    solidFill: boolean;
    shortArrowheads: boolean;
    disableDefaultSidebar: boolean;
    bottomToolbar: boolean;
  };
  debug: {
    sampling: 1 | 1.5 | 2;
    renderingOptions: {
      smoothCache: boolean;
      highQualitySmoothing: boolean;
      directText: boolean;
      directShapes: boolean;
      alignPixels: boolean;
      smoothCanvas: boolean;
    };
  };
}

export interface UserSettingsDocument {
  settings: UserSettings;
  revision: number;
  configured: boolean;
}

export function createDefaultUserSettings(): UserSettings {
  return {
    version: 1,
    features: {
      edgeBinding: true,
      nunitoFont: true,
      formalLines: true,
      solidFill: true,
      shortArrowheads: true,
      disableDefaultSidebar: true,
      bottomToolbar: true,
    },
    debug: {
      sampling: 1,
      renderingOptions: {
        smoothCache: false,
        highQualitySmoothing: false,
        directText: false,
        directShapes: false,
        alignPixels: false,
        smoothCanvas: false,
      },
    },
  };
}
