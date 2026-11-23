// L3 stable layer: plain TS + `vue` reactivity only. Never import Nuxt runtime APIs here.
import { readonly, shallowRef, type Ref } from "vue";
import type {
  CanvasDocument,
  CanvasScene,
  User,
  Workspace,
} from "#shared/contracts";
import { accountApi } from "~/lib/accountApi";
import { workspaceApi } from "~/lib/workspaceApi";
import { configureApi } from "~/lib/runtime";
import { useCanvasDocument } from "~/composables/useCanvasDocument";

export interface WorkspaceClientOptions {
  /** Origin and/or path prefix of the workspace API, "" for same-origin. */
  apiBase?: string;
  /** Defaults to apiBase; set when the realtime endpoint lives elsewhere. */
  realtimeBase?: string;
  initialCanvasId?: string;
}

export interface ClientSession {
  status: "loading" | "anonymous" | "authenticated" | "error";
  canEdit: boolean;
  /** Id of the account the client acts as, null while anonymous. */
  actAs: string | null;
  user: User | null;
}

export interface CanvasHandle {
  readonly id: string;
  readonly document: Readonly<Ref<CanvasDocument | undefined>>;
  readonly saveState: Readonly<Ref<string>>;
  /** Replace the scene; autosave follows. */
  change(scene: CanvasScene): void;
  flush(): Promise<void>;
  close(): void;
}

export interface WorkspaceClient {
  readonly ready: Promise<void>;
  readonly session: Readonly<Ref<ClientSession>>;
  readonly workspaces: Readonly<Ref<readonly Workspace[]>>;
  start(): Promise<void>;
  openCanvas(id: string): Promise<CanvasHandle>;
  flush(): Promise<void>;
  dispose(): void;
}

export function createWorkspaceClient(
  options: WorkspaceClientOptions = {},
): WorkspaceClient {
  configureApi({
    base: options.apiBase ?? "",
    realtimeBase: options.realtimeBase ?? options.apiBase,
  });

  const state = shallowRef<ClientSession>({
    status: "loading",
    canEdit: false,
    actAs: null,
    user: null,
  });
  const workspaces = shallowRef<readonly Workspace[]>([]);
  const canvasDocument = useCanvasDocument({
    api: workspaceApi,
    ownerId: () => {
      if (!state.value.user) throw new Error("请先登录");

      return state.value.user.id;
    },
    onLoaded: () => {},
  });
  let disposed = false;
  let started: Promise<void> | undefined;

  async function load() {
    try {
      const user = await accountApi.session();

      if (disposed) return;
      if (user) workspaces.value = await workspaceApi.listWorkspaces();
      state.value = {
        status: user ? "authenticated" : "anonymous",
        canEdit: !!user,
        actAs: user?.id ?? null,
        user,
      };
    } catch (cause) {
      if (disposed) return;
      state.value = {
        status: "error",
        canEdit: false,
        actAs: null,
        user: null,
      };
      throw cause;
    }
  }

  function start() {
    return (started ??= load());
  }

  async function openCanvas(id: string): Promise<CanvasHandle> {
    await start();
    if (!state.value.user) throw new Error("请先登录");
    await canvasDocument.loadCanvas(id);

    const entry = () => {
      const current = canvasDocument.current.value;

      if (!current || current.document.id !== id)
        throw new Error("画布已关闭或被其他画布取代");

      return current;
    };

    return {
      id,
      document: canvasDocument.document,
      saveState: canvasDocument.saveState,
      change: (scene) => entry().resource.update(scene),
      flush: async () => {
        await entry().resource.flush();
      },
      close: () => canvasDocument.clearDocument("没有画布"),
    };
  }

  const ready = start();

  // Hosts that never await `ready` must not trigger unhandled rejections.
  ready.catch((cause: unknown) =>
    console.warn("工作空间客户端初始化失败", cause),
  );

  return {
    ready,
    session: readonly(state) as Readonly<Ref<ClientSession>>,
    workspaces: readonly(workspaces) as Readonly<Ref<readonly Workspace[]>>,
    start,
    openCanvas,
    flush: () => canvasDocument.flushAll(),
    dispose() {
      disposed = true;
      canvasDocument.reset();
    },
  };
}
