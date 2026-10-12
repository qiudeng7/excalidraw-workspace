import {
  createDefaultUserSettings,
  type UserSettings,
} from "#shared/contracts";
import type { UserSettingsStatus } from "~/lib/userSettings";

export type RenderingOptions = UserSettings["debug"]["renderingOptions"];

export type Sampling = UserSettings["debug"]["sampling"];

export const defaultRenderingOptions =
  createDefaultUserSettings().debug.renderingOptions;

export const featureControls: [
  keyof UserSettings["features"],
  string,
  string,
][] = [
  [
    "disableDefaultSidebar",
    "关闭excalidraw默认侧边栏",
    "开启后关闭 Excalidraw 自带的右侧素材库与查找侧边栏及其入口；关闭此开关可恢复使用。",
  ],
  [
    "bottomToolbar",
    "工具栏置底",
    "开启时工具栏位于画布底部，关闭后移至顶部；提示与更多工具菜单随位置调整。",
  ],
  [
    "edgeBinding",
    "连线交互优化",
    "普通箭头指向元素内部或边缘时，默认连接到轮廓，避免遮挡内容；拖拽未松手时按住 Ctrl 可连接到内部，松开 Ctrl 恢复轮廓连接。Alt / ⌘ 保留原行为。折线箭头及重叠等特殊几何沿用原规则。",
  ],
  [
    "nunitoFont",
    "默认 Nunito 字体",
    "开启使用 Nunito，关闭恢复 Excalifont。只更新新建文字的工具默认，不修改已有文字。",
  ],
  [
    "formalLines",
    "默认正式线条",
    "开启使用规整线条与实线，关闭恢复上游手绘幅度与实线。只更新工具默认，不修改已有图形。",
  ],
  [
    "solidFill",
    "默认实心填充",
    "只更新工具默认，不修改已有图形。当前上游默认也是实心，关闭可能没有视觉差异。",
  ],
  [
    "shortArrowheads",
    "短箭头头部",
    "调整画布上所有开放箭头头部的显示，并应用到图片与 SVG 导出，不改动元素数据。其他应用打开 JSON 时按其自身样式显示。",
  ],
];

export const settingsStatuses: Record<UserSettingsStatus, string> = {
  loading: "正在读取设置…",
  unavailable: "未读取云端设置",
  synced: "设置已同步",
  pending: "设置待保存",
  saving: "正在同步设置…",
  error: "设置保存失败",
  conflict: "设置与云端有冲突",
};

const storageKey = "excalidraw-demo:rendering-options";

export function readLegacyRenderingOptions(): RenderingOptions {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "{}");

    return Object.fromEntries(
      Object.keys(defaultRenderingOptions).map((key) => [
        key,
        stored?.[key] === true,
      ]),
    ) as RenderingOptions;
  } catch (error) {
    console.warn("无法读取旧渲染配置，使用默认配置", error);

    return { ...defaultRenderingOptions };
  }
}

export const renderingControls: [keyof RenderingOptions, string, string][] = [
  [
    "smoothCache",
    "缓存位图平滑",
    "平滑缩放缓存位图，可能减少锯齿，也可能让文字变软。",
  ],
  [
    "highQualitySmoothing",
    "高质量平滑",
    "需先开启缓存位图平滑；请求浏览器使用高质量插值，效果取决于浏览器。",
  ],
  [
    "directText",
    "文字直接绘制",
    "绕过文字位图缓存，每次重绘文字；可能增加渲染开销。",
  ],
  [
    "directShapes",
    "简单图形直接绘制",
    "矩形、圆形、菱形、线条及无文字箭头绕过位图缓存；带文字箭头保持原样。",
  ],
  [
    "alignPixels",
    "绘制位置对齐像素",
    "未旋转元素的绘制起点对齐画布像素，最多偏移半像素；不改变元素坐标。",
  ],
  [
    "smoothCanvas",
    "始终平滑显示画布",
    "在 1× 时也取消像素化显示；1.5× 和 2× 本来就使用平滑显示。",
  ],
];

const samplingStorageKey = "excalidraw-demo:canvas-sampling";
const normalize = (value: number): Sampling =>
  value === 1.5 || value === 2 ? value : 1;

export function readLegacySampling(): Sampling {
  try {
    return normalize(Number(localStorage.getItem(samplingStorageKey)));
  } catch (error) {
    console.warn("无法读取旧采样配置，使用默认倍率", error);

    return 1;
  }
}
