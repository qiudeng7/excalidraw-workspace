import { resolve } from "node:path";
import nodeSqlite from "#workspace-sqlite-driver";

/** Nitro owns the connection; resolve deployment paths when the server starts. */
export default function workspaceConnector(options: { path?: string } = {}) {
  return nodeSqlite({
    ...options,
    path:
      options.path ||
      resolve(process.env.DATA_DIR || ".data", "workspace.sqlite"),
  });
}
