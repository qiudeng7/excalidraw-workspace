export interface DirectoryProjection {
  revision: number;
  userIds: string[];
  pending: boolean;
  name: string;
  epoch: string;
}

export interface Statement {
  sql: string;
  args: (string | number)[];
}

/** A newer projection wins even if two async drainers finish in reverse order. */
export function projectionStatements(
  canvasId: string,
  projection: DirectoryProjection,
): Statement[] {
  const { revision, userIds } = projection;

  return [
    {
      sql: "INSERT OR IGNORE INTO collaboration_directory (canvas_id, revision) VALUES (?, -1)",
      args: [canvasId],
    },
    {
      sql: "UPDATE collaboration_directory SET revision = ? WHERE canvas_id = ? AND revision < ?",
      args: [revision, canvasId, revision],
    },
    {
      sql: "UPDATE canvases SET name = ?, room_epoch = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND EXISTS (SELECT 1 FROM collaboration_directory WHERE canvas_id = ? AND revision = ?)",
      args: [projection.name, projection.epoch, canvasId, canvasId, revision],
    },
    {
      sql: "DELETE FROM shared_canvases WHERE canvas_id = ? AND EXISTS (SELECT 1 FROM collaboration_directory WHERE canvas_id = ? AND revision = ?)",
      args: [canvasId, canvasId, revision],
    },
    {
      sql: "INSERT OR IGNORE INTO shared_canvases (canvas_id, user_id) SELECT ?, value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM collaboration_directory WHERE canvas_id = ? AND revision = ?)",
      args: [canvasId, JSON.stringify(userIds), canvasId, revision],
    },
  ];
}
