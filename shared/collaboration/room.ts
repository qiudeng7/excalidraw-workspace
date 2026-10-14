import {
  canonical,
  mergeElements,
  reject,
  validateElement,
} from "#shared/collaboration/merge";
import {
  MAX_OPERATION_BYTES,
  MAX_SCENE_BYTES,
  OPERATION_RETENTION,
  PROTOCOL_VERSION,
  type Access,
  type CanvasView,
  type FileReference,
  type Grant,
  type Operation,
  type Principal,
  type RoomState,
  type SharedScene,
} from "#shared/collaboration/types";
import { validateGrant } from "#shared/collaboration/state";

export { createRoom, validateGrant } from "#shared/collaboration/state";
import {
  exportRoom,
  importRoom,
  type RoomBackup,
} from "#shared/collaboration/backup";

export function authorize(
  room: RoomState,
  principal: Principal,
  now: number,
): Access {
  if (room.deleted || room.recycledAt)
    reject("CANVAS_DELETED", "画布已删除", 410);
  let grant: Grant | undefined;
  let principalId = principal.userId ? `user:${principal.userId}` : "";
  let name = principal.name;

  // Explicit link context must never inherit the account's broader member/owner rights.
  if (principal.capabilityHash) {
    const capability = room.capabilities[principal.capabilityHash];

    if (
      !capability ||
      capability.expiresAt <= now ||
      capability.userId !== principal.userId
    )
      reject("ACCESS_REVOKED", "分享访问已失效，请重新打开链接", 403);
    const link = room.links.find((link) => link.id === capability.linkId);

    if (
      !link ||
      (link.expiresAt !== null && link.expiresAt <= now) ||
      (link.requireLogin && !principal.userId)
    )
      reject("ACCESS_REVOKED", "分享链接已失效", 403);
    grant = link;
    principalId = capability.principalId;
    name = capability.name;
  } else if (principal.userId === room.ownerId) {
    return {
      epoch: room.epoch,
      principalId,
      name,
      grantId: "owner",
      role: "owner",
      viewMode: "live",
      accessRevision: room.accessRevision,
    };
  } else {
    grant = room.members.find((member) => member.userId === principal.userId);
  }

  if (!grant)
    reject("FORBIDDEN", "没有此画布的访问权限", principal.userId ? 403 : 401);
  if (
    grant.viewMode === "fixed" &&
    !room.versions.some((version) => version.id === grant.snapshotId)
  )
    reject("VERSION_UNAVAILABLE", "此固定版本已失效", 410);

  return {
    epoch:
      grant.viewMode === "fixed"
        ? room.versions.find((version) => version.id === grant.snapshotId)!
            .epoch
        : room.epoch,
    principalId,
    name,
    grantId: grant.id,
    role: grant.role,
    viewMode: grant.role === "editor" ? "live" : grant.viewMode,
    ...(grant.snapshotId ? { snapshotId: grant.snapshotId } : {}),
    accessRevision: room.accessRevision,
  };
}

export function requireOwner(access: Access) {
  if (access.role !== "owner")
    reject("OWNER_REQUIRED", "只有所有者可以管理分享", 403);
}

export function view(room: RoomState, access: Access, now: number): CanvasView {
  const version =
    access.viewMode === "fixed"
      ? room.versions.find((item) => item.id === access.snapshotId)!
      : undefined;
  const snapshot = version;

  return {
    protocolVersion: PROTOCOL_VERSION,
    canvasId: room.id,
    name: version?.name ?? room.name,
    epoch: version?.epoch ?? room.epoch,
    seq: version?.seq ?? room.seq,
    access,
    scene: version
      ? { elements: [], appState: {}, files: version.files }
      : {
          ...room.scene,
          files: Object.fromEntries(
            room.scene.elements
              .filter(
                (element) =>
                  !element.isDeleted &&
                  element.type === "image" &&
                  typeof element.fileId === "string",
              )
              .map((element) => [
                element.fileId as string,
                room.scene.files[element.fileId as string]!,
              ]),
          ),
        },
    ...(version ? { snapshot: snapshot as CanvasView["snapshot"] } : {}),
    readAt: new Date(now).toISOString(),
  };
}

