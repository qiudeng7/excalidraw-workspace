import { parseAuthConfig } from "#server/utils/auth-config";

// Node fails at startup; Workers have no env until a request, so they validate there.
export default defineNitroPlugin(() => {
  if (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  )
    return;
  parseAuthConfig(process.env);
});
