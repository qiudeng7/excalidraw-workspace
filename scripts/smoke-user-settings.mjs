#!/usr/bin/env node
// 仅向本地测试服务创建独立账户，验证 Nitro/Workers 的实际配置与账户隔离。
// node scripts/smoke-user-settings.mjs http://localhost:8792
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const base = new URL(process.argv[2] ?? "http://localhost:3000");
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) &&
    base.protocol === "http:",
  "仅允许本地回环 HTTP",
);
assert.ok(
  !base.username &&
    !base.password &&
    base.pathname === "/" &&
    !base.search &&
    !base.hash,
  "仅提供本地 origin",
);
async function request(
  path,
  method = "GET",
  data,
  cookie,
  owner,
  settingsOwner = false,
) {
  const response = await fetch(new URL(`/api${path}`, base), {
    method,
    headers: {
      Origin: base.origin,
      "Content-Type": "application/json",
      "X-Requested-With": "excalidraw-demo",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(owner
        ? { [settingsOwner ? "X-Settings-Owner" : "X-Resource-Owner"]: owner }
        : {}),
    },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${method} ${path}: HTTP ${response.status} 返回非 JSON：${text.slice(0, 200)}`,
    );
  }
  return {
    status: response.status,
    body,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
const report = (message) => console.log(`✓ ${message}`);
const expect = (result, status) => {
  assert.equal(result.status, status);
  return result.body;
};
async function run() {
  const bootstrap = expect(await request("/bootstrap"), 200);
  assert.ok(
    bootstrap.needsSetup || bootstrap.registrationEnabled,
    "测试服务需要可注册",
  );
  const credentials = () => ({
    email: `settings-${randomUUID()}@example.test`,
    password: `Smoke-${randomUUID()}!`,
  });
  const alice = await request(
    bootstrap.needsSetup ? "/setup" : "/register",
    "POST",
    credentials(),
  );
  const bob = await request("/register", "POST", credentials());
  expect(alice, 200);
  expect(bob, 200);
  assert.ok(alice.cookie && bob.cookie);
  const readSettings = (user) =>
    request(
      "/user-settings",
      "GET",
      undefined,
      user.cookie,
      user.body.user.id,
      true,
    );
  const saveSettings = (user, settings, revision) =>
    request(
      "/user-settings",
      "PUT",
      { settings, revision },
      user.cookie,
      user.body.user.id,
      true,
    );
  const original = expect(await readSettings(alice), 200);
  assert.equal(original.revision, 0);
  assert.equal(original.configured, false);
  assert.equal(original.settings.version, 1);
  assert.ok(
    Object.values(original.settings.features).every((value) => value === true),
  );
  assert.ok(
    Object.values(original.settings.debug.renderingOptions).every(
      (value) => value === false,
    ),
  );
  const versions = await Promise.all(
    [true, false].map((edgeBinding) =>
      saveSettings(
        alice,
        {
          ...original.settings,
          features: { ...original.settings.features, edgeBinding },
        },
        0,
      ),
    ),
  );
  assert.deepEqual(versions.map((result) => result.status).sort(), [200, 409]);
  const cloud = expect(await readSettings(alice), 200);
  assert.equal(cloud.revision, 1);
  assert.equal(cloud.configured, true);
  assert.deepEqual(
    cloud,
    versions.find((result) => result.status === 200).body,
  );
  report("首次配置并发 CAS 只有一个成功");
  const next = structuredClone(cloud.settings);
  next.debug.sampling = 2;
  next.debug.renderingOptions.directText = true;
  expect(await saveSettings(alice, next, 1), 200);
  expect(await saveSettings(alice, original.settings, 1), 409);
  expect(await saveSettings(alice, { ...next, extra: true }, 2), 400);
  expect(
    await saveSettings(
      alice,
      { ...next, debug: { ...next.debug, sampling: 3 } },
      2,
    ),
    400,
  );
  assert.deepEqual(expect(await readSettings(bob), 200), original);
  report("完整配置白名单、倍率枚举、旧版本与用户隔离");
  for (const method of ["GET", "PUT"]) {
    const response = await request(
      "/user-settings",
      method,
      method === "PUT" ? { settings: next, revision: 0 } : undefined,
      bob.cookie,
      alice.body.user.id,
      true,
    );
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_CHANGED");
  }
  assert.deepEqual(expect(await readSettings(bob), 200), original);
  assert.equal(expect(await readSettings(alice), 200).revision, 2);
  report("旧标签页账户与当前 cookie 不同，配置读取/写入均拒绝");
  const items = [{ id: randomUUID(), elements: [] }];
  expect(
    await request(
      "/library",
      "PUT",
      { items, revision: 0 },
      alice.cookie,
      alice.body.user.id,
    ),
    200,
  );
  for (const method of ["GET", "PUT"]) {
    const response = await request(
      "/library",
      method,
      method === "PUT" ? { items, revision: 0 } : undefined,
      bob.cookie,
      alice.body.user.id,
    );
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_CHANGED");
  }
  assert.deepEqual(
    expect(
      await request("/library", "GET", undefined, bob.cookie, bob.body.user.id),
      200,
    ),
    { items: [], revision: 0 },
  );
  assert.deepEqual(
    expect(
      await request(
        "/library",
        "GET",
        undefined,
        alice.cookie,
        alice.body.user.id,
      ),
      200,
    ),
    { items, revision: 1 },
  );
  report("素材库也拒绝跨标签页串账户读写");
  assert.equal(
    expect(await request("/navigation", "GET", undefined, alice.cookie), 200)
      .revision,
    0,
  );
  const space = expect(
    await request("/workspaces", "GET", undefined, alice.cookie),
    200,
  ).workspaces[0];
  const catalog = expect(
    await request(
      `/workspaces/${space.id}/canvases`,
      "GET",
      undefined,
      alice.cookie,
    ),
    200,
  );
  assert.equal(catalog.catalogRevision, 0);
  assert.equal(catalog.canvases[0].revision, 0);
  expect(
    await request(
      `/canvases/${catalog.canvases[0].id}`,
      "DELETE",
      { catalogRevision: 0 },
      alice.cookie,
    ),
    200,
  );
  assert.equal(
    expect(
      await request(
        `/workspaces/${space.id}/canvases`,
        "GET",
        undefined,
        alice.cookie,
      ),
      200,
    ).canvases.length,
    0,
  );
  report("设置版本独立；实际 Nitro DELETE JSON body 正常且空目录不自动创建");
  report("用户配置 API 实际 HTTP 验收通过");
}
await run();
