import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Nitro prerenders the OpenAPI document to `.output/public/_openapi.json` from
// the route metadata of every scanned server handler. This script normalizes
// that document (title, version, servers) and publishes it as `dist/openapi.json`.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

export const INFO = {
  title: "Excalidraw Workspace API",
  description:
    "JSON API of the Excalidraw Workspace application. Paths list the public API shape only; request and response bodies are described by the application contracts.",
};

export function sourcePath(root = projectRoot) {
  return join(root, ".output", "public", "_openapi.json");
}

export function distPath(root = projectRoot) {
  return join(root, "dist", "openapi.json");
}

export function readVersion(root = projectRoot) {
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );

  return packageJson.version;
}

/**
 * Keep only `/api/**` paths, their real HTTP methods, and the stable metadata
 * that outside consumers need. Nitro's own routes and prerender origin are
 * build details, not part of the API surface.
 */
export function normalizeDocument(document, version) {
  if (!document || typeof document !== "object" || !document.paths) {
    throw new TypeError("OpenAPI 文档缺少 paths");
  }

  const paths = {};

  for (const [route, item] of Object.entries(document.paths)) {
    if (!route.startsWith("/api/")) continue;
    const operations = Object.entries(item || {}).filter(([method]) =>
      METHODS.has(method),
    );

    if (operations.length === 0) continue;
    paths[route] = Object.fromEntries(operations);
  }

  const extensions = Object.fromEntries(
    Object.entries(document).filter(([key]) => key.startsWith("x-")),
  );

  return {
    openapi: document.openapi,
    info: { ...INFO, version },
    servers: [
      {
        url: "/",
        description: "以部署 origin 为准；生成 SDK 时按目标实例覆盖该地址",
      },
    ],
    paths,
    ...(document.components ? { components: document.components } : {}),
    ...extensions,
  };
}

/** Return human-readable problems; an empty array means the document is usable. */
export function validateDocument(document) {
  const problems = [];

  if (!/^3\.1\.\d+$/.test(document?.openapi ?? "")) {
    problems.push(`openapi 字段必须是 3.1.x，实际为 ${document?.openapi}`);
  }

  for (const field of ["title", "version"]) {
    if (typeof document?.info?.[field] !== "string" || !document.info[field]) {
      problems.push(`info.${field} 缺失`);
    }
  }

  const paths = document?.paths;

  if (!paths || typeof paths !== "object" || Object.keys(paths).length === 0) {
    problems.push("paths 为空");
    return problems;
  }

  for (const [route, item] of Object.entries(paths)) {
    if (!route.startsWith("/api/")) problems.push(`${route} 不是 /api/ 路径`);

    const methods = Object.keys(item || {});

    if (methods.length === 0) {
      problems.push(`${route} 没有任何 method`);
      continue;
    }

    for (const method of methods) {
      if (!METHODS.has(method)) {
        problems.push(`${route} 含有非法 method ${method}`);
        continue;
      }

      const responses = item[method]?.responses;

      if (!responses || Object.keys(responses).length === 0) {
        problems.push(`${route} ${method} 缺少 responses`);
      }
    }
  }

  return problems;
}

export function generate({ root = projectRoot, log = console.log } = {}) {
  const source = sourcePath(root);

  if (!existsSync(source)) {
    throw new Error(
      `找不到 ${relative(root, source)}，请先执行 pnpm build 或 pnpm build:node`,
    );
  }

  let raw;

  try {
    raw = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`无法解析 ${relative(root, source)}`, { cause: error });
  }

  const document = normalizeDocument(raw, readVersion(root));
  const problems = validateDocument(document);

  if (problems.length > 0) {
    throw new Error(`OpenAPI 校验失败：\n- ${problems.join("\n- ")}`);
  }

  const json = `${JSON.stringify(document, null, 2)}\n`;
  const dist = distPath(root);

  writeFileSync(source, json);
  mkdirSync(dirname(dist), { recursive: true });
  writeFileSync(dist, json);
  log(
    `openapi: ${Object.keys(document.paths).length} 个路径 -> ${relative(root, dist)}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    generate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
