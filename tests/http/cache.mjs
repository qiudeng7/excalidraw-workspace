// Real local HTTP regression: conditional snapshots remain private and preserve CAS.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localOrigin } from "../../scripts/local-smoke.mjs";

const origin = localOrigin(process.argv[2] ?? "http://127.0.0.1:3000");
let cookie;
const request = (path, method = "GET", data, headers = {}) =>
  fetch(new URL(`/api${path}`, origin), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: origin.origin,
      "Content-Type": "application/json",
      "X-Requested-With": "excalidraw-demo",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
const initial = await (await request("/bootstrap")).json();

assert.ok(
  initial.needsSetup || initial.registrationEnabled,
  "测试库需允许创建随机账户",
);
const account = await request(
  initial.needsSetup ? "/setup" : "/register",
  "POST",
  {
    email: `cache-${randomUUID()}@example.test`,
    password: `Cache-${randomUUID()}!`,
  },
);

assert.equal(account.status, 200);
cookie = account.headers.get("set-cookie")?.split(";")[0];
const owner = (await account.json()).user.id;
const space = (await (await request("/workspaces")).json()).workspaces[0];
const canvas = (
  await (await request(`/workspaces/${space.id}/canvases`)).json()
).canvases[0];
const scene = {
  elements: [{ id: "cache-smoke", type: "rectangle" }],
  appState: {},
  files: { image: { dataURL: "data:image/png;base64,dGVzdA==" } },
};

assert.equal(
  (await request(`/canvases/${canvas.id}`, "PUT", { revision: 0, scene }))
    .status,
  200,
);
assert.equal(
  (
    await request("/library", "PUT", {
      revision: 0,
      items: [{ id: "cache-library" }],
    })
  ).status,
  200,
);
for (const path of [`/canvases/${canvas.id}`, "/library"]) {
  const full = await request(path, "GET", undefined, {
    "X-Resource-Owner": owner,
  });

  assert.equal(full.status, 200);
  const tag = full.headers.get("etag");

  assert.ok(tag);
  assert.equal(full.headers.get("cache-control"), "no-store");
  const matched = await request(path, "GET", undefined, {
    "X-Resource-Owner": owner,
    "If-None-Match": tag,
  });

  assert.equal(matched.status, 304);
  assert.equal(await matched.text(), "");
  const mismatch = await request(path, "GET", undefined, {
    "If-None-Match": '"obsolete"',
  });

  assert.equal(mismatch.status, 200);
  const data = await mismatch.json();

  assert.equal(data.canvas?.revision ?? data.revision, 1);
  assert.equal(
    (
      await request(path, "GET", undefined, {
        "X-Resource-Owner": "wrong-owner",
        "If-None-Match": tag,
      })
    ).status,
    401,
  );
  const savedCookie = cookie;

  cookie = undefined;
  assert.equal(
    (await request(path, "GET", undefined, { "If-None-Match": tag })).status,
    401,
  );
  cookie = savedCookie;
}
assert.equal(
  (await request(`/canvases/${canvas.id}`, "PUT", { revision: 0, scene }))
    .status,
  409,
);
console.log(
  "✓ 实际本地 Worker / D1：画布与素材库条件读取 304 / 200、私有权限和保存 CAS 通过",
);
