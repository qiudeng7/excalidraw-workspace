import { createElement, type ChangeEvent } from 'react'
import { MainMenu } from '@excalidraw/excalidraw'

export type Sampling = 1 | 1.5 | 2
const storageKey = 'excalidraw-demo:canvas-sampling'
const normalize = (value: number): Sampling => value === 1.5 || value === 2 ? value : 1

export function readLegacySampling(): Sampling {
  try {
    return normalize(Number(localStorage.getItem(storageKey)))
  } catch {
    return 1
  }
}

export function SamplingMenu({ value, onChange, disabled = false }: {
  value: Sampling
  onChange: (value: Sampling) => void
  disabled?: boolean
}) {
  const select = createElement('select', {
    'aria-label': '采样倍率',
    value,
    disabled,
    title: '提高屏幕渲染精度，不改变画布缩放或图片导出尺寸；倍率越高，内存和渲染开销越大。',
    style: {
      marginInlineStart: 'auto',
      color: 'inherit',
      background: 'var(--island-bg-color)',
      border: '1px solid var(--default-border-color)',
      borderRadius: '4px',
      padding: '4px',
    },
    onChange: (event: ChangeEvent<HTMLSelectElement>) => {
      onChange(normalize(Number(event.target.value)))
    },
  }, ...([1, 1.5, 2] as const).map(ratio => createElement(
    'option',
    { key: ratio, value: ratio },
    `${ratio}×${ratio === 1 ? '（默认）' : ''}`,
  )))

  return createElement(MainMenu.ItemCustom, {
    className: 'canvas-sampling',
    children: createElement('label', {
      style: { display: 'flex', alignItems: 'center', gap: '1rem', width: '100%' },
    }, '采样倍率', select),
  })
}
