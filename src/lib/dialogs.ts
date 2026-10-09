import { createApp } from "vue";
import AppDialog from "../components/AppDialog.vue";

export type DialogOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
};

type PromptOptions = DialogOptions & { initialValue?: string; label: string };

type DialogRequest = DialogOptions & {
  input?: { label: string; initialValue: string };
};

// 每次只打开一个顶层对话框，避免异步确认期间重复执行操作。
let pending: Promise<string | boolean | null> | undefined;
let cancelPending: (() => void) | undefined;

function showDialog(request: DialogRequest): Promise<string | boolean | null> {
  if (pending) return Promise.resolve(null);
  const trigger = document.activeElement as HTMLElement | null;
  const restoreFocus = () => {
    if (!trigger?.isConnected) return;
    const menu = trigger.closest("details");
    const target =
      menu && !menu.open ? menu.querySelector<HTMLElement>("summary") : trigger;

    target?.focus();
  };
  const host = document.createElement("div");

  document.body.append(host);
  pending = new Promise((resolve) => {
    const app = createApp(AppDialog, {
      request,
      onComplete(value: string | boolean | null) {
        app.unmount();
        host.remove();
        pending = undefined;
        cancelPending = undefined;
        restoreFocus();
        resolve(value);
      },
    });

    cancelPending = () => {
      app.unmount();
      host.remove();
      pending = undefined;
      cancelPending = undefined;
      restoreFocus();
      resolve(null);
    };

    app.mount(host);
  });

  return pending;
}

export async function promptDialog(
  options: PromptOptions,
): Promise<string | null> {
  const result = await showDialog({
    ...options,
    input: { label: options.label, initialValue: options.initialValue ?? "" },
  });

  return typeof result === "string" ? result : null;
}

export async function confirmDialog(options: DialogOptions): Promise<boolean> {
  return (await showDialog(options)) === true;
}

export function isAppDialogOpen() {
  return !!pending;
}

export function cancelAppDialog() {
  cancelPending?.();
}
