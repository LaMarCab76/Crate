-- FTS5 virtual tables and sync triggers, mirroring the Swift implementation
-- (DatabaseInit.swift:65-252).

-- =============================================================================
-- tracks_fts
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    id UNINDEXED,
    title,
    artist,
    album,
    album_artist,
    genre,
    composer,
    content='tracks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS tracks_fts_insert AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts(rowid, id, title, artist, album, album_artist, genre, composer)
    VALUES (new.id, new.id, new.title, new.artist, new.album, new.album_artist, new.genre, new.composer);
END;

CREATE TRIGGER IF NOT EXISTS tracks_fts_delete AFTER DELETE ON tracks BEGIN
    DELETE FROM tracks_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS tracks_fts_update AFTER UPDATE ON tracks BEGIN
    DELETE FROM tracks_fts WHERE rowid = old.id;
    INSERT INTO tracks_fts(rowid, id, title, artist, album, album_artist, genre, composer)
    VALUES (new.id, new.id, new.title, new.artist, new.album, new.album_artist, new.genre, new.composer);
END;

-- =============================================================================
-- albums_fts
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS albums_fts USING fts5(
    id UNINDEXED,
    title,
    normalized_name,
    album_artist,
    content='albums',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS albums_fts_insert AFTER INSERT ON albums BEGIN
    INSERT INTO albums_fts(rowid, id, title, normalized_name, album_artist)
    VALUES (new.id, new.id, new.title, new.normalized_name, new.album_artist);
END;

CREATE TRIGGER IF NOT EXISTS albums_fts_delete AFTER DELETE ON albums BEGIN
    DELETE FROM albums_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS albums_fts_update AFTER UPDATE ON albums BEGIN
    DELETE FROM albums_fts WHERE rowid = old.id;
    INSERT INTO albums_fts(rowid, id, title, normalized_name, album_artist)
    VALUES (new.id, new.id, new.title, new.normalized_name, new.album_artist);
END;

-- =============================================================================
-- artists_fts
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS artists_fts USING fts5(
    id UNINDEXED,
    name,
    normalized_name,
    content='artists',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS artists_fts_insert AFTER INSERT ON artists BEGIN
    INSERT INTO artists_fts(rowid, id, name, normalized_name)
    VALUES (new.id, new.id, new.name, new.normalized_name);
END;

CREATE TRIGGER IF NOT EXISTS artists_fts_delete AFTER DELETE ON artists BEGIN
    DELETE FROM artists_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS artists_fts_update AFTER UPDATE ON artists BEGIN
    DELETE FROM artists_fts WHERE rowid = old.id;
    INSERT INTO artists_fts(rowid, id, name, normalized_name)
    VALUES (new.id, new.id, new.name, new.normalized_name);
END;

-- =============================================================================
-- genres_fts
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS genres_fts USING fts5(
    id UNINDEXED,
    name,
    normalized_name,
    content='genres',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS genres_fts_insert AFTER INSERT ON genres BEGIN
    INSERT INTO genres_fts(rowid, id, name, normalized_name)
    VALUES (new.id, new.id, new.name, new.normalized_name);
END;

CREATE TRIGGER IF NOT EXISTS genres_fts_delete AFTER DELETE ON genres BEGIN
    DELETE FROM genres_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS genres_fts_update AFTER UPDATE ON genres BEGIN
    DELETE FROM genres_fts WHERE rowid = old.id;
    INSERT INTO genres_fts(rowid, id, name, normalized_name)
    VALUES (new.id, new.id, new.name, new.normalized_name);
END;

-- =============================================================================
-- playlists_fts (description can be NULL; use COALESCE)
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS playlists_fts USING fts5(
    id UNINDEXED,
    name,
    description,
    content='playlists',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS playlists_fts_insert AFTER INSERT ON playlists BEGIN
    INSERT INTO playlists_fts(rowid, id, name, description)
    VALUES (new.id, new.id, new.name, COALESCE(new.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS playlists_fts_delete AFTER DELETE ON playlists BEGIN
    DELETE FROM playlists_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS playlists_fts_update AFTER UPDATE ON playlists BEGIN
    DELETE FROM playlists_fts WHERE rowid = old.id;
    INSERT INTO playlists_fts(rowid, id, name, description)
    VALUES (new.id, new.id, new.name, COALESCE(new.description, ''));
END;
