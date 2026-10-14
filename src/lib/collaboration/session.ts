import type { CanvasScene } from "#shared/contracts";
import type {
  Access,
  CanvasView,
  Commit,
  Element,
  Operation,
} from "#shared/collaboration/types";
import { orderElements, wins } from "#shared/collaboration/merge";
import { api, ApiError } from "~/lib/api";
import { ConfirmedCache } from "~/lib/confirmedCache";
import { getTabScope } from "~/lib/persistence";
import { draftStorage, type Draft } from "~/lib/collaboration/storage";
import ReconnectingWebSocket from "partysocket/ws";

export type HydratedView = Omit<CanvasView, "scene"> & { scene: CanvasScene };

export type SessionStatus =
  | "checking"
  | "connecting"
  | "ready"
  | "saving"
  | "offline"
  | "error"
  | "recovery"
  | "denied";

export interface SessionOptions {
  canvasId: string;
  userId?: string;
  token?: string;
  scope: string;
  onError?: (error: unknown) => void;
}

const cache = new ConfirmedCache();

/** Confirmed baseline + durable local queue. Only the acknowledged operation leaves the queue. */
export class CollaborationSession {
  view?: HydratedView;
  value: CanvasScene = { elements: [], appState: {}, files: {} };
  status: SessionStatus = "checking";
  message = "";
  readonly peers = new Map<string, Record<string, unknown>>();
  private listeners = new Set<() => void>();
  private operations: Operation[] = [];
  private files: CanvasScene["files"] = {};
  private clientId = "";
  private clientSeq = 0;
  private draftKey = "";
  private socket?: ReconnectingWebSocket;
  private connecting?: Promise<void>;
  private sending?: Promise<void>;
  private sendingOpId = "";
  private loading?: Promise<void>;
  private writes?: Promise<void>;
  private checkpointPending = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private subscribed = false;
  private authorizedOnce = false;
  private failures = 0;

  constructor(readonly options: SessionOptions) {}

  get dirty() {
    return this.operations.length > 0;
  }

  get inactive() {
    return !this.listeners.size && !this.dirty && !this.sending;
  }

  get editable() {
    return (
      this.authorizedOnce &&
      this.view?.access.role !== "viewer" &&
      !["checking", "connecting", "recovery", "denied", "error"].includes(
        this.status,
      )
    );
  }

