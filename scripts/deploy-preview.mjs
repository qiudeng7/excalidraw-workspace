import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = new URL("../wrangler.jsonc", import.meta.url);
const target = {
  name: "excalidraw-workspace-preview",
  origin: "https://excalidraw-workspace-preview.qiudeng.workers.dev",
  bucket: "excalidraw-workspace-preview-data",
};

function requireSafe(condition, message) {
  if (!condition) throw new Error(`拒绝 preview 部署：${message}`);
}

export function readConfig() {
  const parsed = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync(configPath, "utf8"),
  );
  requireSafe(!parsed.error, "wrangler.jsonc 解析失败");
  return parsed.config;
}

export function validateConfig(config) {
  const preview = config.env?.preview;
  requireSafe(
    preview && preview.name === target.name && preview.name !== config.name,
    "Worker 名称不安全",
  );
  const allowed = [
    "name",
    "workers_dev",
    "preview_urls",
    "routes",
    "vars",
    "d1_databases",
    "r2_buckets",
    "durable_objects",
    "triggers",
  ];
  requireSafe(
    Object.keys(preview).every((key) => allowed.includes(key)),
    "preview 含未经审核的配置字段",
  );
  requireSafe(
    config.main === "server/worker.mjs" &&
      config.tsconfig === ".nuxt/tsconfig.server.json",
    "必须使用 Worker wrapper",
  );
  requireSafe(
    preview.workers_dev === true &&
      preview.preview_urls === false &&
      Array.isArray(preview.routes) &&
      preview.routes.length === 0,
    "preview 访问目标不安全",
  );
  requireSafe(
    preview.vars?.PUBLIC_ORIGIN === target.origin &&
      preview.vars.PUBLIC_ORIGIN !== config.vars?.PUBLIC_ORIGIN,
    "PUBLIC_ORIGIN 不安全",
  );
  requireSafe(preview.d1_databases?.length === 1, "preview 必须只有一个 D1");
  const db = preview.d1_databases[0];
  requireSafe(
    db.binding === "DB" && db.database_name === target.name,
    "D1 binding 或名称不正确",
  );
  requireSafe(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      db.database_id ?? "",
    ),
    "D1 UUID 未初始化或无效",
  );
  requireSafe(
    !(config.d1_databases ?? []).some(
      (prod) =>
        prod.database_id?.toLowerCase() === db.database_id.toLowerCase() ||
        prod.database_name === db.database_name,
    ),
    "D1 指向生产资源",
  );
  requireSafe(
    db.migrations_dir === "server/db/migrations/sqlite" &&
      db.migrations_table === "d1_migrations",
    "D1 迁移设置不正确",
  );
  requireSafe(
    Object.keys(db).every((key) =>
      [
        "binding",
        "database_name",
        "database_id",
        "migrations_dir",
        "migrations_table",
      ].includes(key),
    ),
    "D1 含未经审核的配置字段",
  );
  requireSafe(
    preview.r2_buckets?.length === 1,
    "preview 必须只有一个 R2 bucket",
  );
  const bucket = preview.r2_buckets[0];
  requireSafe(
    bucket.binding === "BLOB" &&
      bucket.bucket_name === target.bucket &&
      Object.keys(bucket).length === 2,
    "R2 配置不安全",
  );
  requireSafe(
    !(config.r2_buckets ?? []).some(
      (prod) => prod.bucket_name === bucket.bucket_name,
    ),
    "R2 指向生产资源",
  );
  const bindings = preview.durable_objects?.bindings;
  requireSafe(
    bindings?.length === 1 &&
      bindings[0].name === "CANVAS_ROOMS" &&
      bindings[0].class_name === "CanvasRoom" &&
      Object.keys(bindings[0]).length === 2,
    "DO 必须绑定本 Worker，禁止 script_name",
  );
  requireSafe(
    JSON.stringify(config.migrations) ===
      JSON.stringify([
        { tag: "canvas-room-v1", new_sqlite_classes: ["CanvasRoom"] },
      ]),
    "DO 历史迁移不正确",
  );
  requireSafe(
    JSON.stringify(preview.triggers) ===
      JSON.stringify({ crons: ["0 * * * *"] }),
    "preview 定时任务不正确",
  );
  return {
    worker: preview.name,
    origin: preview.vars.PUBLIC_ORIGIN,
    database: db.database_name,
    databaseId: db.database_id,
    bucket: bucket.bucket_name,
  };
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} 失败（exit ${result.status}）`,
    );
  return result.stdout?.trim() ?? "";
}

export function deployPreview(
  args,
  { load = readConfig, execute = run, log = console.log } = {},
) {
  requireSafe(
    args.length === 0 || (args.length === 1 && args[0] === "--dry-run"),
    "只接受 --dry-run，不能覆盖 env/config/name",
  );
  const dryRun = args.length === 1;
  const validateCheckout = () => {
    if (dryRun) return;
    requireSafe(
      execute("git", ["rev-parse", "HEAD"], true) ===
        execute("git", ["rev-parse", "refs/heads/dev"], true),
      "真实部署的 HEAD 必须等于本地 dev 提交",
    );
    requireSafe(
      execute("git", ["status", "--porcelain"], true) === "",
      "真实部署必须使用干净的已提交 worktree",
    );
  };
  const destination = validateConfig(load());
  validateCheckout();
  log(
    `${dryRun ? "本地 dry-run（无远端迁移/部署）" : "部署目标"}: ${JSON.stringify(destination)}`,
  );
  execute("pnpm", ["build"]);
  requireSafe(
    JSON.stringify(validateConfig(load())) === JSON.stringify(destination),
    "构建后部署目标发生变化",
  );
  validateCheckout();
  if (!dryRun) execute("pnpm", ["db:migrate:preview"]);
  execute("pnpm", [
    "exec",
    "wrangler",
    "deploy",
    ...(dryRun ? ["--dry-run"] : []),
    "--env",
    "preview",
    "--config",
    "wrangler.jsonc",
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    deployPreview(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
