import type { User } from "../../shared/contracts";
import { canvas } from "../db/canvases";
import { workspace } from "../db/workspaces";
import { fail } from "./http";

export async function requireWorkspace(id: string, user: User) {
  return (
    (await workspace(id, user.id)) ?? fail(404, "NOT_FOUND", "工作区不存在")
  );
}

export async function requireCanvas(id: string, user: User) {
  return (await canvas(id, user.id)) ?? fail(404, "NOT_FOUND", "画布不存在");
}
