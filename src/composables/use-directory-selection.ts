import { ref, shallowReadonly } from "vue";
import type { Ref } from "vue";

export type DirectorySelectionIntent =
  "plain" | "toggle" | "range" | "add-range";

export type DirectoryBoxMode = "replace" | "xor" | "add";

export interface DirectorySelectionSnapshot {
  readonly selectedKeys: readonly string[];
  readonly anchor: string | undefined;
  readonly explicitMode: boolean;
}

export interface DirectorySelectionController {
  readonly state: Readonly<Ref<DirectorySelectionSnapshot>>;
  click(key: string, intent: DirectorySelectionIntent): void;
  enterExplicit(key: string): void;
  applyBox(
    hits: readonly string[],
    base: DirectorySelectionSnapshot,
    mode: DirectoryBoxMode,
  ): void;
  reconcile(): void;
  snapshot(): DirectorySelectionSnapshot;
  restore(snapshot: DirectorySelectionSnapshot): void;
  clear(): void;
}

/** 仅保存当前树的临时选择；行顺序与上下文生命周期由调用者提供。 */
export const useDirectorySelection = (
  visibleKeys: () => readonly string[],
): DirectorySelectionController => {
  const empty = (): DirectorySelectionSnapshot => ({
    selectedKeys: [],
    anchor: undefined,
    explicitMode: false,
  });
  const state = ref<DirectorySelectionSnapshot>(empty());
  const publish = (value: DirectorySelectionSnapshot) => {
    const visible = [...new Set(visibleKeys())];
    const selected = new Set(value.selectedKeys);

    state.value = {
      selectedKeys: visible.filter((key) => selected.has(key)),
      anchor:
        value.anchor && visible.includes(value.anchor)
          ? value.anchor
          : undefined,
      explicitMode: value.explicitMode,
    };
  };
  const click = (key: string, intent: DirectorySelectionIntent) => {
    const visible = visibleKeys();

    if (!visible.includes(key)) return;
    const previous = state.value;

    if (intent === "plain") {
      publish({ selectedKeys: [], anchor: key, explicitMode: false });

      return;
    }

    if (intent === "toggle") {
      const selected = new Set(previous.selectedKeys);

      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      publish({ ...previous, selectedKeys: [...selected], anchor: key });

      return;
    }

    const anchor = previous.anchor;
    const start = anchor ? visible.indexOf(anchor) : -1;

    if (start < 0) {
      publish({ ...previous, selectedKeys: [key], anchor: key });

      return;
    }

    const end = visible.indexOf(key);
    const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1);

    publish({
      ...previous,
      selectedKeys:
        intent === "add-range" ? [...previous.selectedKeys, ...range] : range,
    });
  };
  const applyBox = (
    hits: readonly string[],
    base: DirectorySelectionSnapshot,
    mode: DirectoryBoxMode,
  ) => {
    const hit = new Set(hits);
    const selected = new Set(mode === "replace" ? [] : base.selectedKeys);

    for (const key of hit) {
      if (mode === "xor" && selected.has(key)) selected.delete(key);
      else selected.add(key);
    }

    const keys = visibleKeys().filter((key) => selected.has(key));

    publish({
      selectedKeys: keys,
      anchor: keys[0],
      explicitMode: base.explicitMode,
    });
  };
  const snapshot = (): DirectorySelectionSnapshot => ({
    ...state.value,
    selectedKeys: [...state.value.selectedKeys],
  });

  return {
    state: shallowReadonly(state),
    click,
    enterExplicit: (key) => {
      if (visibleKeys().includes(key))
        publish({ selectedKeys: [key], anchor: key, explicitMode: true });
    },
    applyBox,
    reconcile: () => publish(state.value),
    snapshot,
    restore: publish,
    clear: () => {
      state.value = empty();
    },
  };
};
