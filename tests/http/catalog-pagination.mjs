// 仅访问回环测试服务：用真实 HTTP、账号会话和本地 Worker/D1 验证分页、游标冲突及局部移动。
// 仅创建本次随机账号的隔离数据；不覆盖数据库执行计划、浏览器或生产云资源。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localClient, expect, report } from "./support/local-client.mjs";

const request = localClient(process.argv[2] ?? "http://localhost:3000");
const bootstrap = expect(await request("/bootstrap"), 200);
assert.ok(
  bootstrap.needsSetup || bootstrap.registrationEnabled,
  "本地测试需允许注册，不修改注册开关",
);
const account = await request(
  bootstrap.needsSetup ? "/setup" : "/register",
  "POST",
  {
    email: `pagination-${randomUUID()}@example.test`,
    password: `Catalog-${randomUUID()}!`,
  },
);
expect(account, 200);
assert.ok(account.cookie);
const cookie = account.cookie;
const spaces = expect(
  await request("/workspaces", "GET", undefined, cookie),
  200,
).workspaces;
const workspaceId = spaces[0].id;
const path = `/workspaces/${workspaceId}/canvases`;
const catalog = async () =>
  expect(await request(path, "GET", undefined, cookie), 200);
const page = async (limit = 30, cursor) =>
  expect(
    await request(
      `${path}?${new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })}`,
      "GET",
      undefined,
      cookie,
    ),
    200,
  );
const ids = (rows) => rows.map((canvas) => canvas.id);
let current = await catalog();
for (let i = current.canvases.length; i < 35; i++) {
  const result = expect(
    await request(
      path,
      "POST",
      { name: `本地分页画布${i}`, catalogRevision: current.catalogRevision },
      cookie,
    ),
    200,
  );
  current = { catalogRevision: result.catalogRevision };
}
current = await catalog();
assert.equal(current.canvases.length, 35);
let first = await page();
assert.equal(first.canvases.length, 30);
assert.equal(first.total, 35);
assert.equal(first.catalogRevision, current.catalogRevision);
assert.equal(typeof first.nextCursor, "string");
const second = await page(30, first.nextCursor);
assert.equal(second.canvases.length, 5);
assert.equal(second.nextCursor, null);
assert.equal(second.total, 35);
assert.deepEqual([...first.canvases, ...second.canvases], current.canvases);
assert.equal(new Set(ids([...first.canvases, ...second.canvases])).size, 35);
const defaults = expect(
  await request(
    `${path}?cursor=${encodeURIComponent(first.nextCursor)}`,
    "GET",
    undefined,
    cookie,
  ),
  200,
);
assert.equal(defaults.canvases.length, 5);
assert.equal(defaults.nextCursor, null);
for (const limit of [0, 101, 1.5, "abc"])
  expect(
    await request(`${path}?limit=${limit}`, "GET", undefined, cookie),
    400,
  );
report("真实后端首屏30条、末页5条、总数与版本一致；旧接口返回完整35条");
const source = first.canvases.at(-1).id;
const targetId = second.canvases[0].id;
const moved = expect(
  await request(
    `/canvases/${source}/move`,
    "PUT",
    { targetId, placement: "after", catalogRevision: current.catalogRevision },
    cookie,
  ),
  200,
);
assert.deepEqual(Object.keys(moved).sort(), ["catalogRevision"]);
assert.equal(moved.catalogRevision, current.catalogRevision + 1);
const expected = ids(current.canvases).filter((id) => id !== source);
expected.splice(expected.indexOf(targetId) + 1, 0, source);
current = await catalog();
assert.deepEqual(ids(current.canvases), expected);
const stale = await request(
  `${path}?limit=30&cursor=${encodeURIComponent(first.nextCursor)}`,
  "GET",
  undefined,
  cookie,
);
assert.equal(stale.status, 409);
assert.equal(stale.body.error.code, "CATALOG_CONFLICT");
const retry = await request(
  `/canvases/${source}/move`,
  "PUT",
  { targetId, placement: "before", catalogRevision: moved.catalogRevision - 1 },
  cookie,
);
assert.equal(retry.status, 409);
assert.equal(retry.body.error.code, "CATALOG_CONFLICT");
assert.deepEqual(await catalog(), current);
report("跨第30/31条局部移动保留其余顺序，旧游标与旧目录写版本被拒绝");
const original = current.canvases.find((canvas) => canvas.id === source);
const pinned = expect(
  await request(
    `/canvases/${source}/pin?return=summary`,
    "PUT",
    { pinned: true, catalogRevision: current.catalogRevision },
    cookie,
  ),
  200,
);
assert.deepEqual(Object.keys(pinned).sort(), ["canvas", "catalogRevision"]);
assert.deepEqual(pinned.canvas, { ...original, pinned: true });
assert.equal(pinned.catalogRevision, current.catalogRevision + 1);
const crossGroup = await request(
  `/canvases/${source}/move`,
  "PUT",
  { targetId, placement: "before", catalogRevision: pinned.catalogRevision },
  cookie,
);
assert.equal(crossGroup.status, 400);
const legacy = expect(
  await request(
    `/canvases/${source}/pin`,
    "PUT",
    { pinned: false, catalogRevision: pinned.catalogRevision },
    cookie,
  ),
  200,
);
assert.equal(legacy.canvases.length, 35);
assert.deepEqual(legacy.canvases, current.canvases);
assert.equal(legacy.catalogRevision, pinned.catalogRevision + 1);
report("置顶summary只传单条元数据，组间移动拒绝，旧置顶接口仍返回完整目录");
first = await page();
const outsider = await request("/register", "POST", {
  email: `pagination-outsider-${randomUUID()}@example.test`,
  password: `Catalog-${randomUUID()}!`,
});
expect(outsider, 200);
expect(
  await request(
    `${path}?limit=30&cursor=${encodeURIComponent(first.nextCursor)}`,
    "GET",
    undefined,
    outsider.cookie,
  ),
  404,
);
expect(
  await request(
    `${path}?limit=30&cursor=${encodeURIComponent(first.nextCursor)}`,
  ),
  401,
);
report("后续页重新鉴权，其他账号与未登录会话均不能借用游标");
