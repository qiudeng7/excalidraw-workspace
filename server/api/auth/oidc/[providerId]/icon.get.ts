import { oidcProvider } from "#server/db/oidc-providers";
import { defineApiHandler } from "#server/utils/api";
import { fail } from "#server/utils/http";
import { oidcProviderId, readProviderIcon } from "#server/utils/oidc-providers";

/** 登录页图标：公开读取，预设类型不使用该地址。 */
export default defineApiHandler(
  async (event) => {
    const provider = await oidcProvider(oidcProviderId(event));
    const icon = provider?.icon ? await readProviderIcon(provider.icon) : null;

    if (!icon) return fail(404, "NOT_FOUND", "图标不存在");

    return new Response(icon.object, {
      headers: {
        "Content-Type": icon.contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // 上传的 SVG 直接访问时也不能执行脚本。
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  },
  { public: true },
);
