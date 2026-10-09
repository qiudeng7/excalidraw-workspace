import { nextTick, ref, shallowReadonly, watch, onMounted, onBeforeUnmount, type Ref } from 'vue'
import type { Workspace } from '../../shared/contracts'

export interface WorkspacePickerDependencies {
  workspaces: Readonly<Ref<readonly Workspace[]>>
  workspaceId: Readonly<Ref<string>>
  locked: Readonly<Ref<boolean>>
  sidebarOpen: Readonly<Ref<boolean>>
  select(id: string): Promise<void>
}
export interface WorkspacePickerController {
  workspacePicker: Ref<HTMLElement | undefined>
  workspaceTrigger: Ref<HTMLButtonElement | undefined>
  workspaceList: Ref<HTMLUListElement | undefined>
  workspaceMenuOpen: Readonly<Ref<boolean>>
  activeWorkspaceIndex: Readonly<Ref<number>>
  setActiveWorkspace(index: number): void
  closeWorkspaceMenu(returnFocus?: boolean): void
  openWorkspaceMenu(index?: number): Promise<void>
  handleWorkspaceTriggerKey(event: KeyboardEvent): void
  handleWorkspaceListKey(event: KeyboardEvent): void
  handleWorkspaceFocusOut(event: FocusEvent): void
}
/** Owns only listbox focus and keyboard state; selection remains a directory action. */
export function useWorkspacePicker({ workspaces, workspaceId, locked, sidebarOpen, select }: WorkspacePickerDependencies): WorkspacePickerController {
  const workspacePicker = ref<HTMLElement>()
  const workspaceTrigger = ref<HTMLButtonElement>()
  const workspaceList = ref<HTMLUListElement>()
  const workspaceMenuOpen = ref(false)
  const activeWorkspaceIndex = ref(0)
  function closeWorkspaceMenu(returnFocus = false) {
    workspaceMenuOpen.value = false
    if (returnFocus) workspaceTrigger.value?.focus()
  }
  async function openWorkspaceMenu(index?: number) {
    if (locked.value || !workspaces.value.length) return
    activeWorkspaceIndex.value = index ?? Math.max(0, workspaces.value.findIndex(item => item.id === workspaceId.value))
    workspaceMenuOpen.value = true
    await nextTick()
    workspaceList.value?.focus()
    scrollActiveWorkspace()
  }
  function scrollActiveWorkspace() {
    workspaceList.value?.children[activeWorkspaceIndex.value]?.scrollIntoView({ block: 'nearest' })
  }
  function handleWorkspaceTriggerKey(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.stopPropagation()
    event.preventDefault()
    void openWorkspaceMenu(event.key === 'Home' ? 0 : event.key === 'End' ? workspaces.value.length - 1 : undefined)
  }
  function handleWorkspaceListKey(event: KeyboardEvent) {
    if (['Tab', 'Escape', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.stopPropagation()
    if (event.key === 'Tab') { closeWorkspaceMenu(true); return }
    if (event.key === 'Escape') { event.preventDefault(); closeWorkspaceMenu(true); return }
    if (locked.value) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const workspace = workspaces.value[activeWorkspaceIndex.value]
      if (workspace) void select(workspace.id)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const last = workspaces.value.length - 1
    activeWorkspaceIndex.value = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, activeWorkspaceIndex.value + (event.key === 'ArrowDown' ? 1 : -1)))
    void nextTick(scrollActiveWorkspace)
  }
  function dismissWorkspaceMenu(event: PointerEvent) {
    if (workspaceMenuOpen.value && !workspacePicker.value?.contains(event.target as Node)) closeWorkspaceMenu()
  }
  function handleWorkspaceFocusOut(event: FocusEvent) {
    if (event.relatedTarget && !workspacePicker.value?.contains(event.relatedTarget as Node)) closeWorkspaceMenu()
  }
  function escapeWorkspaceMenu(event: KeyboardEvent) {
    if (workspaceMenuOpen.value && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeWorkspaceMenu(true) }
  }
  watch([locked, sidebarOpen], ([isBusy, isOpen]) => { if (isBusy || !isOpen) closeWorkspaceMenu() })
  onMounted(() => {
    window.document.addEventListener('pointerdown', dismissWorkspaceMenu)
    window.document.addEventListener('keydown', escapeWorkspaceMenu)
  })
  onBeforeUnmount(() => {
    window.document.removeEventListener('pointerdown', dismissWorkspaceMenu)
    window.document.removeEventListener('keydown', escapeWorkspaceMenu)
  })
  return { workspacePicker, workspaceTrigger, workspaceList, workspaceMenuOpen: shallowReadonly(workspaceMenuOpen), activeWorkspaceIndex: shallowReadonly(activeWorkspaceIndex),
    setActiveWorkspace: index => { activeWorkspaceIndex.value = index }, closeWorkspaceMenu, openWorkspaceMenu, handleWorkspaceTriggerKey, handleWorkspaceListKey, handleWorkspaceFocusOut }
}
