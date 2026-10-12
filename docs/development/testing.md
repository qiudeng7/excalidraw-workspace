# 开发验证

[返回开发者指南](readme.md)

在仓库根目录按变更范围运行：

| 范围                          | 命令                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| 宿主类型                      | `pnpm typecheck`                                                           |
| API、数据库、保存资源、控制器 | `pnpm test:backend`                                                        |
| 代码风格与错误处理            | `pnpm lint`、`pnpm test:lint`                                              |
| Workers / Node 构建           | 串行执行 `pnpm build`、`pnpm build:node`                                   |
| 编辑器                        | [构建与 Chromium 检查](../../packages/excalidraw/README.md#验证与更新上游) |

各功能模块末尾列出相关测试及浏览器检查项。

## HTTP 验收

使用独立测试 checkout 和隔离数据，按[部署说明](../deployment.md)启动产物。脚本只接受回环 HTTP 地址，会创建账户并写入数据；下例端口及 `PUBLIC_ORIGIN` 须与测试服务一致。

[smoke-api.mjs](../../scripts/smoke-api.mjs) 要求全新、无管理员的测试库，检查账户、权限、图片快照、素材库并发保存及空间操作：

```sh
node scripts/smoke-api.mjs prepare http://localhost:3000 /tmp/workspace-smoke.json
```

重启同一服务并保留测试数据，再检查会话、登录与持久化：

```sh
node scripts/smoke-api.mjs verify http://localhost:3000 /tmp/workspace-smoke.json
```

`/tmp/workspace-smoke.json` 包含测试凭证，验收后删除。

另外两个脚本分别检查目录与导航并发、DELETE 请求体，以及设置校验、账户隔离和版本冲突：

```sh
node scripts/smoke-navigation.mjs http://localhost:3000
node scripts/smoke-user-settings.mjs http://localhost:3000
```

[目录脚本](../../scripts/smoke-navigation.mjs)需要另一份全新测试库；[设置脚本](../../scripts/smoke-user-settings.mjs)可使用开放注册的本地测试库。页面变更还需浏览器验收，HTTP 脚本不覆盖编辑器交互。
