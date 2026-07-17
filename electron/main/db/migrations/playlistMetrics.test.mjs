import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const migration = readFileSync(new URL('./0025_playlist_metrics.sql', import.meta.url), 'utf8')

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tracks (id INTEGER PRIMARY KEY, duration REAL NOT NULL);
    CREATE TABLE playlists (
      id INTEGER PRIMARY KEY,
      modified_date TEXT NOT NULL,
      track_count INTEGER NOT NULL DEFAULT 0,
      total_duration REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE playlist_tracks (
      id INTEGER PRIMARY KEY,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      date_added TEXT NOT NULL
    );
    INSERT INTO tracks VALUES (1, 60.5), (2, 120), (3, 30);
    INSERT INTO playlists VALUES (10, 'old', 99, 999), (11, 'old', 0, 0);
    INSERT INTO playlist_tracks VALUES (1, 10, 1, 0, 'old'), (2, 10, 2, 1, 'old');
  `)
  db.exec(migration)
  return db
}

function metrics(db, id) {
  return db.prepare('SELECT track_count, total_duration, modified_date FROM playlists WHERE id = ?').get(id)
}

test('playlist metrics migration repairs existing denormalized values', () => {
  const db = fixture()
  assert.deepEqual({ ...metrics(db, 10) }, { track_count: 2, total_duration: 180.5, modified_date: 'old' })
  assert.deepEqual({ ...metrics(db, 11) }, { track_count: 0, total_duration: 0, modified_date: 'old' })
})

test('playlist metrics follow inserts, deletes, moves, cascades and duration edits', () => {
  const db = fixture()
  db.prepare(`INSERT INTO playlist_tracks VALUES (3, 10, 3, 2, 'now')`).run()
  assert.equal(metrics(db, 10).track_count, 3)
  assert.equal(metrics(db, 10).total_duration, 210.5)
  assert.notEqual(metrics(db, 10).modified_date, 'old')

  db.prepare('UPDATE playlist_tracks SET playlist_id = 11 WHERE id = 3').run()
  assert.equal(metrics(db, 10).track_count, 2)
  assert.equal(metrics(db, 11).track_count, 1)
  assert.equal(metrics(db, 11).total_duration, 30)

  db.prepare('UPDATE tracks SET duration = 45 WHERE id = 3').run()
  assert.equal(metrics(db, 11).total_duration, 45)

  db.prepare(`UPDATE playlists SET modified_date = 'before-reorder' WHERE id = 10`).run()
  db.prepare('UPDATE playlist_tracks SET position = 5 WHERE id = 1').run()
  assert.notEqual(metrics(db, 10).modified_date, 'before-reorder')

  db.prepare('DELETE FROM tracks WHERE id = 1').run()
  assert.equal(metrics(db, 10).track_count, 1)
  assert.equal(metrics(db, 10).total_duration, 120)
})
