<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { DialogOptions } from '../lib/dialogs'

const props = defineProps<{ request: DialogOptions & { input?: { label: string; initialValue: string } } }>()
const emit = defineEmits<{ complete: [value: string | boolean | null] }>()
const dialog = ref<HTMLDialogElement>()
const input = ref<HTMLInputElement>()
const cancel = ref<HTMLButtonElement>()
const value = ref(props.request.input?.initialValue ?? '')
const id = useId()
let completed = false
function finish(result: string | boolean | null) {
  if (completed) return
  completed = true
  dialog.value?.close()
  emit('complete', result)
}
function submit() {
  if (props.request.input) {
    const name = value.value.trim()
    if (!name) { input.value?.focus(); return }
    finish(name)
  } else finish(true)
}
function trapTab(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const elements = [...(dialog.value?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') ?? [])]
  const first = elements[0]
  const last = elements.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(() => {
  dialog.value?.showModal()
  if (input.value) { input.value.focus(); input.value.select() }
  else cancel.value?.focus()
})
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <dialog ref="dialog" class="app-dialog" aria-modal="true" :aria-labelledby="`${id}-title`" :aria-describedby="request.message ? `${id}-message` : undefined" @cancel.prevent="finish(null)" @keydown.stop="trapTab" @click.self="finish(null)">
    <form class="app-dialog-card" @submit.prevent="submit" @click.stop>
      <div class="app-dialog-heading"><h2 :id="`${id}-title`">{{ request.title }}</h2><button type="button" class="app-dialog-close" aria-label="关闭对话框" @click="finish(null)"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button></div>
      <p v-if="request.message" :id="`${id}-message`">{{ request.message }}</p>
      <label v-if="request.input" class="app-dialog-field">{{ request.input.label }}<input ref="input" v-model="value" required maxlength="100" autocomplete="off" /></label>
      <div class="app-dialog-actions"><button ref="cancel" type="button" class="app-dialog-cancel" @click="finish(null)">取消</button><button type="submit" class="app-dialog-confirm" :class="{ 'app-dialog-danger': request.danger }" :disabled="!!request.input && !value.trim()">{{ request.confirmLabel ?? '确定' }}</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.app-dialog{box-sizing:border-box;position:fixed;inset:0;width:100%;max-width:none;height:100%;max-height:none;padding:24px;margin:0;border:0;background:transparent;color:#303632;overflow:auto;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.app-dialog[open]{display:grid;place-items:center}.app-dialog::backdrop{background:#202a2359}.app-dialog-card{box-sizing:border-box;width:min(100%,420px);padding:24px;border:1px solid #e0e5dc;border-radius:12px;background:#fff;box-shadow:0 20px 70px #17271c33}.app-dialog-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}.app-dialog h2{margin:0;font-size:17px;line-height:1.5;font-weight:600}.app-dialog p{margin:0 0 20px;font-size:13px;line-height:1.8;color:#717b6d;overflow-wrap:anywhere}.app-dialog-field{display:flex;flex-direction:column;gap:8px;font-size:12px;color:#717b6d}.app-dialog input{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid #dce3d6;border-radius:6px;font:inherit;font-size:14px;color:#374131;background:#fff}.app-dialog input:focus{outline:2px solid #7d927740;outline-offset:1px;border-color:#829277}.app-dialog button{font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:9px 15px;line-height:1.4}.app-dialog button:focus-visible{outline:2px solid #7d9277;outline-offset:3px}.app-dialog-close{display:grid;place-items:center;width:28px;height:28px;padding:0!important;border:0;background:transparent;color:#8c9784}.app-dialog-close:hover{background:#eef1eb}.app-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:26px}.app-dialog-cancel{border:1px solid #e0e5dc;background:#fff;color:#677360}.app-dialog-cancel:hover{background:#f5f7f2}.app-dialog-confirm{border:1px solid #465b3f;background:#465b3f;color:#fff}.app-dialog-confirm:hover{background:#394d32}.app-dialog-danger{border-color:#a15d4d;background:#a15d4d}.app-dialog-danger:hover{background:#8c4f41}.app-dialog button:disabled{opacity:.45;cursor:default}@media(max-width:480px){.app-dialog{padding:18px}.app-dialog-card{padding:21px}.app-dialog button{min-height:40px}}
</style>
