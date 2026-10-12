import type { RepositoryPort } from "../storage/ports";

declare module "h3" {
  interface H3EventContext {
    /** Lazy business SQL adapter, shared by the handlers of this request. */
    repository: () => Promise<RepositoryPort>;
  }
}
