import { repairOrder, reject } from "#shared/collaboration/merge";
import type {
  RoomState,
  SharedScene,
  Grant,
} from "#shared/collaboration/types";

export function createRoom(
  id: string,
  ownerId: string,
  name: string,
  epoch: string,
  scene: SharedScene,
): RoomState {
  return {
    id,
    ownerId,
    name,
    epoch,
    seq: 0,
    minMergeSeq: 0,
    accessRevision: 0,
    deleted: false,
    directoryPending: false,
    scene: { ...scene, elements: repairOrder(scene.elements) },
    members: [],
    links: [],
    versions: [],
    capabilities: {},
    tickets: {},
    operations: {},
    clients: {},
  };
}

export function validateGrant(
  room: RoomState,
  value: Record<string, unknown>,
): Grant {
  if (value.role !== "editor" && value.role !== "viewer")
    reject("INVALID_ROLE", "角色无效");
  const mode = value.role === "editor" ? "live" : value.viewMode;

  if (!["live", "fixed", "latest"].includes(String(mode)))
    reject("INVALID_VIEW_MODE", "查看模式无效");
  if (
    mode === "fixed" &&
    !room.versions.some((version) => version.id === value.snapshotId)
  )
    reject("VERSION_UNAVAILABLE", "请选择有效的固定版本");

  return {
    id: String(value.id),
    role: value.role,
    viewMode: mode as Grant["viewMode"],
    ...(mode === "fixed" ? { snapshotId: String(value.snapshotId) } : {}),
  };
}
