import type { H3Event } from "h3";
import { nodeCommand } from "#server/collaboration/node";
import type { Command } from "#shared/collaboration/room";
import { CollaborationError } from "#shared/collaboration/merge";
import type { Principal, RoomState } from "#shared/collaboration/types";
import { ApiError } from "#server/utils/http";

export interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(url: string, options: RequestInit): Promise<Response>;
  };
}

export async function roomCommand<T>(
  event: H3Event,
  id: string,
  principal: Principal,
  command: Command,
  seed?: RoomState,
): Promise<T> {
  return dispatchRoomCommand(
    event.context.cloudflare?.env?.CANVAS_ROOMS,
    id,
    principal,
    command,
    seed,
  );
}

/** Scheduled cleanup has the same authority/transport as an HTTP request. */
export async function dispatchRoomCommand<T>(
  namespace: RoomNamespace | undefined,
  id: string,
  principal: Principal,
  command: Command,
  seed?: RoomState,
): Promise<T> {
  try {
    if (!namespace)
      return (await nodeCommand(id, principal, command, seed)) as T;
    const stub = namespace.get(namespace.idFromName(id));
    const response = await stub.fetch("https://room.internal/command", {
      method: "POST",
      headers: { "x-partykit-room": id },
      body: JSON.stringify({ principal, command, seed }),
    });
    const value = (await response.json()) as {
      result?: T;
      error?: { code: string; message: string };
    };

    if (!response.ok)
      throw new ApiError(
        response.status,
        value.error!.code,
        value.error!.message,
      );

    return value.result!;
  } catch (error) {
    if (error instanceof CollaborationError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}
