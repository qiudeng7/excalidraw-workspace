import { cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// 对宿主只暴露声明文件，避免 Vue 的 JSX 类型检查进入 React 源码。
for (const name of ['math', 'utils']) {
  const target = fileURLToPath(new URL(`./lib/${name}/dist/`, import.meta.url))
  await rm(target, { recursive: true, force: true })
  await cp(new URL(`./dist/types/lib/${name}/`, import.meta.url), target, { recursive: true })
}
