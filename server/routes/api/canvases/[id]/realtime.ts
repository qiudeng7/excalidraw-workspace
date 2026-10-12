import { defineWebSocketHandler } from "h3";
import { nodeCommand, roomListeners } from "#server/collaboration/node";
import { session } from "#server/db/sessions";
import { digest } from "#server/utils/passwords";
import { sanitizePresence } from "#server/collaboration/presence";
import type { Access, Principal } from "#shared/collaboration/types";
import type { Command } from "#shared/collaboration/room";

interface Connection {
  id: string;
  room: string;
  authDeadline: number;
  principal?: Principal;
  access?: Access;
  send(value: string): void;
  close(code: number, reason: string): void;
  stop: () => void;
}

const connections = new Set<Connection>();

async function authorize(connection: Connection) {
  if (!connection.principal || !connection.access) return false;
  try {
    const principal = connection.principal;

    if (
      principal.userId &&
      (!principal.sessionHash ||
        (await session(principal.sessionHash, Date.now()))?.id !==
          principal.userId)
    )
      throw new Error("登录已失效，请重新登录");
    const access = (await nodeCommand(connection.room, principal, {
      type: "access",
    })) as Access;

    if (
      access.epoch !== connection.access.epoch ||
      access.viewMode !== "live" ||
      access.role !== connection.access.role ||
      access.grantId !== connection.access.grantId ||
      access.snapshotId !== connection.access.snapshotId
    )
      throw new Error("分享权限已变更，请重新加载");

    connection.access = access;

    return true;
  } catch (error) {
    connection.send(
      JSON.stringify({
        type: "ACCESS_CHANGED",
        message: error instanceof Error ? error.message : "访问失效",
      }),
    );
    connection.close(4003, "Access changed");

    return false;
  }
}

export default defineWebSocketHandler({
  upgrade(request) {
    const expected =
      process.env.PUBLIC_ORIGIN ||
      process.env.NUXT_PUBLIC_ORIGIN ||
      new URL(request.url).origin;

    if (request.headers.get("origin") !== expected)
      return new Response("Forbidden", { status: 403 });
    const room = decodeURIComponent(
      new URL(request.url).pathname.split("/")[3]!,
    );

    if (
      [...connections].filter((connection) => connection.room === room)
        .length >= 50
    )
      return new Response("Room is full", { status: 429 });
  },
  open(peer) {
    const room = decodeURIComponent(
      new URL(peer.request.url).pathname.split("/")[3]!,
    );
    const connection: Connection = {
      id: crypto.randomUUID(),
      room,
      authDeadline: Date.now() + 10000,
      send: (data) => peer.send(data),
      close: (code, reason) => peer.close(code, reason),
      stop: () => {},
    };
    const timeout = setTimeout(() => {
      if (!connection.principal)
        connection.close(4003, "Authentication timeout");
    }, 10000);
    const recheck = setInterval(() => {
      void authorize(connection);
    }, 60000);
    const listener = (command: Command, result: unknown) => {
      if (
        ![
          "update",
          "member",
          "removeMember",
          "link",
          "removeLink",
          "removeVersion",
          "restore",
          "rename",
          "delete",
        ].includes(command.type)
      )
        return;
      void (async () => {
        if (!(await authorize(connection))) return;
        if (command.type === "rename")
          connection.send(JSON.stringify({ type: "RESYNC" }));
        if (command.type === "update") {
          const data = JSON.stringify(result);

          connection.send(
            data.length < 60000 ? data : JSON.stringify({ type: "RESYNC" }),
          );
        }
      })().catch((error) =>
        console.warn(
          "协作消息发送失败",
          error instanceof Error ? error.message : "unknown",
        ),
      );
    };

    connection.stop = () => {
      clearTimeout(timeout);
      clearInterval(recheck);
      roomListeners.get(room)?.delete(listener);
      if (!roomListeners.get(room)?.size) roomListeners.delete(room);
    };

    (
      roomListeners.get(room) ?? roomListeners.set(room, new Set()).get(room)!
    ).add(listener);
    connections.add(connection);
    peer.context.connection = connection;
  },
  async message(peer, raw) {
    const connection = peer.context.connection as Connection;

    try {
      const text = raw.text();

      if (text.length > 8192) throw new Error("消息过大");
      const message = JSON.parse(text);

      if (!connection.principal) {
        if (Date.now() >= connection.authDeadline)
          throw new Error("连接验证已超时");
        if (message.type !== "AUTH" || typeof message.ticket !== "string")
          throw new Error("连接需要验证");
        const authenticated = (await nodeCommand(
          connection.room,
          { name: "" },
          { type: "authenticate", hash: await digest(message.ticket) },
        )) as { principal: Principal; access: Access };

        connection.principal = authenticated.principal;
        connection.access = authenticated.access;
        if (!(await authorize(connection))) return;
        const state = (await nodeCommand(
          connection.room,
          connection.principal,
          { type: "view" },
        )) as { seq: number; epoch: string };

        connection.send(
          JSON.stringify({ type: "READY", seq: state.seq, epoch: state.epoch }),
        );
        for (const other of connections) {
          if (
            other === connection ||
            other.room !== connection.room ||
            !(await authorize(other))
          )
            continue;
          other.send(
            JSON.stringify({
              type: "PRESENCE",
              connectionId: connection.id,
              principalId: connection.access!.principalId,
              username: connection.access!.name,
            }),
          );
          connection.send(
            JSON.stringify({
              type: "PRESENCE",
              connectionId: other.id,
              principalId: other.access!.principalId,
              username: other.access!.name,
            }),
          );
        }
      } else if (message.type === "PRESENCE" && (await authorize(connection))) {
        const data = JSON.stringify({
          type: "PRESENCE",
          connectionId: connection.id,
          principalId: connection.access!.principalId,
          username: connection.access!.name,
          ...sanitizePresence(message),
        });

        for (const other of connections)
          if (
            other !== connection &&
            other.room === connection.room &&
            (await authorize(other))
          )
            other.send(data);
      }
    } catch (error) {
      connection.send(
        JSON.stringify({
          type: "ERROR",
          message: error instanceof Error ? error.message : "连接失败",
        }),
      );
      connection.close(4003, "Invalid message");
    }
  },
  close(peer) {
    const connection = peer.context.connection as Connection | undefined;

    if (!connection) return;
    connections.delete(connection);
    connection.stop();
    for (const other of connections)
      if (other.room === connection.room && other.principal)
        other.send(
          JSON.stringify({ type: "LEFT", connectionId: connection.id }),
        );
  },
});
