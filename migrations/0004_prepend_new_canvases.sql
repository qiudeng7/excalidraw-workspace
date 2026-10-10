-- New code assigns the requested position atomically. The transition trigger
-- from migration 0002 would otherwise overwrite position 0 and append it.
DROP TRIGGER IF EXISTS append_canvas_position;
