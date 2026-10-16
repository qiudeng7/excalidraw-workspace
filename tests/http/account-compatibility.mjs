// Real HTTP regression for password/session SQL and legacy settings CAS.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localClient, expect, report } from "./support/local-client.mjs";

const request = localClient(process.argv[2] ?? "http://localhost:3000");
const bootstrap = expect(await request("/bootstrap"), 200);

assert.ok(
  bootstrap.needsSetup || bootstrap.registrationEnabled,
  "测试服务需允许新测试账户注册；不会修改注册开关",
);
const password = `Original-${randomUUID()}!`;
const next = `Updated-${randomUUID()}!`;
const email = `compatibility-${randomUUID()}@example.test`;
const account = await request(
  bootstrap.needsSetup ? "/setup" : "/register",
  "POST",
  { email, password },
);

expect(account, 200);
assert.ok(account.cookie);
const uid = account.body.user.id;
const second = await request("/login", "POST", { email, password });

expect(second, 200);
assert.ok(second.cookie);
assert.notEqual(second.cookie, account.cookie);
expect(
  await request(
    "/account/password",
    "PUT",
    { currentPassword: password, newPassword: next },
    account.cookie,
  ),
  200,
);
assert.equal(
  expect(await request("/session", "GET", undefined, account.cookie), 200).user
    .id,
  uid,
);
assert.equal(
  expect(await request("/session", "GET", undefined, second.cookie), 200).user,
  null,
);
expect(await request("/login", "POST", { email, password }), 401);
const renewed = await request("/login", "POST", { email, password: next });

expect(renewed, 200);
assert.ok(renewed.cookie);
report("实际改密保留当前会话、撤销其他会话；旧密码拒绝、新密码可登录");
const read = () =>
  request("/user-settings", "GET", undefined, renewed.cookie, uid, true);
const save = (settings, revision) =>
  request(
    "/user-settings",
    "PUT",
    { settings, revision },
    renewed.cookie,
    uid,
    true,
  );
const defaults = expect(await read(), 200).settings;
const modern = structuredClone(defaults);

modern.features.disableDefaultSidebar = false;
modern.features.bottomToolbar = false;
modern.features.ctrlMultiSelect = false;
modern.features.arrowSelectionHighlight = false;
expect(await save(modern, 0), 200);
const legacy = structuredClone(defaults);

delete legacy.features.disableDefaultSidebar;
delete legacy.features.bottomToolbar;
delete legacy.features.ctrlMultiSelect;
delete legacy.features.arrowSelectionHighlight;
legacy.features.nunitoFont = false;
let saved = expect(await save(legacy, 1), 200);

assert.equal(saved.revision, 2);
assert.equal(saved.settings.features.disableDefaultSidebar, false);
assert.equal(saved.settings.features.bottomToolbar, false);
assert.equal(saved.settings.features.ctrlMultiSelect, false);
assert.equal(saved.settings.features.arrowSelectionHighlight, false);
assert.equal(saved.settings.features.nunitoFont, false);
assert.deepEqual(expect(await read(), 200), saved);
const intermediate = structuredClone(legacy);

intermediate.features.disableDefaultSidebar = true;
saved = expect(await save(intermediate, 2), 200);
assert.equal(saved.revision, 3);
assert.equal(saved.settings.features.disableDefaultSidebar, true);
assert.equal(saved.settings.features.bottomToolbar, false);
assert.equal(saved.settings.features.ctrlMultiSelect, false);
assert.equal(saved.settings.features.arrowSelectionHighlight, false);
expect(await save(legacy, 1), 409);
assert.deepEqual(expect(await read(), 200), saved);
report(
  "原版/中间版 v1 缺省 flag 保留 false，显式设置生效；过期版本 CAS 拒绝且不覆盖",
);
const registered = await request("/register", "POST", {
  email: `compatibility-${randomUUID()}@example.test`,
  password,
});

expect(registered, 200);
assert.ok(registered.cookie);
const first = expect(
  await request(
    "/user-settings",
    "PUT",
    { settings: legacy, revision: 0 },
    registered.cookie,
    registered.body.user.id,
    true,
  ),
  200,
);

assert.equal(first.settings.features.disableDefaultSidebar, true);
assert.equal(first.settings.features.bottomToolbar, true);
assert.equal(first.settings.features.ctrlMultiSelect, true);
assert.equal(first.settings.features.arrowSelectionHighlight, true);
report("新注册账户的原版 v1 首次保存补齐两个默认 flag");
