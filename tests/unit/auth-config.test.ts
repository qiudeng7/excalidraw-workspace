// 本文件校验账号方式配置的纯函数：只剩 AUTH_LOCAL 开关，旧 OIDC_* 变量不再参与。
// 不覆盖数据库中的身份源，那部分由 oidc-auth 与 oidc-providers 集成测试负责。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthConfigError,
  parseAuthConfig,
} from "../../server/utils/auth-config";

test("默认开启本地账号，空值沿用默认", () => {
  assert.deepEqual(parseAuthConfig({}), { local: true });
  assert.deepEqual(parseAuthConfig({ AUTH_LOCAL: "" }), { local: true });
});

test("AUTH_LOCAL 只接受 true/false/1/0", () => {
  for (const [value, expected] of [
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ] as const)
    assert.deepEqual(parseAuthConfig({ AUTH_LOCAL: value }), {
      local: expected,
    });

  assert.throws(() => parseAuthConfig({ AUTH_LOCAL: "nope" }), AuthConfigError);
});

test("关闭本地账号本身仍然是有效配置，OIDC 身份源由数据库决定", () => {
  assert.deepEqual(parseAuthConfig({ AUTH_LOCAL: "false" }), { local: false });
});

test("旧 OIDC 环境变量不再影响配置", () => {
  assert.deepEqual(
    parseAuthConfig({
      AUTH_OIDC: "true",
      OIDC_ISSUER: "https://idp.test",
      OIDC_CLIENT_ID: "client",
      OIDC_CLIENT_SECRET: "secret",
    }),
    { local: true },
  );
});
