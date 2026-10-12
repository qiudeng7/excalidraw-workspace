export interface ReleaseNote {
  readonly id: string;
  readonly sequence: number;
  readonly version: string;
  readonly date: string;
  readonly title: string;
  readonly summary: string;
  readonly changes: readonly string[];
  readonly actions: readonly string[];
}

// Newest first. sequence identifies a release batch even when version stays the same.
export const releases: readonly ReleaseNote[] = [
  {
    id: "workspace-2026-10-12-settings-cache",
    sequence: 2,
    version: "0.2.0",
    date: "2026-10-12",
    title: "切换更轻快，设置更集中",
    summary: "画布缓存、后台保存与统一设置已就位，也可以在这里回看每次更新。",
    changes: [
      "切换画布先展示本地缓存，确认云端版本后恢复编辑；已有修改会在后台保存。",
      "素材库在首次打开时加载，同一账号切换画布时复用。",
      "设置统一收纳通用、编辑器、账号和调试选项，系统设置仅管理员可见。",
      "可以调整默认侧边栏、工具栏位置和外观主题；修改密码需要验证原密码。",
      "新增更新公告与更新日志，新公告会在登录并加载工作空间后显示一次。",
    ],
    actions: [],
  },
  {
    id: "workspace-2026-10-11-theme",
    sequence: 1,
    version: "0.2.0",
    date: "2026-10-11",
    title: "深色模式与系统主题",
    summary: "画布工作空间支持浅色、深色与跟随系统主题。",
    changes: ["新增主题切换菜单，并支持键盘操作。"],
    actions: [],
  },
];

export const currentRelease = releases[0]!;
