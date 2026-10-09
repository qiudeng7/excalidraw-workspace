import { createElement, useState, type ChangeEvent } from 'react'
import { MainMenu } from '@excalidraw/excalidraw'
import type { UserSettings } from '../../shared/contracts'
import type { UserSettingsStatus } from '../lib/userSettings'
import { SamplingMenu, readLegacySampling } from './canvasSampling'
import { RenderingOptionsMenu, readLegacyRenderingOptions, defaultRenderingOptions } from './canvasRenderingOptions'

export interface FlagsMenuProps {
  settings: UserSettings
  ready: boolean
  configured: boolean
  status: UserSettingsStatus
  error: string
  conflict: boolean
  onChange: (settings: UserSettings) => void
  onRetry: () => void
  onReload: () => void
  onUseCloud: () => void
  onKeepLocal: () => void
}
const features: [keyof UserSettings['features'], string, string][] = [
  ['edgeBinding', '连线交互优化', '普通箭头指向元素内部或边缘时，默认连接到轮廓，避免遮挡内容；拖拽未松手时按住 Ctrl 可连接到内部，松开 Ctrl 恢复轮廓连接。Alt / ⌘ 保留原行为。折线箭头及重叠等特殊几何沿用原规则。'],
  ['nunitoFont', '默认 Nunito 字体', '开启使用 Nunito，关闭恢复 Excalifont。只更新新建文字的工具默认，不修改已有文字。'],
  ['formalLines', '默认正式线条', '开启使用规整线条与实线，关闭恢复上游手绘幅度与实线。只更新工具默认，不修改已有图形。'],
  ['solidFill', '默认实心填充', '只更新工具默认，不修改已有图形。当前上游默认也是实心，关闭可能没有视觉差异。'],
  ['shortArrowheads', '短箭头头部', '调整画布上所有开放箭头头部的显示，并应用到图片与 SVG 导出，不改动元素数据。其他应用打开 JSON 时按其自身样式显示。'],
]
const statuses: Record<UserSettingsStatus, string> = {
  loading: '正在读取设置…', unavailable: '未读取云端设置', synced: '设置已同步', pending: '设置待保存', saving: '正在同步设置…', error: '设置保存失败', conflict: '设置与云端有冲突',
}
function FeatureControl({ name, label, description, value, disabled, onChange }: {
  name: string; label: string; description: string; value: boolean; disabled: boolean; onChange: (value: boolean) => void
}) {
  const [tipOpen, setTipOpen] = useState(false)
  return createElement('div', { className: 'flag-feature-row' },
    createElement('label', null, label, createElement('input', {
      type: 'checkbox', checked: value, disabled, 'aria-label': label,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked),
    })),
    createElement('span', { className: `flag-help${tipOpen ? ' open' : ''}` },
      createElement('button', { type: 'button', className: 'flag-help-button', 'aria-label': `${label}说明`, 'aria-expanded': tipOpen, 'aria-describedby': `flag-tip-${name}`, onClick: () => setTipOpen(!tipOpen) }, '?'),
      createElement('span', { id: `flag-tip-${name}`, role: 'tooltip', className: 'flag-tooltip' }, description),
    ),
  )
}
export function CanvasFlagsMenu(props: FlagsMenuProps) {
  const [panel, setPanel] = useState<'features' | 'debug' | null>(null)
  const disabled = !props.ready || props.conflict || props.status === 'conflict'
  let hasLegacy = false
  try { hasLegacy = !!(localStorage.getItem('excalidraw-demo:canvas-sampling') || localStorage.getItem('excalidraw-demo:rendering-options')) } catch { /* Optional legacy settings. */ }
  const change = (settings: UserSettings) => { if (!disabled) props.onChange(settings) }
  return createElement(MainMenu.ItemCustom, { className: 'canvas-flags', children: createElement('div', null,
    ...(['features', 'debug'] as const).map(key => createElement('div', { key, className: 'flag-submenu' },
      createElement('button', { type: 'button', className: 'flag-submenu-toggle', 'aria-expanded': panel === key, 'aria-controls': `flag-panel-${key}`, onClick: () => setPanel(panel === key ? null : key) }, key === 'features' ? '功能' : '调试', createElement('span', { 'aria-hidden': true }, panel === key ? '−' : '+')),
      panel === key && createElement('div', { id: `flag-panel-${key}`, className: 'flag-submenu-content' }, key === 'features'
        ? features.map(([name, label, description]) => createElement(FeatureControl, { key: name, name, label, description, value: props.settings.features[name], disabled, onChange: value => change({ ...props.settings, features: { ...props.settings.features, [name]: value } }) }))
        : createElement('div', null,
          createElement(SamplingMenu, { value: props.settings.debug.sampling, disabled, onChange: sampling => change({ ...props.settings, debug: { ...props.settings.debug, sampling } }) }),
          createElement(RenderingOptionsMenu, { value: props.settings.debug.renderingOptions, disabled, onChange: renderingOptions => change({ ...props.settings, debug: { ...props.settings.debug, renderingOptions } }), onReset: () => change({ ...props.settings, debug: { sampling: 1, renderingOptions: { ...defaultRenderingOptions } } }) }),
          !props.configured && hasLegacy && createElement('button', { type: 'button', disabled, className: 'flag-action', onClick: () => change({ ...props.settings, debug: { sampling: readLegacySampling(), renderingOptions: readLegacyRenderingOptions() } }) }, '导入此浏览器旧调试设置'),
        )),
    )),
    createElement('div', { className: 'flag-save-status', role: props.error || props.conflict ? 'alert' : 'status' },
      createElement('span', null, statuses[props.status] || '设置待保存'),
      props.error && createElement('small', null, props.error),
      !props.ready && createElement('button', { type: 'button', className: 'flag-action', onClick: props.onReload, disabled: props.status === 'loading' }, '重新读取设置'),
      (props.status === 'error' || (props.status === 'conflict' && !props.conflict)) && createElement('button', { type: 'button', className: 'flag-action', onClick: props.onRetry }, '重试同步'),
      props.conflict && createElement('div', { className: 'flag-conflict-actions' },
        createElement('button', { type: 'button', className: 'flag-action', onClick: props.onUseCloud }, '采用云端设置'),
        createElement('button', { type: 'button', className: 'flag-action', onClick: props.onKeepLocal }, '保存当前设置'),
      ),
    ),
  ) })
}
