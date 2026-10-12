import type { Operation } from "../../../shared/collaboration/types";
import type { CanvasScene } from "../../../shared/contracts";
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
