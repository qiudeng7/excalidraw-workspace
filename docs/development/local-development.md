# 本地启动

[返回目录](../../README.md#目录)

使用 Node.js 24 LTS 和 [package.json](../../package.json) 声明的 pnpm 11.24.0。

```sh
git clone https://github.com/qiudeng7/excalidraw-workspace.git
cd excalidraw-workspace
pnpm install --frozen-lockfile
pnpm dev
```

默认启动本地 Cloudflare，打开 http://localhost:8787。启动器自动构建、应用迁移并准备管理员和普通用户，登录页预填管理员账号，点击登录即可。需要 Node 热更新时执行 `pnpm dev --runtime node`，默认地址为 http://localhost:3000。

开发账号统一从 `.env.development.local` 读取，可先复制 [.env.development.example](../../.env.development.example)。不配置时使用模板中的开发预设；同名环境变量优先于文件。修改邮箱或密码后重启 `pnpm dev`，后端同步预设账号，前端填写相同值。密码变化会撤销该账号的旧会话，画布和其他用户数据保留。

两种运行时的开发数据分别保存在 `.data/development/worker/` 和 `.data/development/node/`，均被 Git 忽略，与线上和旧的 `.wrangler/`、`.data/db/` 数据独立。可用 `pnpm dev --port 8790 --data-dir /path/to/dev-data` 指定端口及数据目录；相对目录从仓库根目录解析。启动器只管理专属开发账号；指定目录已有其他管理员或邮箱冲突时会停止并提示换目录，不接管已有账户。

开发服务绑定本机回环地址。预填信息仅由 `pnpm dev` 显式启用，通过开发 API 提供；普通构建、Node 启动与部署不会启用这些账号。

`pnpm dev` 会先构建编辑器源码；修改编辑器后仍需重新构建，连续开发方式见[源码维护说明](../../packages/excalidraw/README.md#构建和开发)。

安装依赖时，`postinstall` 准备 Nuxt。若使用了 `--ignore-scripts`，随后执行 `pnpm exec nuxt prepare`。

`pnpm dev` 使用 Wrangler 模拟 D1、R2 和 Durable Objects；`pnpm dev --runtime node` 使用 Nuxt 热更新、本地 SQLite 与私有文件目录。编辑器源码仍需重新构建，应用页面和服务端代码在 Node 模式下支持热更新。

代码检查与测试命令见[开发验证](testing.md)，生产构建与启动见[部署](../deployment.md)。
