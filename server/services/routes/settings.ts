import { createDefaultUserSettings } from "../../../shared/contracts";
import type { RepositoryPort } from "../../storage/repository";
import type { Authentication } from "../auth";
import { fail, json, body, validRevision, assertOwner } from "../http";
import { validateUserSettings } from "../userSettings";
import type { RouteHandler } from "../routing";
export interface SettingsRoutesDependencies {
  request: Request;
  repository: Pick<
    RepositoryPort,
    "userSettings" | "saveUserSettings" | "setRegistration" | "registration"
  >;
  authentication: Authentication;
}
export function createSettingsRoutes({
  request,
  repository,
  authentication,
}: SettingsRoutesDependencies): RouteHandler {
  return {
    async handle() {
      const req = request;
      const path = new URL(req.url).pathname;
      const method = req.method;
      const user = await authentication.requireUser();
      if (path === "/api/user-settings") {
        assertOwner(req, user.id, "x-settings-owner");
        if (method === "GET") {
          const row = await repository.userSettings(user.id);
          if (!row)
            return json({
              settings: createDefaultUserSettings(),
              revision: 0,
              configured: false,
            });
          const settings: unknown = JSON.parse(row.settingsJson);
          if (!validateUserSettings(settings))
            throw new Error("Invalid stored user settings");
          return json({ settings, revision: row.revision, configured: true });
        }
        if (method === "PUT") {
          const data = await body(req);
          const revision = validRevision(data.revision);
          if (!validateUserSettings(data.settings))
            return fail(
              400,
              "INVALID_USER_SETTINGS",
              "设置格式无效，请使用完整的受支持配置",
            );
          const updatedRevision = await repository.saveUserSettings(
            user.id,
            JSON.stringify(data.settings),
            revision,
            new Date().toISOString(),
          );
          if (updatedRevision === undefined)
            return fail(
              409,
              "USER_SETTINGS_CONFLICT",
              "设置已在其他页面更新，请选择使用云端设置或重新提交当前设置",
            );
          return json({
            settings: data.settings,
            revision: updatedRevision,
            configured: true,
          });
        }
        return fail(405, "METHOD_NOT_ALLOWED", "请求方法不支持");
      }
      if (path === "/api/admin/settings") {
        if (user.role !== "admin")
          return fail(403, "FORBIDDEN", "仅管理员可以修改注册设置");
        if (method === "PATCH") {
          const data = await body(req);
          if (typeof data.registrationEnabled !== "boolean")
            return fail(400, "INVALID_SETTINGS", "注册设置必须是布尔值");
          await repository.setRegistration(data.registrationEnabled);
        } else if (method !== "GET")
          return fail(405, "METHOD_NOT_ALLOWED", "请求方法不支持");
        const settings = await repository.registration();
        return json({ registrationEnabled: !!settings?.registration_enabled });
      }

      return undefined;
    },
  };
}
