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
    id: "workspace-2026-10-12-collaboration",
    sequence: 3,
    version: "0.3.0",
    date: "2026-10-12",
    title: "一起绘图，按需分享",
    summary:
      "画布支持多人和多会话实时协作，也可以分享实时内容、最新已保存内容或指定的固定版本。",
    changes: [
      "从画布顶部的“分享”邀请已有账号共同编辑或查看，也可以生成分享链接、设置有效期和登录要求，并随时撤销访问。",
      "实时查看持续跟随修改；最新版查看仅在打开或手动刷新时更新；固定版本查看保留发布时的内容、标题和图片。",
      "同一账号在多个浏览器编辑同一画布时会合并修改；离线修改先保存在当前浏览器，重连后继续同步。",
      "撤销只处理自己的修改，不回滚他人已更新的元素。多人同时修改同一段文字时，会采用其中一个完整文字版本。",
      "修复旧画布缓存迁入协作后一直停在“正在校验版本”的问题，未同步的旧草稿会保留并提供冲突处理入口。",
    ],
    actions: [],
  },
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
