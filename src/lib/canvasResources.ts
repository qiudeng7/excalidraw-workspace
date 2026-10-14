import type {
  CanvasDocument,
  CanvasMeta,
  CanvasScene,
  LibraryDocument,
  SaveResult,
} from "#shared/contracts";
import type { WorkspaceApi } from "~/lib/workspaceApi";
import { collaborationSession } from "~/lib/collaboration/session";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { EditorHistory } from "~/lib/editorHistory";
import { ApiError } from "~/lib/api";
import { canvasRevisionScope } from "#shared/snapshotValidator";
import {
  ConfirmedCache,
  cacheKey,
  immutableSnapshot,
  snapshotBytes,
} from "~/lib/confirmedCache";
import { PersistentResource, readCurrentDraft } from "~/lib/persistence";

export interface CanvasResource {
  document: CanvasDocument;
  resource: PersistentResource<CanvasScene>;
  status: "checking" | "ready" | "error" | "conflict";
  message: string;
  touched: number;
  version: number;
  confirmed: boolean;
  metadataGeneration: number;
  historyGeneration: number;
  editorContext?: {
    viewModeEnabled: boolean;
    activeTool: unknown;
    viewport?: Pick<AppState, "scrollX" | "scrollY" | "zoom">;
    history?: EditorHistory;
  };
  accessDenied: boolean;
}

export type LibraryStatus =
  "unloaded" | "loading" | "ready" | "error" | "conflict";

type ReadApi = Pick<
  WorkspaceApi,
  "readCanvas" | "readLibrary" | "validateCanvas" | "validateLibrary"
>;

/** Account lifetime owns writes. Editor lifetime only owns rendering and subscriptions. */
export class CanvasResources {
  readonly canvases = new Map<string, CanvasResource>();
  library?: PersistentResource<unknown[]>;
  libraryStatus: LibraryStatus = "unloaded";
  libraryMessage = "";
  libraryPreview?: unknown[];
  private deleted = new Set<string>();
  private incarnations = new Map<string, number>();
  private invalidations = new Map<string, Promise<void>>();
  private flights = new Map<string, Promise<CanvasResource>>();
  private libraryFlight?: Promise<void>;
  private reads = new Set<AbortController>();
  private disposed = false;
  private activeId = "";
  private editorContexts = new Map<
    string,
    NonNullable<CanvasResource["editorContext"]>
  >();
  private pendingWrites = 0;
  private writeWaiters: (() => void)[] = [];

  constructor(
    readonly owner: string,
    private api: ReadApi,
    private changed: () => void,
    readonly cache = new ConfirmedCache(undefined, 0),
    private prepareHandoff?: (id: string) => Promise<void>,
  ) {}

  private async runRequest(task: () => Promise<SaveResult>) {
    while (this.pendingWrites >= 2)
      await new Promise<void>((resolve) => this.writeWaiters.push(resolve));
    if (this.disposed)
      throw new DOMException("Resource disposed", "AbortError");
    this.pendingWrites++;
    try {
      return await task();
    } finally {
      this.pendingWrites--;
      this.writeWaiters.shift()?.();
    }
  }

  private assertActive() {
    if (this.disposed)
      throw new DOMException("Resource disposed", "AbortError");
  }

  private notify() {
    if (!this.disposed) this.changed();
  }

  async invalidate(id: string) {
    this.incarnations.set(id, (this.incarnations.get(id) ?? 0) + 1);
    this.deleted.add(id);
    this.flights.delete(id);
    this.canvases.get(id)?.resource.dispose();
    this.canvases.delete(id);
    this.editorContexts.delete(id);
    const removing = this.cache.remove(cacheKey(this.owner, "canvas", id));

    this.invalidations.set(id, removing);
    await removing;
    this.notify();
  }

