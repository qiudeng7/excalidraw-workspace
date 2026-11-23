import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  distPath,
  normalizeDocument,
  readVersion,
  sourcePath,
  validateDocument,
} from "../../scripts/openapi.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture() {
  return {
    openapi: "3.1.0",
    info: { title: "Nitro Server Routes" },
    servers: [{ url: "http://localhost" }],
    paths: {
      "/api/bootstrap": { get: { responses: { 200: { description: "OK" } } } },
      "/api/canvases/{id}": {
        get: { responses: { 200: { description: "OK" } } },
        put: { responses: { 200: { description: "OK" } } },
      },
      "/_openapi.json": { get: { responses: { 200: { description: "OK" } } } },
      "/__nuxt_island/{*param1}": {
        get: { responses: { 200: { description: "OK" } } },
      },
    },
  };
}

test("normalizeDocument keeps API paths, drops build-only routes", () => {
  const document = normalizeDocument(fixture(), "9.9.9");

  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.version, "9.9.9");
  assert.equal(document.info.title.length > 0, true);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    "/api/bootstrap",
    "/api/canvases/{id}",
  ]);
  assert.deepEqual(Object.keys(document.paths["/api/canvases/{id}"]).sort(), [
    "get",
    "put",
  ]);
  assert.equal(document.servers.length, 1);
  assert.deepEqual(validateDocument(document), []);
});

test("normalizeDocument rejects documents without paths", () => {
  assert.throws(() => normalizeDocument({}, "1.0.0"), /paths/);
});

test("validateDocument reports missing methods, info and wrong version", () => {
  const problems = validateDocument({
    openapi: "3.0.3",
    info: { title: "" },
    paths: {
      "/api/empty": {},
      "/api/bootstrap": { get: {} },
      "/health": { get: { responses: { 200: { description: "OK" } } } },
    },
  });

  assert.equal(
    problems.some((problem) => problem.includes("3.1")),
    true,
  );
  assert.equal(
    problems.some((problem) => problem.includes("info.version")),
    true,
  );
  assert.equal(
    problems.some((problem) => problem.includes("/api/empty")),
    true,
  );
  assert.equal(
    problems.some((problem) => problem.includes("缺少 responses")),
    true,
  );
  assert.equal(
    problems.some((problem) => problem.includes("/health")),
    true,
  );
});

/**
 * Derive the expected route from a server handler file name, mirroring Nitro:
 * `foo/[id].get.ts` -> `GET /api/foo/{id}`, `index.get.ts` -> `GET /api/foo`.
 */
function routeOf(file) {
  const name = relative(join(project, "server/api"), file)
    .replace(/\.ts$/, "")
    .replace(/\.(get|post|put|patch|delete|options|head)$/, "");
  const segments = name
    .split("/")
    .map((segment) =>
      segment === "index"
        ? ""
        : segment.replace(/^\[(?:\.\.\.)?([^\]]+)\]$/, "{$1}"),
    )
    .filter(Boolean);

  return `/api/${segments.join("/")}`;
}

function handlerFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) return handlerFiles(path);

    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("generated openapi.json covers every server/api route", (t) => {
  const file = distPath(project);

  if (!existsSync(file)) {
    t.skip("缺少 dist/openapi.json：先执行 pnpm build 或 pnpm build:node");
    return;
  }

  const document = JSON.parse(readFileSync(file, "utf8"));
  const paths = Object.keys(document.paths);

  assert.match(document.openapi, /^3\.1\.\d+$/);
  assert.equal(document.info.version, readVersion(project));
  assert.deepEqual(validateDocument(document), []);

  for (const route of ["/api/bootstrap", "/api/canvases/{id}"]) {
    assert.equal(paths.includes(route), true, `${route} 未出现在 openapi.json`);
  }

  const missing = handlerFiles(join(project, "server/api"))
    .map(routeOf)
    .filter((route) => !paths.includes(route));

  assert.deepEqual([...new Set(missing)], []);
});

test("generated openapi.json contains no secrets or non-API runtime routes", (t) => {
  const file = distPath(project);

  if (!existsSync(file)) {
    t.skip("缺少 dist/openapi.json：先执行 pnpm build 或 pnpm build:node");
    return;
  }

  const text = readFileSync(file, "utf8");
  const document = JSON.parse(text);

  for (const route of Object.keys(document.paths)) {
    assert.match(route, /^\/api\//);
  }

  assert.equal(/_scalar|_swagger/.test(text), false);
  // Only route metadata is emitted; request/response payloads, auth schemes and
  // credential-looking values must never be baked into the build artifact.
  assert.equal("security" in document, false);
  assert.equal("securitySchemes" in (document.components ?? {}), false);
  assert.equal(/Bearer |sk-[A-Za-z0-9]{8,}|eyJ[\w-]{8,}/.test(text), false);
});

test("source document produced by the build stays at Nitro's stable route", (t) => {
  const file = sourcePath(project);

  if (!existsSync(file)) {
    t.skip(
      "缺少 .output/public/_openapi.json：先执行 pnpm build 或 pnpm build:node",
    );
    return;
  }

  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).info.version,
    readVersion(project),
  );
});
