import { ref, shallowRef, shallowReadonly, onMounted, onBeforeUnmount, type Ref } from 'vue'
import type { Bootstrap, User } from '../../shared/contracts'
import type { AccountApi } from '../lib/accountApi'
import { createUserSettingsResource, type UserSettingsResource } from '../lib/userSettings'
import type { SaveBarrier } from '../lib/editor'

export interface AccountSessionDependencies {
  api: AccountApi
  editor: SaveBarrier
  loadWorkspaces(): Promise<void>
  clearWorkspace(): void
  run(action: () => Promise<void>): Promise<void>
  reportError(message: string): void
}
export interface AccountSessionController {
  bootstrap: Readonly<Ref<Bootstrap | undefined>>
  user: Readonly<Ref<User | null>>
  settingsResource: Readonly<Ref<UserSettingsResource | undefined>>
  starting: Readonly<Ref<boolean>>
  settingsBusy: Readonly<Ref<boolean>>
  initialize(): Promise<void>
  authenticated(account: User): Promise<void>
  logout(): Promise<void>
  toggleRegistration(event: Event): Promise<void>
  flushSettings(): Promise<void>
}
export function useAccountSession({ api, editor, loadWorkspaces, clearWorkspace, run, reportError }: AccountSessionDependencies): AccountSessionController {
  const bootstrap = ref<Bootstrap>()
  const user = ref<User | null>(null)
  const settingsResource = shallowRef<UserSettingsResource>()
  const starting = ref(true)
  const settingsBusy = ref(false)
  let accountGeneration = 0
  async function loadAccountSettings(account: User) {
    const capturedGeneration = ++accountGeneration
    settingsResource.value?.dispose()
    const resource = createUserSettingsResource(account.id, () => accountGeneration === capturedGeneration && user.value?.id === account.id)
    settingsResource.value = resource
    await resource.load()
  }
  async function flushSettings() {
    if (settingsResource.value && !await settingsResource.value.flush()) throw new Error('设置尚未同步，请在 flag 菜单处理设置提示后再退出或跳转。')
  }
  function protectUnsavedSettings(event: BeforeUnloadEvent) {
    if (settingsResource.value && ['pending', 'saving', 'error', 'conflict'].includes(settingsResource.value.state.status)) { event.preventDefault(); event.returnValue = '' }
  }
  function disposeSettings() {
    accountGeneration++
    settingsResource.value?.dispose()
    settingsResource.value = undefined
  }
  async function initialize() {
    starting.value = true
    reportError('')
    try {
      bootstrap.value = await api.bootstrap()
      if (!bootstrap.value.needsSetup) {
        user.value = await api.session()
        if (user.value) { await loadAccountSettings(user.value); await loadWorkspaces() }
      }
    } catch (cause) { reportError(cause instanceof Error ? cause.message : '无法连接服务') }
    finally { starting.value = false }
  }
  async function authenticated(account: User) {
    user.value = account
    await run(async () => {
      bootstrap.value = await api.bootstrap()
      await loadAccountSettings(account)
      await loadWorkspaces()
    })
  }
  async function logout() {
    await run(async () => {
      await editor.flush()
      await flushSettings()
      await api.logout()
      disposeSettings()
      user.value = null
      clearWorkspace()
      bootstrap.value = await api.bootstrap()
    })
  }
  async function toggleRegistration(event: Event) {
    if (!bootstrap.value) return
    const input = event.target as HTMLInputElement
    const enabled = input.checked
    input.checked = bootstrap.value.registrationEnabled
    settingsBusy.value = true
    reportError('')
    try { bootstrap.value = { ...bootstrap.value, registrationEnabled: await api.setRegistration(enabled) } }
    catch (cause) { reportError(cause instanceof Error ? cause.message : '设置失败') }
    finally { settingsBusy.value = false }
  }
  onMounted(() => { void initialize(); window.addEventListener('beforeunload', protectUnsavedSettings) })
  onBeforeUnmount(() => { disposeSettings(); window.removeEventListener('beforeunload', protectUnsavedSettings) })
  return { bootstrap: shallowReadonly(bootstrap), user: shallowReadonly(user), settingsResource: shallowReadonly(settingsResource), starting: shallowReadonly(starting), settingsBusy: shallowReadonly(settingsBusy), initialize, authenticated, logout, toggleRegistration, flushSettings }
}
