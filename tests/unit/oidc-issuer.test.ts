// 本文件只校验 id_token issuer 判定的纯函数：不联网、不验签。
// 微软多租户按 id_token 的 tid 展开期望 iss，其它类型严格比对配置值。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoveryIssuer,
  expectedIssuer,
  isMultiTenantProvider,
  type OidcProvider,
} from "../../server/utils/oidc";

const common: OidcProvider = {
  type: "microsoft",
  issuer: "https://login.microsoftonline.com/common/v2.0",
  clientId: "client",
  clientSecret: "secret",
  scopes: "openid profile email",
};

test("微软 common、organizations、consumers 与 {tenantid} 都按 tid 展开", () => {
  for (const segment of ["common", "organizations", "consumers"]) {
    const provider = {
      ...common,
      issuer: `https://login.microsoftonline.com/${segment}/v2.0`,
    };

    assert.equal(isMultiTenantProvider(provider), true);
    assert.equal(
      expectedIssuer(provider, { tid: "8eaef023-2b34-4be6-b8ac-7e1e7f6b9d21" }),
      "https://login.microsoftonline.com/8eaef023-2b34-4be6-b8ac-7e1e7f6b9d21/v2.0",
    );
  }

  const template = {
    ...common,
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
  };

  assert.equal(isMultiTenantProvider(template), true);
  assert.equal(
    discoveryIssuer(template),
    "https://login.microsoftonline.com/common/v2.0",
  );
});

test("微软多租户缺少或非法 tid 时没有期望 issuer", () => {
  assert.equal(expectedIssuer(common, {}), null);
  assert.equal(expectedIssuer(common, { tid: "" }), null);
  assert.equal(expectedIssuer(common, { tid: "tenant/other" }), null);
  assert.equal(expectedIssuer(common, { tid: 42 }), null);
});

test("微软具体租户 issuer 严格比对配置值", () => {
  const provider = {
    ...common,
    issuer:
      "https://login.microsoftonline.com/8eaef023-2b34-4be6-b8ac-7e1e7f6b9d21/v2.0",
  };

  assert.equal(isMultiTenantProvider(provider), false);
  assert.equal(discoveryIssuer(provider), provider.issuer);
  assert.equal(
    expectedIssuer(provider, { tid: "another-tenant" }),
    provider.issuer,
  );
});

test("其它类型严格使用配置的 issuer", () => {
  for (const [type, issuer] of [
    ["google", "https://accounts.google.com"],
    ["gitlab", "https://gitlab.example.com"],
    ["custom", "https://idp.example.com"],
  ] as const) {
    const provider: OidcProvider = {
      type,
      issuer,
      clientId: "client",
      clientSecret: "secret",
      scopes: "openid profile email",
    };

    assert.equal(isMultiTenantProvider(provider), false);
    assert.equal(discoveryIssuer(provider), issuer);
    assert.equal(expectedIssuer(provider, { tid: "ignored" }), issuer);
  }
});
