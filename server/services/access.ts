import type { User, Workspace } from "../../shared/contracts";
import type { RepositoryPort, StoredCanvas } from "../storage/repository";
import { fail } from "./http";
export interface OwnedResources {
  workspace(id: string, user: User): Promise<Workspace>;
  canvas(id: string, user: User): Promise<StoredCanvas>;
}
export function createOwnedResources({
  repository,
}: {
  repository: Pick<RepositoryPort, "workspace" | "canvas">;
}): OwnedResources {
  return {
    async workspace(id, user) {
      return (
        (await repository.workspace(id, user.id)) ??
        fail(404, "NOT_FOUND", "工作区不存在")
      );
    },
    async canvas(id, user) {
      return (
        (await repository.canvas(id, user.id)) ??
        fail(404, "NOT_FOUND", "画布不存在")
      );
    },
  };
}