  /** Only an authoritative live catalog may revive a locally invalidated identity. */
  async revive(id: string) {
    if (!this.deleted.has(id)) return;
    const incarnation = this.incarnations.get(id);

    await this.invalidations.get(id);
    this.assertActive();
    if (this.incarnations.get(id) !== incarnation) return;
    this.deleted.delete(id);
    this.invalidations.delete(id);
  }

  setActive(id: string) {
    this.activeId = id;
    this.evict();
  }

  releaseEditorHistory(id: string) {
    const entry = this.canvases.get(id);

    if (entry) {
      // A closing wrapper must not put its just-discarded history back on unmount.
      entry.historyGeneration++;
      if (entry.editorContext) delete entry.editorContext.history;
    }

    const context = this.editorContexts.get(id);

    if (context) delete context.history;
  }

  private evict() {
    // Dirty, in-flight, selected and validating resources are pinned independently of the clean LRU.
    const clean = [...this.canvases.values()]
      .filter(
        (entry) =>
          entry.document.id !== this.activeId &&
          !entry.resource.dirty &&
          !entry.resource.isSaving &&
          !this.flights.has(entry.document.id),
      )
      .sort((a, b) => b.touched - a.touched);
    let bytes = 0;

    for (let index = 0; index < clean.length; index++) {
      const entry = clean[index]!;

      bytes += snapshotBytes(entry.document);
      if (index >= 4 || bytes > 64 * 1024 * 1024) {
        if (entry.editorContext)
          this.editorContexts.set(entry.document.id, entry.editorContext);
        entry.resource.dispose();
        this.canvases.delete(entry.document.id);
      }
    }
  }

  private create(document: CanvasDocument) {
    const entry = {
      document: immutableSnapshot(document),
      status: "checking",
      message: "",
      touched: Date.now(),
      version: 0,
      confirmed: true,
      metadataGeneration: 0,
      historyGeneration: 0,
      accessDenied: false,
      editorContext: this.editorContexts.get(document.id),
    } as CanvasResource;

    this.editorContexts.delete(document.id);

    entry.resource = new PersistentResource({
      key: `${this.owner}:canvas:${document.id}`,
      path: `/api/canvases/${encodeURIComponent(document.id)}`,
      field: "scene",
      value: immutableSnapshot(document.scene),
      revision: document.revision,
      ownerId: this.owner,
      changed: (message) => {
        entry.message = message ?? (entry.resource.dirty ? entry.message : "");
        if (entry.resource.conflict) entry.status = "conflict";
        this.notify();
      },
      onCollaborationRequired: async () => {
        await this.prepareHandoff?.(document.id);
        // The old final-publish CAS was fenced by a concurrent room upgrade.
        queueMicrotask(() => {
          if (!this.disposed && !this.flights.has(document.id))
            void this.open(document.id, () => {}).catch(() => {});
        });
      },
      confirmed: (scene, saved) => {
        entry.confirmed = true;
        entry.document = {
          ...entry.document,
          scene: immutableSnapshot(scene),
          revision: saved.revision,
          updatedAt: saved.updatedAt,
        };
        void this.cache.put(
          cacheKey(this.owner, "canvas", document.id),
          entry.document,
          canvasRevisionScope(entry.document),
        );
      },
      readRemote: async () => {
        const remote = await this.readCanvas(document.id);

        return {
          value: remote.scene,
          revision: remote.revision,
          updatedAt: remote.updatedAt,
        };
      },
      runRequest: (task) => this.runRequest(task),
    });
    this.canvases.set(document.id, entry);

    return entry;
  }

  private async readCanvas(
    id: string,
    known?: CanvasDocument,
    signal?: AbortSignal,
  ) {
    this.assertActive();
    const controller = signal ? undefined : new AbortController();

    if (controller) this.reads.add(controller);
    try {
      const combined = AbortSignal.any([
        signal ?? controller!.signal,
        AbortSignal.timeout(20_000),
      ]);
      const result = this.api.validateCanvas
        ? await this.api.validateCanvas(id, this.owner, known, combined)
        : await this.api.readCanvas(id);

      this.assertActive();
      if (!result && !known) throw new Error("服务端未返回画布内容，请重试。");

      return result ?? known!;
    } finally {
      if (controller) this.reads.delete(controller);
    }
  }

