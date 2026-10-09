ALTER TABLE workspaces ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE canvases ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
-- Keep the exact legacy created_at/id ordering when existing users upgrade.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at,id)-1 AS position
  FROM canvases
)
UPDATE canvases SET position=(SELECT position FROM ordered WHERE ordered.id=canvases.id);
CREATE INDEX canvas_position ON canvases(workspace_id,position,id);
CREATE TABLE user_navigation (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  last_canvas_id TEXT REFERENCES canvases(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE workspace_navigation (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  last_canvas_id TEXT REFERENCES canvases(id) ON DELETE SET NULL,
  PRIMARY KEY(user_id,workspace_id)
);
INSERT INTO user_navigation(user_id) SELECT id FROM users;
