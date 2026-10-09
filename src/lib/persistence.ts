import { api, ApiError } from "./api";
import type { SaveResult } from "../../shared/contracts";

interface Draft<T> {
  revision: number;
  value: T;
  updatedAt?: string;
}

export interface OtherDraft<T> extends Draft<T> {
  key: string;
}
// HTTP LAN previews lack randomUUID, but getRandomValues remains available.
const newTabId = () =>
  crypto.randomUUID?.() ??
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
let tabScope: Promise<string> | undefined;

function getTabScope() {
  return (tabScope ??= (async () => {
    let previous: string | null = null;

    try {
      previous = sessionStorage.getItem("excalidraw-draft-tab");
    } catch (error) {
      console.warn("无法读取标签页标识，将使用新的草稿作用域", error);
    }

    let id = previous || newTabId();

    if (navigator.locks) {
      const claim = (candidate: string) =>
        new Promise<boolean>((resolve, reject) => {
          void navigator.locks
            .request(
              `excalidraw-draft-tab:${candidate}`,
              { ifAvailable: true },
              async (lock) => {
                resolve(!!lock);
                // Keep this identity exclusive for the document lifetime, including cloned tabs.
                if (lock) await new Promise<void>(() => {});
              },
            )
            .catch(reject);
        });

      if (!(await claim(id))) {
        id = newTabId();
        await claim(id);
      }
    } else {
      // Never risk sharing a key when this browser cannot detect cloned sessions.
      id = newTabId();
    }

    try {
      sessionStorage.setItem("excalidraw-draft-tab", id);
    } catch (error) {
      console.warn("无法保存标签页标识，下次访问需从其他草稿恢复", error);
    }

    return id;
  })());
}

let database: Promise<IDBDatabase> | undefined;

function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("excalidraw-account-drafts", 1);

    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

async function storage<T>(
  key: string,
  operation: "get" | "put" | "delete",
  value?: Draft<T>,
): Promise<Draft<T> | undefined> {
  const database = await db();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      "drafts",
      operation === "get" ? "readonly" : "readwrite",
    );
    const store = transaction.objectStore("drafts");
    const request =
      operation === "get"
        ? store.get(key)
        : operation === "put"
          ? store.put(value, key)
          : store.delete(key);

    transaction.oncomplete = () =>
      resolve(operation === "get" ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function otherDrafts<T>(
  prefix: string,
  currentKey: string,
): Promise<OtherDraft<T>[]> {
  const database = await db();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction("drafts", "readonly");
    const result: OtherDraft<T>[] = [];
    const request = transaction.objectStore("drafts").openCursor();

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor) return;
      const key = String(cursor.key);

      // Include the earlier, unscoped format for a safe migration.
      if (
        key !== currentKey &&
        (key === prefix || key.startsWith(`${prefix}:tab:`))
      )
        result.push({ ...cursor.value, key });
      cursor.continue();
    };

    transaction.oncomplete = () =>
      resolve(
        result.sort((a, b) =>
          (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
        ),
      );
    transaction.onerror = () => reject(transaction.error);
  });
}

/** One in-flight request per resource. A response only acknowledges the snapshot it sent. */
export interface PersistentResourceOptions<T> {
  key: string;
  path: string;
  field: string;
  value: T;
  revision: number;
  changed: (message?: string) => void;
  scopeId?: string;
  ownerId?: string;
}

/** Scene/library save port; settings keep their distinct conflict-resolution state machine. */
export interface SaveResource<T> {
  readonly value: T;
  readonly revision: number;
  readonly dirty: boolean;
  readonly conflict: boolean;
  restore(): Promise<void>;
  update(value: T): void;
  schedule(delay?: number): void;
  flush(): Promise<void>;
  saveNow(): Promise<void>;
  findOtherDrafts(): Promise<OtherDraft<T>[]>;
  discardDraft(): Promise<void>;
  dispose(): void;
}

export class PersistentResource<T> implements SaveResource<T> {
  value: T;
  revision: number;
  dirty = false;
  conflict = false;
  private generation = 0;
  private saving?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private activeRequest?: AbortController;
  private ownerId?: string;
  private storageError = false;
  private key: Promise<string>;
  private prefix: string;
  private path: string;
  private field: string;
  private changed: (message?: string) => void;

  constructor({
    key,
    path,
    field,
    value,
    revision,
    changed,
    scopeId,
    ownerId,
  }: PersistentResourceOptions<T>) {
    this.ownerId = ownerId;
    this.prefix = key;
    this.key = (scopeId ? Promise.resolve(scopeId) : getTabScope()).then(
      (scope) => `${key}:tab:${scope}`,
    );
    this.path = path;
    this.field = field;
    this.changed = changed;
    this.value = value;
    this.revision = revision;
  }

