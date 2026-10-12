import type { User } from "../../shared/contracts";
import type { RepositoryPort } from "../storage/ports";
import { fail } from "./http";

export async function requireWorkspace(
  repository: Pick<RepositoryPort, "workspace">,
  id: string,
  user: User,
) {
  return (
    (await repository.workspace(id, user.id)) ??
    fail(404, "NOT_FOUND", "工作区不存在")
  );
}

export async function requireCanvas(
  repository: Pick<RepositoryPort, "canvas">,
  id: string,
  user: User,
) {
  return (
    (await repository.canvas(id, user.id)) ??
    fail(404, "NOT_FOUND", "画布不存在")
  );
}
