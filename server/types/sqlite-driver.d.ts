declare module "#workspace-sqlite-driver" {
  import type { DatabaseSync } from "node:sqlite";
  import type { Connector } from "db0";

  export default function nodeSqlite(options: {
    path?: string;
  }): Connector<DatabaseSync>;
}
