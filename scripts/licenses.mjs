import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const escapeHTML = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// Read the canonical files on every build; never maintain a second license copy.
export async function writeLicenseNotices(root, directory) {
  const entries = await Promise.all(
    [
      ["Excalidraw Workspace", "LICENSE"],
      ["Excalidraw", "packages/excalidraw/LICENSE"],
    ].map(async ([name, path]) => ({
      name,
      text: await readFile(join(root, path), "utf8"),
    })),
  );
  const introduction =
    "本项目的代码与纳入仓库的 Excalidraw 代码分别保留以下 MIT 版权和许可声明。其他第三方组件及字体遵循各自许可证；本页不将其重新授权为 MIT。";
  const text =
    `Excalidraw Workspace — 开源许可\n\n${introduction}\n\n` +
    entries
      .map((entry) => `${entry.name}\n${"=".repeat(72)}\n\n${entry.text}`)
      .join("\n\n");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>开源许可 · Excalidraw Workspace</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#202124}a{color:#3559a0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 ui-monospace,monospace}section{border-top:1px solid #ddd;margin-top:28px}h1{font-size:28px}h2{font-size:21px}</style><h1>开源许可</h1><p>${escapeHTML(introduction)}</p><p><a href="/">返回应用</a> · <a href="/licenses.txt">纯文本声明</a></p>${entries.map((entry) => `<section><h2>${escapeHTML(entry.name)}</h2><pre>${escapeHTML(entry.text)}</pre></section>`).join("")}</html>`;
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "licenses.txt"), text),
    writeFile(join(directory, "licenses.html"), html),
  ]);
}