  async restore() {
    try {
      const draft = await storage<T>(await this.key, "get");

      if (this.disposed) return;
      if (draft) {
        this.value = draft.value;
        this.dirty = true;
        this.conflict = draft.revision !== this.revision;
        this.revision = draft.revision;
        this.changed(
          this.conflict
            ? "检测到其他页面的更新，本地草稿已恢复。请下载备份后刷新处理冲突。"
            : undefined,
        );
      }
    } catch (error) {
      if (this.disposed) return;
      console.warn("无法恢复本地草稿", error);
      this.storageError = true;
      this.changed("浏览器无法暂存草稿，请保持联网，离开前确认保存成功。");
    }
  }

  private persist() {
    const draft = this.dirty
      ? {
          revision: this.revision,
          value: this.value,
          updatedAt: new Date().toISOString(),
        }
      : undefined;
    // Capture serialized data now; Excalidraw objects may change while waiting for IndexedDB.
    const snapshot = draft
      ? (JSON.parse(JSON.stringify(draft)) as Draft<T>)
      : undefined;

    this.writes = this.writes
      .then(async () =>
        storage(await this.key, snapshot ? "put" : "delete", snapshot),
      )
      .catch((error) => {
        console.warn("无法暂存本地草稿", error);
        this.storageError = true;
        if (!this.disposed)
          this.changed("浏览器无法暂存草稿，请保持页面打开并重试保存。");
      });
  }

  update(value: T) {
    if (this.disposed) return;
    this.value = value;
    this.dirty = true;
    this.generation++;
    this.persist();
    this.changed();
    this.schedule();
  }

  schedule(delay = 700) {
    clearTimeout(this.timer);
    if (!this.disposed && !this.conflict)
      this.timer = setTimeout(() => {
        void this.flush().catch((error) => {
          // save() already reports failures and decides whether another retry is safe.
          if (!this.disposed) console.warn("自动保存未完成，草稿仍保留", error);
        });
      }, delay);
  }

  async flush(): Promise<void> {
    if (this.disposed)
      throw new DOMException("Resource disposed", "AbortError");
    clearTimeout(this.timer);
    if (this.conflict)
      throw new Error("保存冲突：请先下载本地备份，避免覆盖其他页面的更新。");
    if (this.saving) {
      await this.saving;
      if (this.dirty) return this.flush();

      return;
    }

    if (!this.dirty) return;
    this.saving = this.save();
    try {
      await this.saving;
    } finally {
      this.saving = undefined;
    }

    if (this.dirty) return this.flush();
  }

  private async save() {
    const generation = this.generation;
    const value = this.value;

    this.changed();
    const controller = new AbortController();

    this.activeRequest = controller;
    try {
      if (this.disposed)
        throw new DOMException("Resource disposed", "AbortError");
      const saved = await api<SaveResult>(this.path, {
        method: "PUT",
        headers: this.ownerId
          ? { "X-Resource-Owner": this.ownerId }
          : undefined,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20_000),
        ]),
        body: JSON.stringify({ revision: this.revision, [this.field]: value }),
      });

      if (this.disposed)
        throw new DOMException("Resource disposed", "AbortError");
      this.revision = saved.revision;
      if (generation === this.generation) this.dirty = false;
      this.persist();
      await this.writes;
      if (this.disposed) return;
      this.changed(
        this.storageError
          ? "云端已保存；此浏览器不支持本地草稿暂存。"
          : undefined,
      );
    } catch (error) {
      if (this.disposed) throw error;
      this.conflict = error instanceof ApiError && error.status === 409;
      this.changed(
        this.conflict
          ? "保存冲突：其他页面已修改此内容。已保留本地草稿，请下载备份后刷新处理。"
          : error instanceof ApiError && error.status === 401
            ? "登录已过期，本地草稿已保留。请刷新页面重新登录，然后恢复保存。"
            : `保存失败，草稿暂留本机，请重试：${error instanceof Error ? error.message : "网络错误"}`,
      );
      if (
        !this.conflict &&
        !(error instanceof ApiError && error.status === 401)
      )
        this.schedule(5000);
      throw error;
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }

  /** Explicit save also writes an unchanged snapshot, using the usual revision protection. */
  async saveNow() {
    this.update(this.value);
    await this.flush();
  }

  async findOtherDrafts() {
    return otherDrafts<T>(this.prefix, await this.key);
  }

  async discardDraft() {
    clearTimeout(this.timer);
    if (this.saving)
      await this.saving.catch((error) => {
        // Explicit discard waits for the failed write to settle before deleting its draft.
        console.warn("待处理保存失败，继续执行用户确认的草稿丢弃", error);
      });
    await this.writes;
    await storage(await this.key, "delete");
    this.dirty = false;
    this.conflict = false;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.activeRequest?.abort();
  }
}