  async open(
    id: string,
    preview: (entry: CanvasResource) => void,
    metadata?: CanvasMeta,
  ): Promise<CanvasResource> {
    if (this.deleted.has(id))
      throw new ApiError(404, "NOT_FOUND", "画布已删除");
    const existing = this.canvases.get(id);

    if (existing) {
      if (existing.document.syncMode !== "collaborative" && this.prepareHandoff)
        await this.prepareHandoff(id);
      this.assertActive();
      existing.resource.pauseAutosave();
      existing.touched = Date.now();
      existing.status = "checking";
      if (!existing.accessDenied) preview(existing);
    }

    const flight = this.flights.get(id);

    if (flight) {
      const entry = await flight;

      preview(entry);

      return entry;
    }

    const task = this.load(id, preview, metadata);

    this.flights.set(id, task);
    try {
      return await task;
    } finally {
      if (this.flights.get(id) === task) this.flights.delete(id);
      this.evict();
    }
  }

  private async load(
    id: string,
    preview: (entry: CanvasResource) => void,
    metadata?: CanvasMeta,
  ) {
    const incarnation = this.incarnations.get(id) ?? 0;
    const assertCurrent = () => {
      this.assertActive();
      if (
        incarnation !== (this.incarnations.get(id) ?? 0) ||
        this.deleted.has(id)
      )
        throw new DOMException("Canvas invalidated", "AbortError");
    };
    let entry = this.canvases.get(id);
    const controller = new AbortController();

    this.reads.add(controller);
    try {
      // Memory hits send a conditional request immediately. Disk and network race on cold memory.
      let remoteTask: Promise<CanvasDocument> | undefined;

      if (!entry) {
        const memory = this.cache.peek<CanvasDocument>(
          cacheKey(this.owner, "canvas", id),
        );

        if (memory) entry = this.create(memory);
        else {
          remoteTask = this.readCanvas(id, undefined, controller.signal);
          // Attach a rejection handler immediately while disk access runs.
          void remoteTask.catch(() => {});
          const [cached, draft] = await Promise.all([
            this.cache.get<CanvasDocument>(cacheKey(this.owner, "canvas", id)),
            readCurrentDraft<CanvasScene>(`${this.owner}:canvas:${id}`).catch(
              (error) => {
                console.warn(
                  "本地草稿暂不可读，将保留内存并尝试云端读取",
                  error,
                );

                return undefined;
              },
            ),
          ]);

          assertCurrent();
          if (cached) entry = this.create(cached);
          else if (draft) {
            entry = this.create({
              ...(metadata ?? {
                id,
                name: id,
                position: 0,
                workspaceId: "",
                createdAt: "",
                updatedAt: "",
              }),
              revision: draft.revision,
              scene: draft.value,
            });
            entry.confirmed = false;
          }
        }

        if (entry) {
          entry.resource.pauseAutosave();
          await entry.resource.restore();
        }
      }

      assertCurrent();
      if (entry) {
        entry.resource.pauseAutosave();
        entry.status = "checking";
        if (!entry.accessDenied) preview(entry);
        this.notify();
      }

      // A pending write from this tab must settle before validating its own accepted revision.
      if (entry?.resource.isSaving) {
        try {
          await entry.resource.settle();
        } catch (error) {
          if (!entry.resource.hasUnconfirmedSave && !entry.resource.conflict)
            throw error;
        }
      }

      if (entry?.resource.hasUnconfirmedSave) {
        try {
          await entry.resource.flush();
        } catch (error) {
          if (!entry.resource.conflict) throw error;
        }
      }

      let metadataGeneration = entry?.metadataGeneration ?? 0;
      let remote = await (remoteTask ??
        this.readCanvas(
          id,
          entry?.confirmed ? entry.document : undefined,
          controller.signal,
        ));

      assertCurrent();
      // Explicit retry/logout saves remain allowed while checking. Never roll an accepted
      // local revision back to a GET that started before that write completed.
      if (entry) {
        for (;;) {
          try {
            await entry.resource.settle();
            if (entry.resource.hasUnconfirmedSave) await entry.resource.flush();
          } catch (error) {
            if (!entry.resource.conflict) throw error;
          }

          if (
            (!entry.confirmed ||
              canvasRevisionScope(remote) !==
                canvasRevisionScope(entry.document) ||
              remote.revision >= entry.document.revision) &&
            metadataGeneration === entry.metadataGeneration
          )
            break;
          metadataGeneration = entry.metadataGeneration;
          remote = await this.readCanvas(id, entry.document, controller.signal);
          assertCurrent();
        }
      }

      if (this.deleted.has(id))
        throw new ApiError(404, "NOT_FOUND", "画布已删除");
      void this.cache.put(
        cacheKey(this.owner, "canvas", id),
        remote,
        canvasRevisionScope(remote),
      );
      if (!entry) {
        entry = this.create(remote);
        await entry.resource.restore();
      }

      assertCurrent();
      entry.accessDenied = false;
      if (
        entry.resource.dirty &&
        remote.syncMode === "collaborative" &&
        remote.migrationEpoch &&
        remote.migrationEpoch === remote.roomEpoch &&
        entry.resource.baseline
      ) {
        const session = collaborationSession({
          canvasId: id,
          userId: this.owner,
          scope: "account",
        });

        await session.start(false);
        assertCurrent();
        await session.adoptLegacyDraft(
          entry.resource.baseline,
          entry.resource.value,
          remote.migrationEpoch,
        );
        assertCurrent();
        // New queue is durable before removing the old snapshot draft. A crash
        // between these steps can replay the delta, but cannot lose it.
        await entry.resource.discardDraft();
        assertCurrent();
      }

      if (entry.resource.dirty) {
        const changedScope =
          canvasRevisionScope(entry.document) !== canvasRevisionScope(remote);

        entry.document = immutableSnapshot(remote);
        entry.confirmed = true;
        entry.resource.conflict =
          remote.syncMode === "collaborative" ||
          changedScope ||
          entry.resource.revision !== remote.revision;
        entry.status = entry.resource.conflict ? "conflict" : "ready";
        if (entry.resource.conflict)
          entry.message =
            "云端版本已改变，本地草稿已保留。请下载备份或明确丢弃草稿后加载云端。";
        else {
          entry.message = "";
          entry.resource.resumeAutosave();
        }
      } else {
        const changed =
          JSON.stringify(entry.document) !== JSON.stringify(remote);

        entry.document = immutableSnapshot(remote);
        entry.resource.value = immutableSnapshot(remote.scene);
        entry.resource.baseline = immutableSnapshot(remote.scene);
        entry.resource.revision = remote.revision;
        entry.status = "ready";
        entry.resource.resumeAutosave();
        entry.message = "";
        if (changed) entry.version++;
      }

      preview(entry);
      this.notify();

      return entry;
    } catch (error) {
      assertCurrent();
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        if (entry) {
          entry.accessDenied = true;
          entry.status = "error";
          entry.message = `${error.message}；未同步草稿仍保留，请下载备份。`;
          this.notify();
        }

        await this.cache.remove(cacheKey(this.owner, "canvas", id));
        if (entry && !entry.resource.dirty) {
          entry.resource.dispose();
          this.canvases.delete(id);
        }

        throw error;
      }

      if (entry) {
        entry.status = entry.resource.conflict ? "conflict" : "error";
        entry.message =
          error instanceof Error ? error.message : "无法校验画布版本，请重试。";
        preview(entry);
        this.notify();

        return entry;
      }

      throw error;
    } finally {
      this.reads.delete(controller);
    }
  }

  async checkpoint(id: string) {
    const resource = this.canvases.get(id)?.resource;

    if (!resource) return;
    try {
      await resource.checkpoint();
    } catch (error) {
      // With no durable draft, cloud confirmation is the only safe way to leave.
      if (resource.dirty) await resource.flush();
      else throw error;
    }

    if (resource.dirty && !resource.conflict) resource.schedule(0);
  }

  async ensureLibrary() {
    if (this.libraryStatus === "ready") return;
    if (this.libraryFlight) return this.libraryFlight;
    this.libraryFlight = this.loadLibrary();
    try {
      await this.libraryFlight;
    } finally {
      this.libraryFlight = undefined;
    }
  }

  private async loadLibrary() {
    this.libraryStatus = "loading";
    this.libraryMessage = "";
    this.notify();
    const controller = new AbortController();

    this.reads.add(controller);
    try {
      const key = cacheKey(this.owner, "library", this.owner);
      const known = await this.cache.get<LibraryDocument>(key);

      this.assertActive();
      if (known) {
        this.libraryPreview = immutableSnapshot(known.items);
        this.notify();
      }

      const remote = this.api.validateLibrary
        ? await this.api.validateLibrary(
            this.owner,
            known,
            AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
          )
        : await this.api.readLibrary(this.owner);
      const data = remote ?? known;

      this.assertActive();
      if (!data) throw new Error("素材库未返回内容，请重试。");
      void this.cache.put(key, data);
      if (!this.library) {
        this.library = new PersistentResource({
          key: `${this.owner}:library`,
          path: "/api/library",
          field: "items",
          value: immutableSnapshot(data.items),
          revision: data.revision,
          ownerId: this.owner,
          changed: (message) => {
            this.libraryMessage =
              message ?? (this.library?.dirty ? this.libraryMessage : "");
            if (this.library?.conflict) this.libraryStatus = "conflict";
            this.notify();
          },
          confirmed: (items, saved) => {
            void this.cache.put(key, { items, revision: saved.revision });
          },
          readRemote: async () => {
            const read = new AbortController();

            this.reads.add(read);
            let latest: LibraryDocument;

            try {
              const result = this.api.validateLibrary
                ? await this.api.validateLibrary(
                    this.owner,
                    undefined,
                    AbortSignal.any([read.signal, AbortSignal.timeout(20_000)]),
                  )
                : await this.api.readLibrary(this.owner);

              if (!result) throw new Error("素材库未返回内容，请重试。");
              latest = result;
            } finally {
              this.reads.delete(read);
            }

            this.assertActive();

            return { value: latest.items, revision: latest.revision };
          },
          runRequest: (task) => this.runRequest(task),
        });
        await this.library.restore();
      }

      this.assertActive();
      this.libraryPreview = undefined;
      this.libraryStatus = this.library.conflict ? "conflict" : "ready";
      if (this.library.dirty && !this.library.conflict) this.library.schedule();
      this.notify();
    } catch (error) {
      this.assertActive();
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        this.libraryPreview = undefined;
        await this.cache.remove(cacheKey(this.owner, "library", this.owner));
      }

      this.libraryStatus = "error";
      this.libraryMessage = `素材库加载失败：${error instanceof Error ? error.message : "网络错误"}`;
      this.notify();
    } finally {
      this.reads.delete(controller);
    }
  }

  async flushAll() {
    await Promise.all(
      [...this.canvases.values()]
        .map((entry) => entry.resource.flush())
        .concat(this.library?.flush() ?? []),
    );
  }

  hasDirty() {
    return (
      [...this.canvases.values()].some((entry) => entry.resource.dirty) ||
      !!this.library?.dirty
    );
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.reads) controller.abort();
    for (const entry of this.canvases.values()) entry.resource.dispose();
    this.library?.dispose();
    this.writeWaiters.splice(0).forEach((resolve) => resolve());
    this.canvases.clear();
    this.editorContexts.clear();
    this.cache.clearMemory();
  }
}
