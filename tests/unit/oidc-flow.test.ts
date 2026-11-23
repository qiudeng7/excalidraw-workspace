import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCookie, loginRedirect } from "../../server/utils/oidc-flow";

test("flow cookie is scoped to the public callback directory, prefix included", () => {
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
});

test("login redirect keeps the configured path and query", () => {
  assert.equal(
    loginRedirect("oidc_state").headers.get("Location"),
    "/?authError=oidc_state",
  );
  assert.equal(
    loginRedirect("oidc_denied", {}, "/apps/canvas?tab=1").headers.get(
      "Location",
    ),
    "/apps/canvas?tab=1&authError=oidc_denied",
  );
});
