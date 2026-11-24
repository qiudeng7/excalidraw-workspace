// 本文件校验 OIDC 流程 Cookie、流程值解析与登录重定向的纯函数边界；
// 不发起真实 IdP 请求，回调与验签由 oidc-auth 集成测试覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flowCookie,
  flowValue,
  loginRedirect,
  parseFlow,
} from "../../server/utils/oidc-flow";

test("流程 Cookie 作用域为公开回调目录，代理前缀下仍能带回", () => {
  assert.match(
    flowCookie(
      "https://a.test",
      "v",
      600,
      "https://a.test/api/auth/oidc/callback",
    ),
    /; Path=\/api\/auth\/oidc;/,
  );
  assert.match(
    flowCookie(
      "https://a.test",
      "v",
      600,
      "https://a.test/apps/excalidraw/api/auth/oidc/callback",
    ),
    /; Path=\/apps\/excalidraw\/api\/auth\/oidc;.*; Secure$/,
  );
  assert.match(
    flowCookie(
      "https://a.test",
      "v",
      600,
      "https://a.test/api/auth/oidc/6f1e1d2c-0000-4000-8000-000000000001/callback",
    ),
    /; Path=\/api\/auth\/oidc\/6f1e1d2c-0000-4000-8000-000000000001;/,
  );
});

test("流程值按 providerId、state、verifier、nonce 往返", () => {
  const flow = {
    providerId: "6f1e1d2c-0000-4000-8000-000000000001",
    state: "state",
    verifier: "verifier",
    nonce: "nonce",
  };

  assert.deepEqual(parseFlow(flowValue(flow)), flow);
  assert.equal(parseFlow(""), null);
  assert.equal(parseFlow("provider.state"), null);
  assert.equal(parseFlow("provider.state.verifier"), null);
});

test("登录成功与失败都回到站点根路径，失败只带错误码", () => {
  assert.equal(loginRedirect().headers.get("Location"), "/");
  assert.equal(
    loginRedirect("oidc_state").headers.get("Location"),
    "/?authError=oidc_state",
  );
  assert.equal(loginRedirect("oidc_denied").status, 302);
  assert.equal(loginRedirect().headers.get("Cache-Control"), "no-store");
});
