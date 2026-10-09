import { readonly, ref, type Ref } from "vue";

export interface OperationController {
  busy: Readonly<Ref<boolean>>;
  error: Readonly<Ref<string>>;
  run(action: () => Promise<void>): Promise<void>;
  reportError(message: string): void;
}

/** Serializes page operations without giving other controllers mutable access to its state. */
export function useOperation(isLocked: () => boolean): OperationController {
  const busy = ref(false);
  const error = ref("");

  async function run(action: () => Promise<void>) {
    if (busy.value || isLocked()) return;
    busy.value = true;
    error.value = "";
    try {
      await action();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "操作失败，请重试";
    } finally {
      busy.value = false;
    }
  }

  return {
    busy: readonly(busy),
    error: readonly(error),
    run,
    reportError: (message) => {
      error.value = message;
    },
  };
}
