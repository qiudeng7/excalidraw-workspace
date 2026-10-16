/// <reference types="@cloudflare/workers-types" />
import { Server, type Connection } from "partyserver";
import { execute, type Command } from "#shared/collaboration/room";
import { CollaborationError, reject } from "#shared/collaboration/merge";
import type { Access, Principal, RoomState } from "#shared/collaboration/types";

import {
  referencedRoomObjects,
  ROOM_OBJECT_GRACE,
} from "#server/collaboration/garbage-collection";
import {
  projectionStatements,
  type DirectoryProjection,
} from "#server/collaboration/directory";
import { sanitizePresence } from "#server/collaboration/presence";

interface Environment {
  DB: D1Database;
  BLOB: R2Bucket;
  CANVAS_ROOMS: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
}

interface Attachment {
  principal: Principal;
  access: Access;
  connectionId: string;
  expiresAt: number;
}

type SocketState = Attachment | { expiresAt: number };

type RoomConnection = Connection<SocketState>;

/** PartyServer owns hibernation sockets; state and deduplication commit atomically. */
export class CanvasRoom extends Server<Environment> {
  static options = { hibernate: true };

  onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_chunks (position INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  private sendText(socket: WebSocket, message: string) {
    try {
      socket.send(message);
    } catch (error) {
      console.warn(
        "协作连接已关闭，跳过发送",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }

  private load(): RoomState | undefined {
    const chunks = [
      ...this.ctx.storage.sql.exec<{ value: string }>(
        "SELECT value FROM room_chunks ORDER BY position",
      ),
    ];

    return chunks.length
      ? JSON.parse(chunks.map((chunk) => chunk.value).join(""))
      : undefined;
  }

  private transaction(
    principal: Principal,
    command: Command,
    seed?: RoomState,
  ): unknown {
    return this.ctx.storage.transactionSync(() => {
      const stored = this.load();
      const room = stored ?? seed;

      if (!room) reject("ROOM_NOT_FOUND", "协作房间尚未初始化", 404);
      const result = execute(room, principal, command, Date.now());

      if (
        stored &&
        ["access", "status", "view", "manage", "backup", "projection"].includes(
          command.type,
        )
      )
        return result;
      const serialized = JSON.stringify(room);

      this.ctx.storage.sql.exec("DELETE FROM room_chunks");
      // Stay below SQLite's per-value size limit, including snapshots with images.
      for (let offset = 0; offset < serialized.length; offset += 32000)
        this.ctx.storage.sql.exec(
          "INSERT INTO room_chunks VALUES (?, ?)",
          offset / 32000,
          serialized.slice(offset, offset + 32000),
        );

      return result;
    });
  }

  private async requireActiveCatalog() {
    const id = this.load()?.id;

    if (!id) return;
    const row = await this.env.DB.prepare(
      "SELECT c.id, c.recycle_pending FROM canvases c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=? AND c.deleted_at IS NULL AND c.purging=0 AND w.deleted_at IS NULL AND w.deleting=0",
    )
      .bind(id)
      .first<{ recycle_pending: number }>();

    if (!row) reject("CANVAS_DELETED", "画布已移入回收站或彻底删除", 410);
    if (row.recycle_pending)
      reject("RECYCLE_SYNC_PENDING", "正在恢复画布，请稍后重试", 503);
  }

  private async validSession(principal: Principal) {
    if (!principal.userId) return true;
    if (!principal.sessionHash) return false;
    const session = await this.env.DB.prepare(
      "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
    )
      .bind(principal.sessionHash, Date.now())
      .first<{ user_id: string }>();

    return session?.user_id === principal.userId;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (request.headers.get("origin") !== this.env.PUBLIC_ORIGIN)
        return new Response("Forbidden", { status: 403 });
      if ([...this.getConnections<SocketState>()].length >= 50)
        return new Response("Room is full", { status: 429 });
    }

    // Internal callers provide the room identity. Ignore client-supplied PartyKit
    // props/connection ids; room identity and authentication are our protocol.
    const headers = new Headers(request.headers);

    headers.delete("x-partykit-props");
    const url = new URL(request.url);

    url.searchParams.delete("_pk");
    const response = await super.fetch(
      new Request(new Request(url, request), { headers }),
    );

    // PartyServer's default error response includes stack traces.
    if (response.status >= 500)
      return Response.json(
        { error: { code: "ROOM_UNAVAILABLE", message: "协作房间暂时不可用" } },
        { status: 503 },
      );

    return response;
  }

  async onConnect(socket: RoomConnection) {
    socket.setState({ expiresAt: Date.now() + 10000 });
    const alarm = await this.ctx.storage.getAlarm();

    if (!alarm || alarm > Date.now() + 10000)
      await this.ctx.storage.setAlarm(Date.now() + 10000);
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const { principal, command, seed } = (await request.json()) as {
        principal: Principal;
        command: Command;
        seed?: RoomState;
      };

      if (
        !["recycle", "delete", "projection", "projectionAck"].includes(
          command.type,
        )
      )
        await this.requireActiveCatalog();
      const result = this.transaction(principal, command, seed);

      // Persistence has completed. Reauthorize each recipient immediately before sending.
      await this.broadcastAuthorized(command, result);
      if (
        [
          "member",
          "removeMember",
          "delete",
          "recycle",
          "restore",
          "rename",
        ].includes(command.type)
      )
        await this.projectDirectory();
      if (
        seed ||
        ["asset", "publish", "removeVersion", "delete", "restore"].includes(
          command.type,
        )
      ) {
        const gcAt =
          (await this.ctx.storage.get<number>("gcAt")) ??
          Date.now() + ROOM_OBJECT_GRACE;

        await this.ctx.storage.put("gcAt", gcAt);
        const alarm = await this.ctx.storage.getAlarm();

        if (!alarm || alarm > gcAt) await this.ctx.storage.setAlarm(gcAt);
      }

      return Response.json({ result });
    } catch (error) {
      if (error instanceof CollaborationError)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      console.error(
        "CanvasRoom request failed",
        error instanceof Error ? error.message : "unknown",
      );

      return Response.json(
        { error: { code: "ROOM_UNAVAILABLE", message: "协作房间暂时不可用" } },
        { status: 503 },
      );
    }
  }

  private async authorizeSocket(
    socket: RoomConnection,
  ): Promise<Attachment | undefined> {
    const attachment = socket.state as Attachment | undefined;

    if (!attachment?.principal) return;
    try {
      await this.requireActiveCatalog();
      if (!(await this.validSession(attachment.principal)))
        reject("SESSION_CHANGED", "登录已失效，请刷新页面", 401);
      const access = this.transaction(attachment.principal, {
        type: "access",
      }) as Access;

      if (
        access.epoch !== attachment.access.epoch ||
        access.viewMode !== "live" ||
        access.role !== attachment.access.role ||
        access.grantId !== attachment.access.grantId ||
        access.snapshotId !== attachment.access.snapshotId
      )
        reject("ACCESS_CHANGED", "分享权限已变更，请重新加载", 403);
      attachment.access = access;
      attachment.expiresAt = Date.now() + 60000;
      socket.setState(attachment);

      return attachment;
    } catch (error) {
      this.sendText(
        socket,
        JSON.stringify({
          type: "ACCESS_CHANGED",
          message: error instanceof Error ? error.message : "访问失效",
        }),
      );
      socket.close(4003, "Access changed");
    }
  }

  private async broadcastAuthorized(command: Command, result: unknown) {
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
    for (const socket of this.getConnections<SocketState>()) {
      if (!(await this.authorizeSocket(socket))) continue;
      if (command.type === "rename")
        this.sendText(socket, JSON.stringify({ type: "RESYNC" }));
      if (command.type === "update") {
        const message = JSON.stringify(result);

        this.sendText(
          socket,
          message.length < 60000 ? message : JSON.stringify({ type: "RESYNC" }),
        );
      }
    }
  }

  async onMessage(
    socket: RoomConnection,
    raw: string | ArrayBuffer | ArrayBufferView,
  ) {
    try {
      if (typeof raw !== "string" || raw.length > 8192)
        reject("INVALID_MESSAGE", "消息格式无效");
      const message = JSON.parse(raw);
      const attachment = socket.state as Attachment | undefined;

      if (!attachment?.principal) {
        if (!attachment || attachment.expiresAt <= Date.now())
          reject("AUTH_EXPIRED", "连接验证已超时", 401);
        if (message.type !== "AUTH" || typeof message.ticket !== "string")
          reject("AUTH_REQUIRED", "请先验证连接", 401);
        const hash = await hashSecret(message.ticket);

        await this.requireActiveCatalog();
        const authenticated = this.transaction(
          { name: "" },
          { type: "authenticate", hash },
        ) as Pick<Attachment, "principal" | "access">;

        if (!(await this.validSession(authenticated.principal)))
          reject("SESSION_CHANGED", "登录已失效", 401);
        authenticated.access = this.transaction(authenticated.principal, {
          type: "access",
        }) as Access;
        if (authenticated.access.viewMode !== "live")
          reject("LIVE_ACCESS_REQUIRED", "此查看模式不能连接实时房间", 403);
        socket.setState({
          ...authenticated,
          connectionId: crypto.randomUUID(),
          expiresAt: Date.now() + 60000,
        });
        this.sendText(
          socket,
          JSON.stringify({
            type: "READY",
            seq: this.load()!.seq,
            epoch: this.load()!.epoch,
          }),
        );
        const own = socket.state as Attachment;

        for (const peer of this.getConnections<SocketState>()) {
          if (peer.id === socket.id) continue;
          const other = await this.authorizeSocket(peer);

          if (!other) continue;
          this.sendText(
            peer,
            JSON.stringify({
              type: "PRESENCE",
              connectionId: own.connectionId,
              principalId: own.access.principalId,
              username: own.access.name,
            }),
          );
          this.sendText(
            socket,
            JSON.stringify({
              type: "PRESENCE",
              connectionId: other.connectionId,
              principalId: other.access.principalId,
              username: other.access.name,
            }),
          );
        }

        await this.ctx.storage.setAlarm(Date.now() + 60000);

        return;
      }

      if (message.type === "PRESENCE") {
        if (!(await this.authorizeSocket(socket))) return;
        const presence = sanitizePresence(message);

        for (const peer of this.getConnections<SocketState>()) {
          if (peer.id !== socket.id && (await this.authorizeSocket(peer)))
            this.sendText(
              peer,
              JSON.stringify({
                type: "PRESENCE",
                connectionId: attachment.connectionId,
                principalId: attachment.access.principalId,
                username: attachment.access.name,
                ...presence,
              }),
            );
        }
      }
    } catch (error) {
      this.sendText(
        socket,
        JSON.stringify({
          type: "ERROR",
          message: error instanceof Error ? error.message : "连接失败",
        }),
      );
      socket.close(4003, "Invalid message");
    }
  }

  async onClose(socket: RoomConnection) {
    const attachment = socket.state as Attachment | undefined;

    if (attachment?.connectionId)
      for (const peer of this.getConnections<SocketState>())
        if (await this.authorizeSocket(peer))
          this.sendText(
            peer,
            JSON.stringify({
              type: "LEFT",
              connectionId: attachment.connectionId,
            }),
          );
  }

  private async projectDirectory() {
    const projection = this.transaction(
      { name: "" },
      { type: "projection" },
    ) as DirectoryProjection;

    if (!projection.pending) return;
    try {
      await this.env.DB.batch(
        projectionStatements(this.load()!.id, projection).map((statement) =>
          this.env.DB.prepare(statement.sql).bind(...statement.args),
        ),
      );
      this.transaction(
        { name: "" },
        { type: "projectionAck", revision: projection.revision },
      );
    } catch (error) {
      console.error(
        "共享目录投影重试失败",
        error instanceof Error ? error.message : "unknown",
      );
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }

  async onAlarm() {
    await this.projectDirectory();
    const gcAt = await this.ctx.storage.get<number>("gcAt");

    if (gcAt && gcAt <= Date.now()) {
      const room = this.load()!;
      const referenced = referencedRoomObjects(room);
      let cursor: string | undefined;

      do {
        const page = await this.env.BLOB.list({
          prefix: `collaboration/${room.id}/`,
          cursor,
          limit: 100,
        });
        const orphans = page.objects
          .filter(
            (object) =>
              !referenced.has(object.key) &&
              object.uploaded.getTime() < Date.now() - ROOM_OBJECT_GRACE,
          )
          .map((object) => object.key);

        if (orphans.length) await this.env.BLOB.delete(orphans);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);

      await this.ctx.storage.put("gcAt", Date.now() + ROOM_OBJECT_GRACE);
    }

    for (const socket of this.getConnections<SocketState>()) {
      const attachment = socket.state as Attachment | undefined;

      if (
        !attachment?.principal &&
        attachment &&
        attachment.expiresAt <= Date.now()
      )
        socket.close(4003, "Authentication timeout");
      else await this.authorizeSocket(socket);
    }

    if (
      [...this.getConnections<SocketState>()].length ||
      this.load()?.directoryPending
    )
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    else if (gcAt)
      await this.ctx.storage.setAlarm(
        Math.max(
          Date.now() + 60000,
          (await this.ctx.storage.get<number>("gcAt")) ??
            Date.now() + ROOM_OBJECT_GRACE,
        ),
      );
  }
}

export async function hashSecret(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