  get statusText() {
    if (this.status === "denied") return "访问已失效";
    if (this.status === "recovery") return "草稿需要恢复";
    if (this.status === "checking") return "正在校验版本…";
    if (this.status === "connecting") return "正在连接协作…";
    if (this.status === "error") return "同步失败 · 只读";
    if (this.status === "offline")
      return this.dirty ? "离线 · 已保存本地草稿" : "离线";
    if (this.dirty) return "正在同步…";
    if (this.view?.access.viewMode === "fixed")
      return `固定版本 · ${this.view.snapshot?.label ?? ""}`;
    if (this.view?.access.viewMode === "latest")
      return `最新版 · ${new Date(this.view.readAt).toLocaleTimeString()}`;
    if (this.view?.access.role === "viewer") return "实时查看";

    return "已保存";
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && !this.dirty) this.disconnect();
    };
  }

  private disconnect() {
    const socket = this.socket;

    this.socket = undefined;
    this.subscribed = false;
    this.peers.clear();
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    clearTimeout(this.retryTimer);
    socket?.close();
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private headers() {
    return {
      ...(this.options.userId
        ? { "X-Account-Owner": this.options.userId }
        : {}),
      ...(this.options.token ? { "X-Canvas-Access": this.options.token } : {}),
    };
  }

  request<T>(
    path: string,
    payload?: unknown,
    method = payload === undefined ? "GET" : "POST",
  ) {
    return api<T>(
      `/api/canvases/${encodeURIComponent(this.options.canvasId)}/collaboration/${path}`,
      {
        method,
        headers: this.headers(),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      },
    );
  }

  async start(connect = true) {
    if (this.connecting || this.disposed) return this.connecting;
    this.connecting = this.initialize(connect).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private async initialize(connect: boolean) {
    try {
      const access = await this.request<Access>("access");

      if (
        this.dirty &&
        this.view &&
        (access.role !== this.view.access.role ||
          access.grantId !== this.view.access.grantId ||
          access.viewMode !== this.view.access.viewMode)
      )
        throw new ApiError(
          409,
          "DRAFT_RECOVERY_REQUIRED",
          "权限已变更，请先下载尚未同步的草稿",
        );
      const identity = this.options.userId ?? access.principalId;
      const scope = JSON.stringify([
        1,
        identity,
        this.options.canvasId,
        access.grantId,
        access.role,
        access.viewMode,
        access.snapshotId ?? "",
        access.epoch,
      ]);

      // Keep the draft discoverable across restore epochs; refresh then refuses
      // to merge the old queue and offers recovery instead of hiding it.
      const draftScope = JSON.stringify(JSON.parse(scope).slice(0, -1));

      this.draftKey = `${draftScope}:tab:${await getTabScope()}`;
      const cached = await cache.get<HydratedView>(scope);

      if (!this.view && cached) {
        this.view = cached;
        this.value = cached.scene;
        this.changed();
      }

      const draft = await draftStorage(this.draftKey, "get");

      this.clientId = draft?.clientId ?? crypto.randomUUID();
      this.clientSeq = draft?.clientSeq ?? 0;
      this.operations = draft?.operations ?? [];
      this.files = draft?.files ?? {};
      if (this.dirty && draft?.scene) this.value = draft.scene;
      if (access.role === "viewer" && this.dirty)
        throw new ApiError(
          409,
          "DRAFT_RECOVERY_REQUIRED",
          "权限已变为只读，尚未同步的草稿可下载保留",
        );
      await this.refresh();
      if (this.disposed) return;
      this.authorizedOnce = true;
      if (access.viewMode === "live" && connect) await this.connect();
      else {
        this.status = "ready";
        this.changed();
      }

      this.pollTimer ??= setInterval(() => {
        void this.recheckAccess();
      }, 50000);
    } catch (error) {
      this.failed(error);
    }
  }

  private cacheScope(view: HydratedView) {
    return JSON.stringify([
      1,
      this.options.userId ?? view.access.principalId,
      this.options.canvasId,
      view.access.grantId,
      view.access.role,
      view.access.viewMode,
      view.access.snapshotId ?? "",
      view.epoch,
    ]);
  }

  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const next = await this.request<HydratedView>("view");

      if (this.disposed) return;
      if (this.operations.some((op) => op.epoch !== next.epoch))
        throw new ApiError(
          409,
          "DRAFT_RECOVERY_REQUIRED",
          "画布已恢复或替换，离线草稿需要下载后手动恢复",
        );
      if (this.view?.epoch === next.epoch && next.seq < this.view.seq) return;
      this.view = next;
      this.rebase();
      await cache.put(this.cacheScope(next), { ...next, revision: next.seq });
      this.changed();
    })().finally(() => {
      this.loading = undefined;
    });

    return this.loading;
  }

  private rebase() {
    if (!this.view) return;
    const elements = new Map(
      (this.view.scene.elements as Element[]).map((element) => [
        element.id,
        element,
      ]),
    );
    const appState = { ...this.view.scene.appState };

    for (const op of this.operations) {
      for (const element of op.elements) {
        const previous = elements.get(element.id);

        if (!previous || wins(element, previous))
          elements.set(element.id, element);
      }

      if (
        op.background &&
        (appState.viewBackgroundColor ?? null) === op.background.base
      )
        appState.viewBackgroundColor = op.background.value;
    }

    this.value = {
      elements: orderElements(elements.values()),
      appState,
      files: { ...this.view.scene.files, ...this.files },
    };
  }

  update(scene: CanvasScene, preconditions?: Operation["preconditions"]) {
    if (!this.editable || !this.view) return;
    const previous = new Map(
      (this.value.elements as Element[]).map((element) => [
        element.id,
        element,
      ]),
    );
    // Excalidraw increments version/nonce for edits. Restoring remote JSON may
    // fill legacy defaults without creating an edit; never echo that normalization.
    const changed = (scene.elements as Element[]).filter((element) => {
      const before = previous.get(element.id);

      return (
        !before ||
        before.version !== element.version ||
        before.versionNonce !== element.versionNonce
      );
    });
    const before = this.value.appState.viewBackgroundColor ?? null;
    const background =
      typeof scene.appState.viewBackgroundColor === "string" &&
      scene.appState.viewBackgroundColor !== (before ?? "#ffffff")
        ? {
            value: scene.appState.viewBackgroundColor,
            base: before as string | null,
          }
        : undefined;

    if (!changed.length && !background) return;
    for (const element of changed)
      if (
        element.type === "image" &&
        typeof element.fileId === "string" &&
        scene.files[element.fileId] &&
        !this.view.scene.files[element.fileId]
      )
        this.files[element.fileId] = scene.files[element.fileId];
    const tail = this.operations.at(-1);

    if (
      tail &&
      tail.opId !== this.sendingOpId &&
      !preconditions &&
      !tail.preconditions
    ) {
      const elements = new Map(
        tail.elements.map((element) => [element.id, element]),
      );

      for (const element of changed) elements.set(element.id, element);
      tail.elements = [...elements.values()];
      if (background)
        tail.background = {
          value: background.value,
          base: tail.background?.base ?? background.base,
        };
    } else
      this.operations.push({
        protocolVersion: 1,
        epoch: this.view.epoch,
        clientId: this.clientId,
        clientSeq: ++this.clientSeq,
        opId: crypto.randomUUID(),
        baseSeq: this.view.seq,
        elements: changed,
        ...(preconditions ? { preconditions } : {}),
        ...(background ? { background } : {}),
      });
    this.rebase();
    this.changed();
    void this.checkpoint().catch((error: unknown) => this.failed(error));
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flush().catch((error: unknown) => this.failed(error));
    }, 150);

    return true;
  }

  /** Migrate only locally changed elements, keeping remote additions and tombstones. */
  async adoptLegacyDraft(
    baseline: CanvasScene,
    local: CanvasScene,
    expectedEpoch: string,
  ) {
    if (!this.editable || !this.view)
      throw new Error("协作尚未就绪，原草稿已保留");
    if (this.view.epoch !== expectedEpoch)
      throw new ApiError(
        409,
        "DRAFT_RECOVERY_REQUIRED",
        "画布已恢复，原草稿已保留，请下载后手动恢复",
      );
    const before = new Map(
      (baseline.elements as Element[]).map((element) => [element.id, element]),
    );
    const remoteIds = new Set(
      (this.value.elements as Element[]).map((element) => element.id),
    );
    const changed = (local.elements as Element[]).filter((element) => {
      const original = before.get(element.id);

      // A locally created-and-deleted element was never shared. In particular,
      // its image data may already be pruned by the native serializer.
      if (element.isDeleted && !original && !remoteIds.has(element.id))
        return false;

      return (
        !original ||
        original.version !== element.version ||
        original.versionNonce !== element.versionNonce
      );
    });
    // Excalidraw snapshots omit deleted elements. Encode only deletions relative
    // to the old confirmed baseline, never deletions of new remote elements.
    const present = new Set(
      (local.elements as Element[]).map((element) => element.id),
    );

    for (const element of before.values())
      if (!element.isDeleted && !present.has(element.id))
        changed.push({
          ...element,
          isDeleted: true,
          version: element.version + 1,
          versionNonce: 0,
        });
    const merged = new Map(
      (this.value.elements as Element[]).map((element) => [
        element.id,
        element,
      ]),
    );

    for (const element of changed) merged.set(element.id, element);
    const appState = { ...this.value.appState };
    const baseBackground = baseline.appState.viewBackgroundColor ?? "#ffffff";
    const localBackground = local.appState.viewBackgroundColor ?? "#ffffff";

    if (
      localBackground !== baseBackground &&
      (appState.viewBackgroundColor ?? "#ffffff") === baseBackground
    )
      appState.viewBackgroundColor = localBackground;
    this.update({
      elements: [...merged.values()],
      appState,
      files: { ...this.value.files, ...local.files },
    });
    await this.checkpoint();
  }

  checkpoint() {
    if (!this.draftKey) return Promise.resolve();
    this.checkpointPending = true;
    this.writes ??= (async () => {
      // Bound queued IndexedDB work while a drag produces changes faster than
      // storage can commit: one in flight plus the latest complete draft.
      while (this.checkpointPending) {
        this.checkpointPending = false;
        const snapshot: Draft = {
          clientId: this.clientId,
          clientSeq: this.clientSeq,
          operations: structuredClone(this.operations),
          files: structuredClone(this.files),
          ...(this.dirty ? { scene: structuredClone(this.value) } : {}),
          updatedAt: new Date().toISOString(),
        };

        await draftStorage(this.draftKey, "put", snapshot);
      }
    })().finally(() => {
      this.writes = undefined;
    });

    return this.writes;
  }

  async flush(): Promise<void> {
    await this.checkpoint();
    if (!this.dirty) return;
    if (this.sending) {
      await this.sending;
      if (this.dirty && this.editable) return this.flush();

      return;
    }

    if (
      !this.authorizedOnce ||
      ["denied", "recovery", "error"].includes(this.status)
    )
      throw new Error(this.message || "尚未确认协作权限");
    this.sending = this.sendPending()
      .catch((error) => {
        this.failed(error);
        throw error;
      })
      .finally(() => {
        this.sending = undefined;
        this.sendingOpId = "";
      });

    return this.sending;
  }

  private async sendPending() {
    while (this.operations.length && !this.disposed) {
      const op = this.operations[0]!;

      this.sendingOpId = op.opId;

      this.status = "saving";
      this.changed();
      for (const element of op.elements) {
        if (
          element.type !== "image" ||
          typeof element.fileId !== "string" ||
          this.view!.scene.files[element.fileId]
        )
          continue;
        const file = this.files[element.fileId];

        if (!file) throw new Error("本地图片文件缺失，请下载备份");
        await this.request("assets", file);
      }

      const commit = await this.request<Commit>("update", op);

      // An ACK never clears updates produced while this request was in flight.
      this.operations = this.operations.filter(
        (pending) => pending.opId !== op.opId,
      );
      await this.accept(commit);
      const referenced = new Set(
        this.operations.flatMap((pending) =>
          pending.elements.map((element) => element.fileId),
        ),
      );

      for (const id of Object.keys(this.files))
        if (!referenced.has(id)) delete this.files[id];
      await this.checkpoint();
      this.message = commit.skipped.length
        ? "部分同时修改已采用房间中的更新内容"
        : "";
    }

    this.failures = 0;
    this.status =
      this.subscribed || this.view?.access.viewMode !== "live"
        ? "ready"
        : "offline";
    this.rebase();
    this.changed();
    if (!this.listeners.size) this.disconnect();
  }

  private async accept(commit: Commit) {
    if (commit.replayed) {
      await this.refresh();

      return;
    }

    if (!this.view || commit.epoch !== this.view.epoch) {
      await this.refresh();

      return;
    }

    if (commit.seq > this.view.seq + 1) {
      await this.refresh();

      return;
    }

    if (commit.seq > this.view.seq) {
      const elements = new Map(
        (this.view.scene.elements as Element[]).map((element) => [
          element.id,
          element,
        ]),
      );

      for (const element of commit.elements) elements.set(element.id, element);
      const appState = {
        ...this.view.scene.appState,
        ...(commit.background === undefined
          ? {}
          : { viewBackgroundColor: commit.background }),
      };

      this.view = {
        ...this.view,
        seq: commit.seq,
        scene: {
          ...this.view.scene,
          elements: orderElements(elements.values()),
          appState,
          files: { ...this.view.scene.files, ...this.files },
        },
      };
      if (
        commit.elements.some(
          (element) =>
            element.type === "image" &&
            typeof element.fileId === "string" &&
            !this.view!.scene.files[element.fileId],
        )
      )
        await this.refresh();
    }

    this.rebase();
    await cache.put(this.cacheScope(this.view), {
      ...this.view,
      revision: this.view.seq,
    });
    this.changed();
  }

  private async connect() {
    if (this.disposed || this.socket || this.view?.access.viewMode !== "live")
      return;
    this.status = "connecting";
    this.changed();
    const url = new URL(
      `/api/canvases/${encodeURIComponent(this.options.canvasId)}/realtime`,
      location.origin,
    );

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let ticket = "";
    const socket = new ReconnectingWebSocket(
      async () => {
        try {
          // A one-use ticket belongs to this attempt, never to the reconnecting socket.
          await this.recheckAccess();
          if (this.disposed || ["denied", "recovery"].includes(this.status))
            throw new Error("协作连接已停止");
          ({ ticket } = await this.request<{ ticket: string }>("ticket", {}));

          return url.href;
        } catch (error) {
          if (!["denied", "recovery"].includes(this.status)) this.failed(error);
          throw error;
        }
      },
      [],
      {
        WebSocket,
        minReconnectionDelay: 1000,
        maxReconnectionDelay: 15000,
        reconnectionDelayGrowFactor: 2,
        connectionTimeout: 10000,
        // Durable edits use the acknowledged HTTP queue. Presence can be dropped.
        maxEnqueuedMessages: 0,
      },
    );

    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "AUTH", ticket }));
    socket.onmessage = (event) => {
      void (async () => {
        if (this.disposed || socket !== this.socket) return;
        const message = JSON.parse(event.data);

        if (message.type === "READY") {
          this.subscribed = true;
          await this.refresh();
          this.status = "ready";
          this.changed();
          await this.flush();
        } else if (message.type === "COMMIT") await this.accept(message);
        else if (message.type === "RESYNC") await this.refresh();
        else if (message.type === "PRESENCE") {
          this.peers.set(message.connectionId, {
            ...message,
            id: message.principalId,
          });
          this.changed();
        } else if (message.type === "LEFT") {
          this.peers.delete(message.connectionId);
          this.changed();
        } else if (
          message.type === "ACCESS_CHANGED" ||
          message.type === "ERROR"
        ) {
          this.status = "denied";
          this.message = message.message;
          this.socket?.close();
          this.changed();
        }
      })().catch((error: unknown) => this.failed(error));
    };

    socket.onclose = () => {
      if (socket !== this.socket || this.disposed) return;
      this.subscribed = false;
      this.peers.clear();
      if (["denied", "recovery"].includes(this.status)) return;
      this.status = "offline";
      this.changed();
    };

    socket.onerror = () => {
      if (this.disposed || ["denied", "recovery"].includes(this.status)) return;
      this.subscribed = false;
      this.status = this.authorizedOnce ? "offline" : "error";
      this.message = "连接中断，正在重连；修改会保留在本地";
      this.changed();
    };
  }

  private async recheckAccess() {
    if (this.disposed) return;
    try {
      const access = await this.request<Access>("access");

      if (this.view?.access.viewMode !== "live" && this.status === "offline") {
        this.status = "ready";
        this.changed();
      }

      if (
        this.view &&
        (access.epoch !== this.view.access.epoch ||
          access.grantId !== this.view.access.grantId ||
          access.role !== this.view.access.role ||
          access.viewMode !== this.view.access.viewMode ||
          access.snapshotId !== this.view.access.snapshotId)
      ) {
        this.status = "denied";
        this.message = "分享权限已变更，请重新加载画布";
        this.socket?.close();
        this.changed();
      }
    } catch (error) {
      this.failed(error);
    }
  }

  presence(value: unknown) {
    if (this.subscribed && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({ type: "PRESENCE", ...(value as object) }),
      );
  }

  private failed(error: unknown) {
    if (this.disposed) return;
    this.message = error instanceof Error ? error.message : "协作同步失败";
    if (
      error instanceof ApiError &&
      [401, 403, 404, 410].includes(error.status)
    ) {
      this.status = "denied";
      this.socket?.close();
    } else if (
      error instanceof ApiError &&
      [400, 409, 413, 415].includes(error.status)
    ) {
      this.status = "recovery";
      this.socket?.close();
    } else {
      this.status = this.authorizedOnce ? "offline" : "error";
      this.retry();
    }

    this.options.onError?.(error);
    this.changed();
  }

  private retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        void (async () => {
          if (this.authorizedOnce) {
            await this.recheckAccess();
            if (["denied", "recovery"].includes(this.status)) return;
            await this.connect();
            await this.flush();
          } else await this.start();
        })().catch((error: unknown) => this.failed(error));
      },
      Math.min(15000, 1000 * 2 ** Math.min(this.failures++, 4)),
    );
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.saveTimer);
    clearInterval(this.pollTimer);
    this.socket?.close();
    this.listeners.clear();
  }
}

const sessions = new Map<string, CollaborationSession>();

export function collaborationSession(options: SessionOptions) {
  const key = JSON.stringify([
    options.scope,
    options.userId,
    options.canvasId,
    options.token,
  ]);
  let session = sessions.get(key);

  // Map order is the LRU. Active editors and unsaved queues stay pinned.
  sessions.delete(key);
  const inactive = [...sessions].filter(([, candidate]) => candidate.inactive);

  for (const [oldKey, candidate] of inactive.slice(
    0,
    Math.max(0, inactive.length - 4),
  )) {
    candidate.dispose();
    sessions.delete(oldKey);
  }

  if (!session) {
    session = new CollaborationSession(options);
  }

  sessions.set(key, session);

  return session;
}

export async function flushCollaboration(userId: string) {
  await Promise.all(
    [...sessions.values()]
      .filter((session) => session.options.userId === userId)
      .map((session) => session.flush()),
  );
}

export function closeCollaboration(userId?: string, scope?: string) {
  for (const [key, session] of sessions)
    if (
      (!userId || session.options.userId === userId) &&
      (!scope || session.options.scope === scope)
    ) {
      session.dispose();
      sessions.delete(key);
    }
}
