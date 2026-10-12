import type { CanvasScene } from "#shared/contracts";

export const PROTOCOL_VERSION = 1;

export const MAX_SCENE_BYTES = 20 * 1024 * 1024;

export const MAX_OPERATION_BYTES = MAX_SCENE_BYTES;

export const OPERATION_RETENTION = 2000;

export type Role = "owner" | "editor" | "viewer";

export type ViewMode = "live" | "fixed" | "latest";

export interface Grant {
  id: string;
  role: Exclude<Role, "owner">;
  viewMode: ViewMode;
  snapshotId?: string;
}

export interface Member extends Grant {
  userId: string;
  name: string;
}

export interface ShareLink extends Grant {
  secretHash: string;
  requireLogin: boolean;
  expiresAt: number | null;
}

export interface Principal {
  userId?: string;
  name: string;
  sessionHash?: string;
  capabilityHash?: string;
}

export interface Access {
  epoch: string;
  principalId: string;
  name: string;
  grantId: string;
  role: Role;
  viewMode: ViewMode;
  snapshotId?: string;
  accessRevision: number;
}

export interface FileReference {
  id: string;
  objectKey: string;
  mimeType: string;
  created: number;
}

export interface SharedScene {
  elements: Element[];
  appState: { viewBackgroundColor?: string };
  files: Record<string, FileReference>;
}

export interface Element extends Record<string, unknown> {
  id: string;
  version: number;
  versionNonce: number;
  index?: string;
  isDeleted?: boolean;
}

export interface PublishedVersion {
  id: string;
  label: string;
  name: string;
  epoch: string;
  seq: number;
  createdAt: string;
  createdBy: string;
  sceneKey: string;
  files: Record<string, FileReference>;
}

export interface Operation {
  protocolVersion: 1;
  epoch: string;
  clientId: string;
  clientSeq: number;
  opId: string;
  baseSeq: number;
  elements: Element[];
  preconditions?: Record<string, { version: number; versionNonce: number }>;
  background?: { value: string; base: string | null };
}

export interface Commit {
  type: "COMMIT";
  replayed?: boolean;
  epoch: string;
  seq: number;
  opId: string;
  clientId: string;
  elements: Element[];
  background?: string;
  skipped: string[];
}

export interface RoomState {
  id: string;
  ownerId: string;
  name: string;
  epoch: string;
  seq: number;
  minMergeSeq: number;
  accessRevision: number;
  deleted: boolean;
  directoryPending: boolean;
  scene: SharedScene;
  members: Member[];
  links: ShareLink[];
  versions: PublishedVersion[];
  capabilities: Record<
    string,
    {
      linkId: string;
      principalId: string;
      userId?: string;
      name: string;
      expiresAt: number;
    }
  >;
  tickets: Record<
    string,
    { access: Access; principal: Principal; expiresAt: number }
  >;
  operations: Record<
    string,
    { digest: string; commit: Commit; principalId: string }
  >;
  clients: Record<string, { principalId: string; clientSeq: number }>;
}

export interface CanvasView {
  protocolVersion: 1;
  canvasId: string;
  name: string;
  epoch: string;
  seq: number;
  access: Access;
  scene: SharedScene;
  snapshot?: Omit<PublishedVersion, "scene">;
  readAt: string;
}

export type InitialScene = CanvasScene;
