import { db } from "@nuxthub/db";
import { sql } from "drizzle-orm";
import { collaborationRooms } from "#server/db/schema";
import { nodeCommand } from "#server/collaboration/node";
import {
  projectionStatements,
  type DirectoryProjection,
  type Statement,
} from "#server/collaboration/directory";

export async function projectNodeRoom(id: string) {
  const projection = (await nodeCommand(
    id,
    { name: "" },
    { type: "projection" },
  )) as DirectoryProjection;

  if (!projection.pending) return;
  const client = db.$client as unknown as {
    batch(statements: Statement[], mode: "write"): Promise<unknown>;
  };

  await client.batch(projectionStatements(id, projection), "write");
  await nodeCommand(
    id,
    { name: "" },
    { type: "projectionAck", revision: projection.revision },
  );
}

export async function repairNodeProjections() {
  const pending = await db
    .select({ id: collaborationRooms.id })
    .from(collaborationRooms)
    .where(
      sql`json_extract(${collaborationRooms.state}, '$.directoryPending') = 1`,
    )
    .limit(100);

  for (const room of pending) await projectNodeRoom(room.id);
}
