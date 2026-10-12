import type { ReleaseNote } from "~/data/releases";

type ProgressStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

export const announcementPrefix = (owner: string) =>
  `excalidraw-workspace:announcements:${encodeURIComponent(owner)}:shown:`;

export const announcementKey = (owner: string, sequence: number) =>
  `${announcementPrefix(owner)}${sequence}`;

/** Immutable per-release marks prevent late writes from old tabs lowering progress. */
export class ReleaseProgress {
  private memory = new Map<string, number>();
  storageError: unknown;

  constructor(private storage: () => ProgressStorage = () => localStorage) {}

  highest(owner: string) {
    let highest = this.memory.get(owner) ?? 0;
    const prefix = announcementPrefix(owner);

    try {
      const storage = this.storage();

      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);

        if (!key?.startsWith(prefix)) continue;
        const suffix = key.slice(prefix.length);
        const sequence = Number(suffix);

        if (
          Number.isSafeInteger(sequence) &&
          sequence > 0 &&
          String(sequence) === suffix &&
          storage.getItem(key)
        )
          highest = Math.max(highest, sequence);
      }
    } catch (error) {
      // Storage may be denied. Keep this document's progress in memory.
      this.storageError = error;
      this.memory.set(owner, highest);

      return highest;
    }

    this.memory.set(owner, highest);

    return highest;
  }

  shown(owner: string, release: Pick<ReleaseNote, "id" | "sequence">) {
    const highest = this.highest(owner);

    this.memory.set(owner, Math.max(highest, release.sequence));
    if (highest >= release.sequence) return;
    try {
      this.storage().setItem(
        announcementKey(owner, release.sequence),
        release.id,
      );
    } catch (error) {
      // The memory mark still prevents repetition during this page's lifetime.
      this.storageError = error;
      this.memory.set(owner, Math.max(highest, release.sequence));
    }
  }
}
