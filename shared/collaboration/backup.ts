import { createRoom, validateGrant } from "./state";
import { canonical, reject, validateElement } from "./merge";
import { MAX_SCENE_BYTES, type RoomState, type FileReference } from "./types";

export interface RoomBackup {
  format: "excalidraw-room-v1";
  exportedAt: string;
  state: RoomState;
}

export function exportRoom(room: RoomState, now: number): RoomBackup {
  const state = structuredClone(room);

  // Connection credentials never belong in portable backups. Restoring starts
  // a new epoch, so old receipts and client sequence counters are unnecessary.
  state.capabilities = {};
  state.tickets = {};
  state.operations = {};
  state.clients = {};

  return {
    format: "excalidraw-room-v1",
    exportedAt: new Date(now).toISOString(),
    state,
  };
}

export function importRoom(
  current: RoomState,
  backup: RoomBackup,
  epoch: string,
): RoomState {
  const source = backup?.state;

  if (
    backup?.format !== "excalidraw-room-v1" ||
    !source ||
    source.id !== current.id ||
    source.ownerId !== current.ownerId ||
    source.deleted ||
    typeof source.name !== "string" ||
    !source.name.trim() ||
    source.name.length > 100 ||
    !Array.isArray(source.scene?.elements) ||
    !source.scene.files ||
    !Array.isArray(source.members) ||
    source.members.length > 500 ||
    !Array.isArray(source.links) ||
    source.links.length > 100 ||
    !Array.isArray(source.versions) ||
    source.versions.length > 30
  )
    reject("INVALID_BACKUP", "备份格式或画布所有者不匹配");
  for (const element of source.scene.elements) validateElement(element);
  if (
    new Set(source.scene.elements.map((element) => element.id)).size !==
    source.scene.elements.length
  )
    reject("INVALID_BACKUP", "备份包含重复元素");
  const prefix = `collaboration/${current.id}/`;
  const validKey = (key: unknown) =>
    typeof key === "string" &&
    key.startsWith(prefix) &&
    /^[a-zA-Z0-9/.-]+$/.test(key) &&
    !key.includes("..");
  const files = (references: Record<string, FileReference>) => {
    if (!references || Object.keys(references).length > 2000)
      reject("INVALID_BACKUP", "备份图片清单无效");
    for (const [id, file] of Object.entries(references))
      if (
        !file ||
        file.id !== id ||
        ["__proto__", "constructor", "prototype"].includes(id) ||
        !validKey(file.objectKey) ||
        typeof file.mimeType !== "string" ||
        !Number.isFinite(file.created)
      )
        reject("INVALID_BACKUP", "备份图片引用无效");
  };

  files(source.scene.files);
  for (const element of source.scene.elements)
    if (
      element.type === "image" &&
      !element.isDeleted &&
      (typeof element.fileId !== "string" ||
        !Object.hasOwn(source.scene.files, element.fileId))
    )
      reject("INVALID_BACKUP", "备份图片引用缺失");
  const background = source.scene.appState?.viewBackgroundColor;

  if (
    background !== undefined &&
    (typeof background !== "string" || background.length > 100)
  )
    reject("INVALID_BACKUP", "备份背景无效");
  const restored = createRoom(current.id, current.ownerId, source.name, epoch, {
    elements: source.scene.elements,
    appState:
      background === undefined ? {} : { viewBackgroundColor: background },
    files: source.scene.files,
  });

  if (
    new TextEncoder().encode(canonical(restored.scene)).length > MAX_SCENE_BYTES
  )
    reject("INVALID_BACKUP", "备份画布超过 20 MB", 413);
  restored.versions = source.versions.map((version) => {
    if (
      !version ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(version.id) ||
      !validKey(version.sceneKey) ||
      typeof version.name !== "string" ||
      typeof version.label !== "string" ||
      typeof version.epoch !== "string" ||
      !Number.isSafeInteger(version.seq) ||
      version.seq < 0
    )
      reject("INVALID_BACKUP", "固定版本备份无效");
    files(version.files);

    return { ...version };
  });
  restored.members = source.members.map((member) => {
    if (
      !member ||
      typeof member.userId !== "string" ||
      !member.userId ||
      member.userId === current.ownerId ||
      typeof member.name !== "string"
    )
      reject("INVALID_BACKUP", "备份成员无效");

    return {
      ...validateGrant(restored, member as unknown as Record<string, unknown>),
      userId: member.userId,
      name: member.name,
    };
  });
  restored.links = source.links.map((link) => {
    if (
      !link ||
      !/^[a-f0-9]{64}$/.test(link.secretHash) ||
      typeof link.requireLogin !== "boolean" ||
      (link.expiresAt !== null && !Number.isFinite(link.expiresAt))
    )
      reject("INVALID_BACKUP", "备份分享链接无效");

    return {
      ...validateGrant(restored, link as unknown as Record<string, unknown>),
      secretHash: link.secretHash,
      requireLogin: link.requireLogin,
      expiresAt: link.expiresAt,
    };
  });
  restored.accessRevision = current.accessRevision + 1;
  restored.directoryPending = true;

  return restored;
}