export type Command =
  | { type: "view" }
  | { type: "access" }
  | { type: "update"; operation: Operation; digest: string }
  | { type: "asset"; file: FileReference }
  | { type: "manage" }
  | {
      type: "member";
      member: Record<string, unknown> & {
        userId: string;
        name: string;
        id: string;
      };
    }
  | { type: "removeMember"; userId: string }
  | {
      type: "link";
      link: Record<string, unknown> & {
        id: string;
        secretHash: string;
        requireLogin: boolean;
        expiresAt: number | null;
      };
    }
  | { type: "removeLink"; id: string }
  | {
      type: "publish";
      id: string;
      label: string;
      snapshot: {
        sceneKey: string;
        epoch: string;
        seq: number;
        name: string;
        files: SharedScene["files"];
      };
    }
  | { type: "removeVersion"; id: string }
  | { type: "ticket"; hash: string }
  | { type: "authenticate"; hash: string }
  | {
      type: "exchange";
      secretHash: string;
      capabilityHash: string;
      guestId: string;
    }
  | { type: "delete" }
  | {
      type: "recycle";
      deletedAt: string | null;
      revision: number;
      epoch: string;
    }
  | { type: "rename"; name: string }
  | { type: "backup" }
  | {
      type: "restore";
      backup: RoomBackup;
      epoch: string;
      expectedEpoch: string;
      expectedSeq: number;
      expectedAccessRevision: number;
    }
  | { type: "projection" }
  | { type: "projectionAck"; revision: number };

