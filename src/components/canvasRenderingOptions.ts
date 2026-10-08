import { createElement, type ChangeEvent } from 'react'
import { MainMenu } from '@excalidraw/excalidraw'
import type { CanvasRenderingOptions } from '@excalidraw/excalidraw/renderer/renderingOptions'

export type RenderingOptions = Required<CanvasRenderingOptions>
export const defaultRenderingOptions: RenderingOptions = {
  smoothCache: false,
  highQualitySmoothing: false,
  directText: false,
  directShapes: false,
  alignPixels: false,
  smoothCanvas: false,
}
const storageKey = 'excalidraw-demo:rendering-options'

export function readRenderingOptions(): RenderingOptions {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}')
    return Object.fromEntries(Object.keys(defaultRenderingOptions).map(key => [
      key, stored?.[key] === true,
    ])) as RenderingOptions
  } catch {
    return { ...defaultRenderingOptions }
  }
}

export function saveRenderingOptions(value: RenderingOptions) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // 存储不可用时，设置在当前页面内仍然生效。
  }
}

const controls: [keyof RenderingOptions, string, string][] = [
  ['smoothCache', '缓存位图平滑', '平滑缩放缓存位图，可能减少锯齿，也可能让文字变软。'],
  ['highQualitySmoothing', '高质量平滑', '需先开启缓存位图平滑；请求浏览器使用高质量插值，效果取决于浏览器。'],
  ['directText', '文字直接绘制', '绕过文字位图缓存，每次重绘文字；可能增加渲染开销。'],
  ['directShapes', '简单图形直接绘制', '矩形、圆形、菱形、线条及无文字箭头绕过位图缓存；带文字箭头保持原样。'],
  ['alignPixels', '绘制位置对齐像素', '未旋转元素的绘制起点对齐画布像素，最多偏移半像素；不改变元素坐标。'],
  ['smoothCanvas', '始终平滑显示画布', '在 1× 时也取消像素化显示；1.5× 和 2× 本来就使用平滑显示。'],
]

export function RenderingOptionsMenu({ value, onChange, onReset }: {
  value: RenderingOptions
  onChange: (value: RenderingOptions) => void
  onReset: () => void
}) {
  return createElement(MainMenu.ItemCustom, {
    className: 'canvas-rendering-options',
    children: createElement('fieldset', {
      'aria-label': '渲染实验',
      style: { border: 0, padding: 0, margin: 0, width: '100%', minWidth: 0 },
    },
    ...controls.map(([key, label, title]) => createElement('label', {
      key, title,
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.35rem 0' },
    }, label, createElement('input', {
      type: 'checkbox',
      'aria-label': label,
      checked: value[key],
      disabled: key === 'highQualitySmoothing' && !value.smoothCache,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onChange({ ...value, [key]: event.target.checked }),
    }))),
    createElement('button', {
      type: 'button', onClick: onReset,
      style: { marginTop: '0.35rem', cursor: 'pointer', color: 'inherit', background: 'var(--island-bg-color)', border: '1px solid var(--default-border-color)', borderRadius: '4px', padding: '0.3rem 0.6rem' },
    }, '恢复默认渲染设置')),
  })
}
