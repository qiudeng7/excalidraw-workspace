import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { parseDevelopmentAccounts } from "../../shared/development.ts";

export async function developmentAccounts(path, environment = process.env) {
  let file = {};

  try {
    file = parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const values = { ...file, ...environment };

  return parseDevelopmentAccounts(
    JSON.stringify([
      {
        role: "admin",
        email: (values.DEV_ADMIN_EMAIL ?? "admin@local.test")
          .trim()
          .toLowerCase(),
        password: values.DEV_ADMIN_PASSWORD ?? "Admin-development-2026!",
        name: "开发管理员",
      },
      {
        role: "user",
        email: (values.DEV_USER_EMAIL ?? "user@local.test")
          .trim()
          .toLowerCase(),
        password: values.DEV_USER_PASSWORD ?? "User-development-2026!",
        name: "开发用户",
      },
    ]),
  );
}
