import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  deployPreview,
  readConfig,
  validateConfig,
} from "../../scripts/deploy-preview.mjs";

const config = readConfig();
const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

function harness(options = {}) {
  const calls = [];
  return {
    calls,
    load: () => structuredClone(config),
    log: () => {},
    execute(command, args) {
      calls.push([command, ...args]);
      if (command === "git") {
        if (args[0] === "status") return options.dirty ? "?? unexpected" : "";
        return args[1] === "HEAD" && options.unmerged
          ? "unmerged"
          : "preview-sha";
      }
      if (options.fail === args[0]) throw new Error("command failed");
      return "";
    },
  };
}

test("preview configuration isolates every persistent resource and keeps wrapper", () => {
  assert.equal(validateConfig(config).worker, "excalidraw-workspace-preview");
  assert.equal(config.main, "server/worker.mjs");
  assert.deepEqual(config.migrations, [
    { tag: "canvas-room-v1", new_sqlite_classes: ["CanvasRoom"] },
  ]);
  assert.equal(
    packageJson.scripts.deploy,
    "pnpm build && pnpm db:migrate:remote && wrangler deploy --config wrangler.jsonc",
  );
  assert.equal(
    packageJson.scripts["db:migrate:preview"],
    "wrangler d1 migrations apply DB --remote --env preview --config wrangler.jsonc",
  );
  assert.match(packageJson.scripts.build, /NITRO_PRESET=cloudflare-module/);
});

const mutations = {
  "missing env": (c) => {
    delete c.env;
  },
  "production Worker": (c) => {
    c.env.preview.name = c.name;
  },
  "production origin": (c) => {
    c.env.preview.vars.PUBLIC_ORIGIN = c.vars.PUBLIC_ORIGIN;
  },
  "empty UUID": (c) => {
    c.env.preview.d1_databases[0].database_id = "";
  },
  "placeholder UUID": (c) => {
    c.env.preview.d1_databases[0].database_id = "TODO";
  },
  "zero UUID": (c) => {
    c.env.preview.d1_databases[0].database_id =
      "00000000-0000-0000-0000-000000000000";
  },
  "production D1": (c) => {
    c.env.preview.d1_databases[0].database_id =
      c.d1_databases[0].database_id.toUpperCase();
  },
  "production bucket": (c) => {
    c.env.preview.r2_buckets[0].bucket_name = c.r2_buckets[0].bucket_name;
  },
  "cross-worker DO": (c) => {
    c.env.preview.durable_objects.bindings[0].script_name = c.name;
  },
  "generated entry": (c) => {
    c.env.preview.main = ".output/server/index.mjs";
  },
  "wrong wrapper": (c) => {
    c.main = ".output/server/index.mjs";
  },
  "extra D1": (c) => {
    c.env.preview.d1_databases.push(c.d1_databases[0]);
  },
  "changed migration": (c) => {
    c.migrations[0].tag = "replacement";
  },
  "public route": (c) => {
    c.env.preview.routes = ["example.com/*"];
  },
  "previews enabled": (c) => {
    c.env.preview.preview_urls = true;
  },
  "missing cron": (c) => {
    delete c.env.preview.triggers;
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`fail closed before any command: ${name}`, () => {
    const h = harness();
    h.load = () => {
      const c = structuredClone(config);
      mutate(c);
      return c;
    };
    assert.throws(() => deployPreview([], h), /拒绝 preview 部署/);
    assert.deepEqual(h.calls, []);
  });
}

test("reject all target overrides and unknown arguments", () => {
  for (const args of [
    ["--env", "production"],
    ["--config", "other.jsonc"],
    ["--name", "production"],
    ["--dry-run", "--env", "preview"],
    ["--dry-run", "--dry-run"],
    ["--"],
  ]) {
    const h = harness();
    assert.throws(() => deployPreview(args, h), /只接受 --dry-run/);
    assert.deepEqual(h.calls, []);
  }
});

test("real deployment requires clean HEAD equal to dev, including detached checkout", () => {
  for (const options of [{ dirty: true }, { unmerged: true }]) {
    const h = harness(options);
    assert.throws(() => deployPreview([], h), /真实部署/);
    assert.ok(h.calls.every(([command]) => command === "git"));
  }
  const h = harness();
  deployPreview([], h);
  assert.deepEqual(
    h.calls.filter(([command]) => command === "pnpm"),
    [
      ["pnpm", "build"],
      ["pnpm", "db:migrate:preview"],
      [
        "pnpm",
        "exec",
        "wrangler",
        "deploy",
        "--env",
        "preview",
        "--config",
        "wrangler.jsonc",
      ],
    ],
  );
});

test("dry-run only builds and bundles, never migrates or deploys remotely", () => {
  const h = harness({ dirty: true, unmerged: true });
  deployPreview(["--dry-run"], h);
  assert.deepEqual(h.calls, [
    ["pnpm", "build"],
    [
      "pnpm",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--env",
      "preview",
      "--config",
      "wrangler.jsonc",
    ],
  ]);
});

test("build or migration failure prevents deploy", () => {
  for (const fail of ["build", "db:migrate:preview"]) {
    const h = harness({ fail });
    assert.throws(() => deployPreview([], h), /command failed/);
    assert.ok(!h.calls.some((call) => call.includes("wrangler")));
  }
});

test("configuration is revalidated after building", () => {
  const h = harness();
  let reads = 0;
  h.load = () => {
    const c = structuredClone(config);
    if (reads++)
      c.env.preview.d1_databases[0].database_id =
        "12345678-1234-4234-8234-123456789abc";
    return c;
  };
  assert.throws(() => deployPreview([], h), /构建后部署目标发生变化/);
  assert.ok(!h.calls.some((call) => call.includes("db:migrate:preview")));
});
