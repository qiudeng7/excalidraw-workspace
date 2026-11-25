// 本文件确保前端发出的所有自定义 X-* 请求头都在跨域预检的允许列表里，
// 否则被宿主嵌入时浏览器会在预检阶段拒绝对应接口。不覆盖响应头与 Origin 白名单。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_REQUEST_HEADERS } from "../../server/middleware/cors";

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);

    return statSync(path).isDirectory()
      ? sources(path)
      : /\.(ts|vue)$/.test(name)
        ? [path]
        : [];
  });
}

test("前端使用的 X-* 请求头都允许跨域", () => {
  const allowed = new Set(ALLOWED_REQUEST_HEADERS.map((h) => h.toLowerCase()));
  const used = new Set<string>();

  for (const file of sources("src"))
    for (const match of readFileSync(file, "utf8").matchAll(
      /["'](x-[a-z-]+)["']/gi,
    ))
      used.add(match[1].toLowerCase());

  assert.ok(used.size > 0);
  for (const header of used)
    assert.ok(allowed.has(header), `${header} 未加入 CORS 允许头`);
});
