import type { RoomState } from "#shared/collaboration/types";

export const ROOM_OBJECT_GRACE = 24 * 60 * 60 * 1000;

/** Room objects have their own authority; the legacy collector must never infer their liveness from D1. */
export function referencedRoomObjects(room: RoomState) {
  if (room.deleted) return new Set<string>();

  return new Set([
    ...Object.values(room.scene.files).map((file) => file.objectKey),
    ...room.versions.flatMap((version) => [
      version.sceneKey,
      ...Object.values(version.files).map((file) => file.objectKey),
    ]),
  ]);
}
