import type { Operation } from "#shared/collaboration/types";
import type { CanvasScene } from "#shared/contracts";
import { openDB, type DBSchema } from "idb";

export interface Draft {
  clientId: string;
  clientSeq: number;
  operations: Operation[];
  files: CanvasScene["files"];
  scene?: CanvasScene;
  updatedAt: string;
}

interface DraftDatabase extends DBSchema {
  drafts: { key: string; value: Draft };
}

let database: ReturnType<typeof openDB<DraftDatabase>> | undefined;

function db() {
  return (database ??= openDB<DraftDatabase>(
    "excalidraw-collaboration-drafts",
    1,
    {
      upgrade(db) {
        db.createObjectStore("drafts");
      },
      blocking() {
        void database
          ?.then((db) => db.close())
          .catch((error) => console.warn("关闭旧协作草稿连接失败", error));
        database = undefined;
      },
      terminated() {
        database = undefined;
      },
    },
  ).catch((error) => {
    database = undefined;
    throw error;
  }));
}

export async function draftStorage(
  key: string,
  operation: "get" | "put" | "delete",
  draft?: Draft,
): Promise<Draft | undefined> {
  const database = await db();

  if (operation === "get") return database.get("drafts", key);
  if (operation === "put") {
    if (!draft) throw new Error("Missing collaboration draft");
    await database.put("drafts", draft, key);
  } else await database.delete("drafts", key);

  return undefined;
}

/** Find a previous authorization's draft without crossing accounts or tabs. */
export async function findRecoveryDraft(currentKey: string) {
  const separator = currentKey.lastIndexOf(":tab:");
  const scope = JSON.parse(currentKey.slice(0, separator)) as unknown[];
  const tab = currentKey.slice(separator);
  const prefix = `${JSON.stringify(scope.slice(0, 3)).slice(0, -1)},`;
  const database = await db();
  const transaction = database.transaction("drafts", "readonly");
  const keys = await transaction.store.getAllKeys(
    IDBKeyRange.bound(prefix, `${prefix}\uffff`),
  );
  const candidates = await Promise.all(
    keys
      .filter((key) => key !== currentKey && key.endsWith(tab))
      .map(async (key) => ({ key, draft: await transaction.store.get(key) })),
  );

  return candidates
    .filter(
      (entry): entry is { key: string; draft: Draft } =>
        !!entry.draft?.operations.length,
    )
    .sort((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt))[0];
}