/** Executes on a transaction-local copy. The adapter persists before returning/broadcasting. */
export function execute(
  room: RoomState,
  principal: Principal,
  command: Command,
  now: number,
): unknown {
  if (command.type === "projection")
    return {
      revision: room.accessRevision,
      userIds:
        room.deleted || room.recycledAt
          ? []
          : room.members.map((member) => member.userId),
      pending: room.directoryPending,
      name: room.name,
      epoch: room.epoch,
    };
  if (command.type === "projectionAck") {
    if (room.accessRevision === command.revision) room.directoryPending = false;

    return { ok: true };
  }

  // Catalog-owned reversible suspension. Keep grants and assets until final deletion.
  if (command.type === "recycle" || command.type === "delete") {
    if (principal.userId !== room.ownerId || principal.capabilityHash)
      reject("FORBIDDEN", "只有所有者可以操作回收站", 403);
    if (command.type === "recycle") {
      if (room.deleted) reject("CANVAS_DELETED", "画布已彻底删除", 410);
      if (command.revision <= (room.recycleRevision ?? 0)) return { ok: true };
      if (!command.deletedAt) {
        room.epoch = command.epoch;
        room.seq = 0;
        room.minMergeSeq = 0;
        room.operations = {};
        room.clients = {};
      }

      room.recycledAt = command.deletedAt;
      room.recycleRevision = command.revision;
    } else {
      room.deleted = true;
      room.members = [];
      room.links = [];
      room.capabilities = {};
      room.scene = { elements: [], appState: {}, files: {} };
      room.versions = [];
      room.operations = {};
      room.clients = {};
    }

    room.tickets = {};
    room.directoryPending = true;
    room.accessRevision++;

    return { ok: true };
  }

  if (command.type === "exchange") {
    if (room.deleted || room.recycledAt)
      reject("CANVAS_DELETED", "画布已删除", 410);
    const link = room.links.find(
      (link) =>
        link.secretHash === command.secretHash &&
        (link.expiresAt === null || link.expiresAt > now),
    );

    if (!link) reject("INVALID_SHARE", "分享链接无效或已过期", 403);
    if (link.requireLogin && !principal.userId)
      reject("LOGIN_REQUIRED", "此分享链接需要登录", 401);
    if (Object.keys(room.capabilities).length >= 5000) {
      for (const [key, capability] of Object.entries(room.capabilities))
        if (capability.expiresAt <= now) delete room.capabilities[key];
      if (Object.keys(room.capabilities).length >= 5000)
        reject("CAPABILITY_LIMIT", "分享访问人数过多，请稍后重试", 429);
    }

    const expiresAt = Math.min(now + 14 * 86400000, link.expiresAt ?? Infinity);

    room.capabilities[command.capabilityHash] = {
      linkId: link.id,
      principalId: principal.userId
        ? `user:${principal.userId}`
        : `guest:${command.guestId}`,
      userId: principal.userId,
      name: principal.userId ? principal.name : "访客",
      expiresAt,
    };
    for (const [key, capability] of Object.entries(room.capabilities))
      if (capability.expiresAt <= now) delete room.capabilities[key];

    return { expiresAt };
  }

  if (command.type === "authenticate") {
    const ticket = room.tickets[command.hash];

    delete room.tickets[command.hash];
    if (!ticket || ticket.expiresAt <= now)
      reject("INVALID_TICKET", "连接凭证已过期", 403);
    const access = authorize(room, ticket.principal, now);

    if (access.viewMode !== "live")
      reject("LIVE_ACCESS_REQUIRED", "此查看模式不能连接实时房间", 403);

    return { access, principal: ticket.principal };
  }

  const access = authorize(room, principal, now);

  switch (command.type) {
    case "access":
      return access;
    case "view":
      return view(room, access, now);
    case "ticket": {
      if (access.viewMode !== "live")
        reject("LIVE_ACCESS_REQUIRED", "此查看模式不能连接实时房间", 403);
      for (const [key, ticket] of Object.entries(room.tickets))
        if (ticket.expiresAt <= now) delete room.tickets[key];
      if (Object.keys(room.tickets).length >= 200)
        reject("ROOM_BUSY", "房间连接过多，请稍后重试", 429);
      room.tickets[command.hash] = {
        access,
        principal,
        expiresAt: now + 60000,
      };

      return { expiresAt: now + 60000 };
    }

    case "update": {
      if (access.role === "viewer")
        reject("READ_ONLY", "查看者不能编辑画布", 403);
      const op = command.operation;

      if (op.protocolVersion !== PROTOCOL_VERSION)
        reject("PROTOCOL_REQUIRED", "请刷新页面更新协作协议", 409);
      if (
        (room.scene.elements.some(
          (element) => element.richText !== undefined,
        ) ||
          op.elements?.some?.((element) => element.richText !== undefined)) &&
        op.textFormatVersion !== 1
      )
        reject(
          "TEXT_FORMAT_REQUIRED",
          "画布包含富文本，请刷新页面后继续编辑",
          409,
        );
      if (
        typeof op.opId !== "string" ||
        !op.opId ||
        op.opId.length > 100 ||
        ["__proto__", "constructor", "prototype"].includes(op.opId) ||
        typeof op.clientId !== "string" ||
        !op.clientId ||
        op.clientId.length > 100 ||
        ["__proto__", "constructor", "prototype"].includes(op.clientId) ||
        !Number.isSafeInteger(op.clientSeq) ||
        op.clientSeq < 1 ||
        !Number.isSafeInteger(op.baseSeq) ||
        op.baseSeq < 0 ||
        !Array.isArray(op.elements)
      )
        reject("INVALID_OPERATION", "操作格式无效");
      if (op.epoch !== room.epoch)
        reject(
          "DRAFT_RECOVERY_REQUIRED",
          "此离线草稿已超出合并窗口，请下载备份后重新打开画布",
          409,
        );
      if (op.baseSeq > room.seq)
        reject("INVALID_SEQUENCE", "客户端版本超前，请重新连接", 409);
      const prior = room.operations[op.opId];

      if (prior) {
        if (
          prior.digest !== command.digest ||
          prior.principalId !== access.principalId
        )
          reject("OPERATION_REUSED", "操作标识不能复用于其他内容", 409);

        return { ...prior.commit, replayed: true };
      }

      if (op.baseSeq < room.minMergeSeq)
        reject(
          "DRAFT_RECOVERY_REQUIRED",
          "此离线草稿已超出合并窗口，请下载备份后重新打开画布",
          409,
        );

      const client = room.clients[op.clientId];

      if (
        client &&
        (client.principalId !== access.principalId ||
          op.clientSeq <= client.clientSeq)
      )
        reject(
          "CLIENT_SEQUENCE_REUSED",
          "客户端操作序号冲突，请下载草稿并重新打开画布",
          409,
        );
      if (new TextEncoder().encode(canonical(op)).length > MAX_OPERATION_BYTES)
        reject("OPERATION_TOO_LARGE", "单次协作操作过大，请分批导入", 413);
      const preconditionSkipped: string[] = [];
      const currentElements = new Map(
        room.scene.elements.map((element) => [element.id, element]),
      );
      const incoming = op.elements.filter((element) => {
        validateElement(element);
        const expected = op.preconditions?.[element.id];
        const current = currentElements.get(element.id);

        if (
          expected &&
          (!current ||
            current.version !== expected.version ||
            current.versionNonce !== expected.versionNonce)
        ) {
          preconditionSkipped.push(element.id);

          return false;
        }

        return true;
      });
      const result = mergeElements(room.scene, incoming);

      result.skipped.push(...preconditionSkipped);
      let background: string | undefined;

      if (op.background) {
        if (
          typeof op.background.value !== "string" ||
          op.background.value.length > 100
        )
          reject("INVALID_BACKGROUND", "背景颜色无效");
        if (
          (room.scene.appState.viewBackgroundColor ?? null) ===
          op.background.base
        )
          background = op.background.value;
        else result.skipped.push("viewBackgroundColor");
      }

      const nextScene = {
        ...room.scene,
        elements: result.elements,
        appState:
          background === undefined
            ? room.scene.appState
            : { viewBackgroundColor: background },
      };

      if (
        new TextEncoder().encode(JSON.stringify(nextScene)).length >
        MAX_SCENE_BYTES
      )
        reject("SCENE_TOO_LARGE", "画布内容不能超过 20 MB", 413);
      room.scene = nextScene;
      room.seq++;
      const commit = {
        type: "COMMIT" as const,
        epoch: room.epoch,
        seq: room.seq,
        opId: op.opId,
        clientId: op.clientId,
        elements: [
          ...new Map(
            [
              ...result.changed,
              ...op.elements
                .map((element) =>
                  room.scene.elements.find(
                    (current) => current.id === element.id,
                  ),
                )
                .filter(
                  (element): element is NonNullable<typeof element> =>
                    !!element,
                ),
            ].map((element) => [element.id, element]),
          ).values(),
        ],
        ...(background === undefined ? {} : { background }),
        skipped: result.skipped,
      };

      room.operations[op.opId] = {
        digest: command.digest,
        commit: { ...commit, elements: [] },
        principalId: access.principalId,
      };
      room.clients[op.clientId] = {
        principalId: access.principalId,
        clientSeq: op.clientSeq,
      };
      const operations = Object.entries(room.operations);

      let retainedBytes = new TextEncoder().encode(
        JSON.stringify(room.operations),
      ).length;

      if (
        operations.length > OPERATION_RETENTION ||
        retainedBytes > 16 * 1024 * 1024
      ) {
        for (const [index, [key, record]] of operations.entries()) {
          if (
            index >= operations.length - OPERATION_RETENTION &&
            retainedBytes <= 16 * 1024 * 1024
          )
            break;
          if (key === op.opId) break;
          retainedBytes -= new TextEncoder().encode(
            JSON.stringify(record),
          ).length;
          room.minMergeSeq = Math.max(room.minMergeSeq, record.commit.seq);
          delete room.operations[key];
        }

        const retainedClients = new Set(
          Object.values(room.operations).map(
            (record) => record.commit.clientId,
          ),
        );

        for (const clientId of Object.keys(room.clients))
          if (!retainedClients.has(clientId)) delete room.clients[clientId];
      }

      return commit;
    }

    case "asset": {
      if (access.role === "viewer")
        reject("READ_ONLY", "查看者不能上传图片", 403);
      if (["__proto__", "constructor", "prototype"].includes(command.file.id))
        reject("INVALID_ASSET", "图片标识无效");
      const existing = room.scene.files[command.file.id];

      if (existing && existing.objectKey !== command.file.objectKey)
        reject("ASSET_ID_REUSED", "图片标识已对应其他内容", 409);
      if (Object.keys(room.scene.files).length >= 2000 && !existing)
        reject("ASSET_LIMIT", "单张画布最多保存 2000 个图片文件", 413);
      room.scene.files[command.file.id] = command.file;

      return command.file;
    }

    default:
      requireOwner(access);
  }

  switch (command.type) {
    case "manage":
      return {
        members: room.members,
        links: room.links.map(({ secretHash: _, ...link }) => link),
        versions: room.versions,
        accessRevision: room.accessRevision,
      };
    case "member": {
      if (command.member.userId === room.ownerId)
        reject("OWNER_IMMUTABLE", "不能修改所有者角色");
      const grant = validateGrant(room, command.member);

      if (
        room.members.length >= 500 &&
        !room.members.some((member) => member.userId === command.member.userId)
      )
        reject("MEMBER_LIMIT", "单张画布最多邀请 500 个账号", 429);
      room.directoryPending = true;
      room.members = room.members.filter(
        (member) => member.userId !== command.member.userId,
      );
      room.members.push({
        ...grant,
        userId: command.member.userId,
        name: command.member.name,
      });
      room.accessRevision++;

      return { ok: true };
    }

    case "removeMember":
      room.directoryPending = true;
      room.members = room.members.filter(
        (member) => member.userId !== command.userId,
      );
      room.accessRevision++;

      return { ok: true };
    case "link": {
      const grant = validateGrant(room, command.link);

      if (room.links.length >= 100)
        reject("LINK_LIMIT", "分享链接过多，请先撤销不用的链接", 429);
      room.links.push({
        ...grant,
        secretHash: command.link.secretHash,
        requireLogin: command.link.requireLogin,
        expiresAt: command.link.expiresAt,
      });
      room.accessRevision++;

      return { id: grant.id };
    }

    case "removeLink":
      room.links = room.links.filter((link) => link.id !== command.id);
      room.accessRevision++;

      return { ok: true };
    case "publish": {
      const prior = room.versions.find((version) => version.id === command.id);

      if (prior) return { id: prior.id, seq: prior.seq };
      if (room.versions.length >= 30)
        reject(
          "VERSION_LIMIT",
          "最多发布 30 个固定版本，请先删除不用的版本",
          429,
        );
      if (
        command.snapshot.epoch !== room.epoch ||
        command.snapshot.seq > room.seq
      )
        reject("INVALID_SNAPSHOT", "固定版本来源无效", 409);
      room.versions.push({
        id: command.id,
        label: command.label,
        name: command.snapshot.name,
        epoch: command.snapshot.epoch,
        seq: command.snapshot.seq,
        createdAt: new Date(now).toISOString(),
        createdBy: access.principalId,
        sceneKey: command.snapshot.sceneKey,
        files: command.snapshot.files,
      });

      return { id: command.id, seq: command.snapshot.seq };
    }

    case "removeVersion":
      room.versions = room.versions.filter(
        (version) => version.id !== command.id,
      );
      room.accessRevision++;

      return { ok: true };
    case "rename":
      room.name = command.name;
      room.directoryPending = true;
      room.accessRevision++;

      return { ok: true };
    case "backup":
      return exportRoom(room, now);
    case "restore": {
      if (
        room.epoch !== command.expectedEpoch ||
        room.seq !== command.expectedSeq ||
        room.accessRevision !== command.expectedAccessRevision
      )
        reject(
          "RESTORE_CONFLICT",
          "备份上传期间画布或权限已变化，请重新确认恢复点",
          409,
        );
      const restored = importRoom(room, command.backup, command.epoch);

      Object.assign(room, restored);

      return { epoch: room.epoch, seq: room.seq };
    }
  }
}
