import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentRelease, releases } from "../../src/data/releases";
import {
  announcementKey,
  announcementPrefix,
  ReleaseProgress,
} from "../../src/lib/releaseProgress";

function storage() {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

test("release batches have unique IDs, descending safe sequences and the loaded package version", () => {
  const sequences = releases.map((release) => release.sequence);
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );

  assert.equal(currentRelease.version, pkg.version);
  assert.equal(
    new Set(releases.map((release) => release.id)).size,
    releases.length,
  );
  assert.equal(new Set(sequences).size, releases.length);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => b - a),
  );
  for (const release of releases) {
    assert.ok(Number.isSafeInteger(release.sequence) && release.sequence > 0);
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(release.title && release.summary && release.changes.length);
  }
});

test("progress advances only when shown, survives reload and isolates account keys", () => {
  const disk = storage();
  const progress = new ReleaseProgress(() => disk);

  assert.equal(progress.highest("a:b"), 0);
  assert.equal(disk.length, 0);
  progress.shown("a:b", currentRelease);
  assert.equal(
    new ReleaseProgress(() => disk).highest("a:b"),
    currentRelease.sequence,
  );
  assert.equal(progress.highest("a"), 0);
  assert.equal(
    disk.getItem(announcementKey("a:b", currentRelease.sequence)),
    currentRelease.id,
  );
});

test("rollback and concurrent late writes cannot regress another tab's newer progress", () => {
  const disk = storage();
  const oldTab = new ReleaseProgress(() => disk);
  const newTab = new ReleaseProgress(() => disk);

  assert.equal(oldTab.highest("a"), 0);
  newTab.shown("a", { sequence: 20, id: "future" });
  oldTab.shown("a", { sequence: 1, id: "old" });
  // An already-running older writer can still create its own immutable key.
  disk.setItem(announcementKey("a", 1), "old");
  assert.equal(oldTab.highest("a"), 20);
  assert.equal(new ReleaseProgress(() => disk).highest("a"), 20);
});

test("malformed and unrelated marks do not suppress announcements", () => {
  const disk = storage();
  const prefix = announcementPrefix("a");

  for (const suffix of ["", "-1", "NaN", "1.5", "02", "9007199254740992"])
    disk.setItem(`${prefix}${suffix}`, "invalid");
  disk.setItem(announcementKey("a", 999), "");
  disk.setItem(announcementKey("other", 1000), "other");
  assert.equal(new ReleaseProgress(() => disk).highest("a"), 0);
});

test("denied storage and write quota retain per-account progress in this page", () => {
  const denied = new ReleaseProgress(() => {
    throw new DOMException("blocked", "SecurityError");
  });

  denied.shown("a", currentRelease);
  assert.equal(denied.highest("a"), currentRelease.sequence);
  assert.equal(denied.highest("b"), 0);
  assert.ok(denied.storageError instanceof DOMException);
  const disk = storage();
  const quota = new ReleaseProgress(() => ({
    ...disk,
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  }));

  quota.shown("a", currentRelease);
  assert.equal(quota.highest("a"), currentRelease.sequence);
  assert.equal(disk.length, 0);
});
