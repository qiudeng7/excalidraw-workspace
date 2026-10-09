CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  updated_at TEXT NOT NULL
);
-- Also upgrade installations that already applied an earlier copy of migration 0002.
CREATE TRIGGER IF NOT EXISTS initialize_user_navigation AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO user_navigation(user_id) VALUES(NEW.id);
END;

-- Append canvases created by the old Worker during the deployment transition.
CREATE TRIGGER IF NOT EXISTS append_canvas_position AFTER INSERT ON canvases
BEGIN
  UPDATE canvases SET position=COALESCE((SELECT MAX(position)+1 FROM canvases WHERE workspace_id=NEW.workspace_id AND id<>NEW.id),0) WHERE id=NEW.id;
END;
