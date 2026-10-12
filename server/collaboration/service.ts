import { db } from "@nuxthub/db";
import { and, eq } from "drizzle-orm";
import { blob } from "@nuxthub/blob";
import type { H3Event } from "h3";
import { canvases, workspaces, sharedCanvases } from "../db/schema";
import { currentUser, currentSessionHash } from "../utils/auth";
import { fail, assertOwner, ApiError } from "../utils/http";
import { apiRequest } from "../utils/request";
import { readSnapshot } from "../utils/snapshots";
import { digest } from "../utils/passwords";
import { createRoom, type Command } from "../../shared/collaboration/room";
import { roomCommand } from "./transport";
import type {
  Access,
  CanvasView,
  FileReference,
  Principal,
  RoomState,
  SharedScene,
} from "../../shared/collaboration/types";
import type { CanvasScene } from "../../shared/contracts";
import { projectNodeRoom } from "./node-projection";
import { validateElement } from "../../shared/collaboration/merge";

export async function principal(event: H3Event): Promise<Principal> {
  const user = await currentUser(event);
  const token = event.headers.get("x-canvas-access");

  if (token && (token.length !== 64 || !/^[a-f0-9]+$/.test(token)))
    return fail(403, "INVALID_ACCESS", "访问凭证无效");
  if (user) assertOwner(apiRequest(event), user.id, "x-account-owner");

  return {
    ...(user
      ? {
          userId: user.id,
          name: user.name,
          sessionHash: await currentSessionHash(event),
        }
      : { name: "访客" }),
    ...(token ? { capabilityHash: await digest(token) } : {}),
  };
}

export async function canvasRow(id: string) {
  return (
    await db
      .select({
        canvas: canvases,
        ownerId: workspaces.userId,
        deleting: workspaces.deleting,
      })
      .from(canvases)
      .innerJoin(workspaces, eq(canvases.workspaceId, workspaces.id))
      .where(eq(canvases.id, id))
  )[0];
}

/** Freeze the legacy final-publish CAS, seed exactly that revision, then activate. */
export async function ensureRoom(
  event: H3Event,
  id: string,
  actor: Principal,
  allowDeleting = false,
) {
  let row = await canvasRow(id);

  if (!row) return fail(404, "NOT_FOUND", "画布不存在");
  if (row.deleting && !allowDeleting)
    return fail(410, "CANVAS_DELETED", "工作空间已删除");
  if (row.canvas.syncMode === "collaborative") return;
  if (actor.userId !== row.ownerId || actor.capabilityHash)
    return fail(404, "NOT_FOUND", "画布不存在");
  if (row.canvas.syncMode === "legacy") {
    await db
      .update(canvases)
      .set({ syncMode: "preparing", roomEpoch: crypto.randomUUID() })
      .where(and(eq(canvases.id, id), eq(canvases.syncMode, "legacy")));
    row = (await canvasRow(id))!;
  }

  const legacy = (await readSnapshot(row.canvas.objectKey, {
    elements: [],
    appState: {},
    files: {},
  })) as CanvasScene;
  const files: Record<string, FileReference> = {};

  for (const [fileId, value] of Object.entries(legacy.files)) {
    const file = value as Record<string, unknown>;

    if (typeof file.dataURL !== "string") continue;
    const key = `collaboration/${id}/assets/${await digest(file.dataURL)}.json`;

    await blob.put(key, JSON.stringify(file), {
      contentType: "application/json",
    });
    files[fileId] = {
      id: fileId,
      objectKey: key,
      mimeType: String(file.mimeType ?? "image/png"),
      created: Number(file.created ?? Date.now()),
    };
  }

  const scene: SharedScene = {
    elements: legacy.elements.map((value) => {
      validateElement(value);

      return value;
    }),
    appState:
      typeof legacy.appState.viewBackgroundColor === "string"
        ? { viewBackgroundColor: legacy.appState.viewBackgroundColor }
        : {},
    files,
  };
  const seed = createRoom(
    id,
    row.ownerId,
    row.canvas.name,
    row.canvas.roomEpoch!,
    scene,
  );

  // Existing room wins during interrupted/repeated migrations. Never seed over its updates.
  await roomCommand(event, id, actor, { type: "access" }, seed);
  const active = await db
    .update(canvases)
    .set({ syncMode: "collaborative" })
    .where(
      and(
        eq(canvases.id, id),
        eq(canvases.syncMode, "preparing"),
        eq(canvases.roomEpoch, seed.epoch),
      ),
    )
    .returning({ id: canvases.id });

  if (!active.length && !(await canvasRow(id))) {
    try {
      await roomCommand(event, id, actor, { type: "delete" });
    } catch (error) {
      // Catalog deletion can be retried after the room tombstone committed.
      if (!(error instanceof ApiError) || error.code !== "CANVAS_DELETED")
        throw error;
    }

    fail(410, "CANVAS_DELETED", "画布已删除");
  }
}

export async function canvasCommand<T>(
  event: H3Event,
  id: string,
  command: Command,
): Promise<T> {
  const actor = await principal(event);

  await ensureRoom(event, id, actor);

  return roomCommand<T>(event, id, actor, command);
}

export async function hydrateView(
  value: CanvasView,
): Promise<CanvasView & { scene: CanvasScene }> {
  if (value.snapshot) {
    value = {
      ...value,
      scene: (await readSnapshot(value.snapshot.sceneKey, null)) as SharedScene,
    };
  }

  const files: Record<string, unknown> = {};

  await Promise.all(
    Object.entries(value.scene.files).map(async ([id, reference]) => {
      const file = await blob.get(reference.objectKey);

      if (!file)
        return fail(503, "ASSET_UNAVAILABLE", "图片暂时无法读取，请稍后重试");
      files[id] = {
        ...JSON.parse(await file.text()),
        id,
        mimeType: reference.mimeType,
        created: reference.created,
      };
    }),
  );

  return { ...value, scene: { ...value.scene, files } } as CanvasView & {
    scene: CanvasScene;
  };
}

export async function tombstoneCanvas(event: H3Event, id: string) {
  const row = await canvasRow(id);

  if (row && row.canvas.syncMode !== "legacy") {
    const actor = await principal(event);

    await ensureRoom(event, id, actor, true);
    try {
      await roomCommand(event, id, actor, { type: "delete" });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "CANVAS_DELETED")
        throw error;
    }
  }
}

export async function projectMember(event: H3Event, id: string) {
  // Cloudflare drains the same outbox inside the Durable Object and retries via alarm.
  if (!event.context.cloudflare?.env?.CANVAS_ROOMS) await projectNodeRoom(id);
}
