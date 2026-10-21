import { ref } from "vue";

interface WorkspaceTabs {
  ids: string[];
  active: string | null;
}

/** View state only: closing a tab never deletes a canvas or its saved draft. */
export function useCanvasTabs() {
  const workspaces = ref<Record<string, WorkspaceTabs>>({});

  function open(workspaceId: string, id: string) {
    const state = (workspaces.value[workspaceId] ??= { ids: [], active: null });

    if (!state.ids.includes(id)) state.ids.push(id);
    state.active = id;
  }

  function close(workspaceId: string, id: string) {
    const state = workspaces.value[workspaceId];

    if (!state) return;
    const index = state.ids.indexOf(id);

    if (index < 0) return;
    state.ids.splice(index, 1);
    if (state.active === id)
      state.active = state.ids[index] ?? state.ids[index - 1] ?? null;
  }

  function reconcile(workspaceId: string, available: readonly string[]) {
    const state = workspaces.value[workspaceId];

    if (!state) return;
    for (const id of [...state.ids])
      if (!available.includes(id)) close(workspaceId, id);
  }

  return {
    ids: (workspaceId: string) => workspaces.value[workspaceId]?.ids ?? [],
    // undefined means a space has never been opened; null means all tabs were closed.
    active: (workspaceId: string) => workspaces.value[workspaceId]?.active,
    open,
    close,
    reconcile,
    forgetWorkspace(workspaceId: string) {
      delete workspaces.value[workspaceId];
    },
    reset() {
      workspaces.value = {};
    },
  };
}
