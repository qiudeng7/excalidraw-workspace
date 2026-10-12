/** Clean snapshots are disposable. Unsynchronized drafts live in a different database. */
export interface CacheEntry<T = unknown> {
  key: string;
  revision: number;
  value: T;
  bytes: number;
  accessedAt: number;
}

export interface CacheDisk {
  read(key: string): Promise<CacheEntry | undefined>;
  write(entry: CacheEntry, limit: number): Promise<void>;
  remove(key: string): Promise<void>;
}

export const immutableSnapshot = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value));

export const snapshotBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const cacheKey = (
  owner: string,
  kind: "canvas" | "library",
  id: string,
) => JSON.stringify([1, owner, kind, id]);
let database: Promise<IDBDatabase> | undefined;

function db() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("excalidraw-confirmed-cache", 1);

    request.onupgradeneeded = () =>
      request.result.createObjectStore("snapshots", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => {
      database = undefined;
      reject(new Error("缓存数据库被其他页面占用"));
    };

    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}

const disk: CacheDisk = {
  async read(key) {
    const database = await db();

    return new Promise((resolve, reject) => {
      const tx = database.transaction("snapshots", "readwrite");
      const store = tx.objectStore("snapshots");
      const req = store.get(key);
      let entry: CacheEntry | undefined;

      req.onsuccess = () => {
        entry = req.result;
        if (entry) {
          entry.accessedAt = Date.now();
          store.put(entry);
        }
      };

      tx.oncomplete = () => resolve(entry);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  async write(entry, limit) {
    const database = await db();

    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("snapshots", "readwrite");
      const store = tx.objectStore("snapshots");
      const req = store.getAll();

      req.onsuccess = () => {
        const entries = req.result as CacheEntry[];
        const previous = entries.find((item) => item.key === entry.key);

        if (previous && previous.revision > entry.revision) return;
        if (entry.bytes > limit) {
          store.delete(entry.key);

          return;
        }

        let bytes = entry.bytes;

        store.put(entry);
        for (const item of entries
          .filter((item) => item.key !== entry.key)
          .sort((a, b) => b.accessedAt - a.accessedAt)) {
          bytes += item.bytes;
          if (bytes > limit) store.delete(item.key);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
  async remove(key) {
    const database = await db();

    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("snapshots", "readwrite");

      tx.objectStore("snapshots").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
};

export class ConfirmedCache {
  private memory = new Map<string, CacheEntry>();

  constructor(
    private storage: CacheDisk = disk,
    private memoryCount = 5,
    private memoryBytes = 64 * 1024 * 1024,
    private diskBytes = 256 * 1024 * 1024,
  ) {}

  peek<T>(key: string): T | undefined {
    const entry = this.memory.get(key);

    if (!entry) return;
    this.memory.delete(key);
    this.memory.set(key, entry);

    return immutableSnapshot(entry.value) as T;
  }

  private remember(entry: CacheEntry) {
    if ((this.memory.get(entry.key)?.revision ?? -1) > entry.revision) return;
    this.memory.delete(entry.key);
    if (entry.bytes > this.memoryBytes) return;
    this.memory.set(entry.key, entry);
    let bytes = [...this.memory.values()].reduce(
      (sum, item) => sum + item.bytes,
      0,
    );

    while (this.memory.size > this.memoryCount || bytes > this.memoryBytes) {
      const oldest = this.memory.keys().next().value!;

      bytes -= this.memory.get(oldest)!.bytes;
      this.memory.delete(oldest);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const cached = this.peek<T>(key);

    if (cached) return cached;
    try {
      const entry = await this.storage.read(key);

      if (!entry) return;
      this.remember(entry);

      return immutableSnapshot(entry.value) as T;
    } catch (error) {
      console.warn("已同步缓存暂不可用，将读取云端", error);
    }
  }

  async put<T extends { revision: number }>(key: string, value: T) {
    const snapshot = immutableSnapshot(value);
    const entry = {
      key,
      revision: value.revision,
      value: snapshot,
      bytes: snapshotBytes(snapshot),
      accessedAt: Date.now(),
    };

    this.remember(entry);
    try {
      await this.storage.write(entry, this.diskBytes);
    } catch (error) {
      console.warn("已同步缓存写入失败，不影响云端保存", error);
    }
  }

  async remove(key: string) {
    this.memory.delete(key);
    try {
      await this.storage.remove(key);
    } catch (error) {
      console.warn("无法清理已同步缓存", error);
    }
  }

  clearMemory() {
    this.memory.clear();
  }
}
