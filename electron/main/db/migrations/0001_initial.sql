-- Initial Crate schema, mirroring the GRDB schema from the legacy Swift app.
-- Squashes v1..v6 of the GRDB migrator into a single SQL file (clean slate).
-- Derived from HiFidelity by Varun Rathod (DatabaseMigrator.swift, Apache-2.0,
-- see licenses/HiFidelity-Apache-2.0.txt) and modified for Crate.

-- =============================================================================
-- 1. folders
-- =============================================================================
CREATE TABLE IF NOT EXISTS folders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL UNIQUE,
    track_count     INTEGER NOT NULL DEFAULT 0,
    date_added      TEXT NOT NULL,
    date_updated    TEXT NOT NULL,
    bookmark_data   BLOB
);

-- =============================================================================
-- 2. albums (normalized entity)
-- =============================================================================
CREATE TABLE IF NOT EXISTS albums (
    id                            INTEGER PRIMARY KEY AUTOINCREMENT,
    title                         TEXT NOT NULL,
    normalized_name               TEXT NOT NULL,
    sort_name                     TEXT NOT NULL,
    album_artist                  TEXT,
    year                          TEXT,
    release_type                  TEXT,
    record_label                  TEXT,
    disc_count                    INTEGER NOT NULL DEFAULT 1,
    musicbrainz_album_id          TEXT,
    release_date                  TEXT,
    musicbrainz_release_group_id  TEXT,
    barcode                       TEXT,
    catalog_number                TEXT,
    release_country               TEXT,
    track_count                   INTEGER NOT NULL DEFAULT 0,
    total_duration                REAL NOT NULL DEFAULT 0,
    is_compilation                INTEGER NOT NULL DEFAULT 0,
    artwork_data                  BLOB,
    date_added                    TEXT NOT NULL,
    UNIQUE (normalized_name, album_artist, year)
);

CREATE INDEX IF NOT EXISTS idx_albums_normalized   ON albums (normalized_name);
CREATE INDEX IF NOT EXISTS idx_albums_sort         ON albums (sort_name);
CREATE INDEX IF NOT EXISTS idx_albums_artist       ON albums (album_artist);
CREATE INDEX IF NOT EXISTS idx_albums_release_type ON albums (release_type);
CREATE INDEX IF NOT EXISTS idx_albums_musicbrainz  ON albums (musicbrainz_album_id);
CREATE INDEX IF NOT EXISTS idx_albums_label        ON albums (record_label);

-- =============================================================================
-- 3. artists (normalized entity)
-- =============================================================================
CREATE TABLE IF NOT EXISTS artists (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT NOT NULL,
    normalized_name        TEXT NOT NULL UNIQUE,
    sort_name              TEXT NOT NULL,
    musicbrainz_artist_id  TEXT,
    artist_type            TEXT,
    country                TEXT,
    track_count            INTEGER NOT NULL DEFAULT 0,
    album_count            INTEGER NOT NULL DEFAULT 0,
    artwork_data           BLOB,
    artwork_source_type    TEXT,
    date_added             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artists_normalized  ON artists (normalized_name);
CREATE INDEX IF NOT EXISTS idx_artists_sort        ON artists (sort_name);
CREATE INDEX IF NOT EXISTS idx_artists_musicbrainz ON artists (musicbrainz_artist_id);
CREATE INDEX IF NOT EXISTS idx_artists_type        ON artists (artist_type);

-- =============================================================================
-- 4. genres (normalized entity)
-- =============================================================================
CREATE TABLE IF NOT EXISTS genres (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    sort_name       TEXT NOT NULL,
    style           TEXT,
    track_count     INTEGER NOT NULL DEFAULT 0,
    date_added      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_genres_normalized ON genres (normalized_name);
CREATE INDEX IF NOT EXISTS idx_genres_sort       ON genres (sort_name);

-- =============================================================================
-- 5. tracks (core entity)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tracks (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,

    -- File identification
    path                        TEXT NOT NULL UNIQUE,
    filename                    TEXT NOT NULL,

    -- Core metadata
    title                       TEXT NOT NULL,
    artist                      TEXT NOT NULL,
    album                       TEXT NOT NULL,
    duration                    REAL NOT NULL CHECK (duration >= 0),

    -- File properties
    format                      TEXT NOT NULL,
    folder_id                   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    file_size                   INTEGER,
    date_modified               TEXT,

    -- Navigation fields
    album_artist                TEXT,
    composer                    TEXT NOT NULL DEFAULT '',
    genre                       TEXT NOT NULL DEFAULT '',
    year                        TEXT NOT NULL DEFAULT '',

    -- User interaction state
    is_favorite                 INTEGER NOT NULL DEFAULT 0,
    play_count                  INTEGER NOT NULL DEFAULT 0,
    last_played_date            TEXT,
    rating                      INTEGER CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),

    -- Track / Disc information
    track_number                INTEGER,
    total_tracks                INTEGER,
    disc_number                 INTEGER,
    total_discs                 INTEGER,

    -- Additional metadata
    compilation                 INTEGER NOT NULL DEFAULT 0,
    release_date                TEXT,
    original_release_date       TEXT,
    bpm                         INTEGER,
    media_type                  TEXT,

    -- Sort fields
    sort_title                  TEXT,
    sort_artist                 TEXT,
    sort_album                  TEXT,
    sort_album_artist           TEXT,

    -- Audio properties
    bitrate                     INTEGER,
    sample_rate                 INTEGER,
    channels                    INTEGER,
    codec                       TEXT,
    bit_depth                   INTEGER,

    -- Artwork
    artwork_data                BLOB,

    -- State tracking
    date_added                  TEXT NOT NULL,

    -- Duplicate tracking
    is_duplicate                INTEGER NOT NULL DEFAULT 0,
    primary_track_id            INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
    duplicate_group_id          TEXT,

    -- Extended metadata (JSON blob in TEXT)
    extended_metadata           TEXT,

    -- Foreign keys to normalized entities (SET NULL on delete to preserve track data)
    album_id                    INTEGER REFERENCES albums(id)  ON DELETE SET NULL ON UPDATE CASCADE,
    artist_id                   INTEGER REFERENCES artists(id) ON DELETE SET NULL ON UPDATE CASCADE,
    genre_id                    INTEGER REFERENCES genres(id)  ON DELETE SET NULL ON UPDATE CASCADE,

    -- v6: R128 EBU integrated loudness (dB LUFS)
    r128_integrated_loudness    REAL
);

CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks (album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks (artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_genre  ON tracks (genre_id);

-- =============================================================================
-- 6. playlists
-- =============================================================================
CREATE TABLE IF NOT EXISTS playlists (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT NOT NULL,
    description          TEXT,
    created_date         TEXT NOT NULL,
    modified_date        TEXT NOT NULL,
    track_count          INTEGER NOT NULL DEFAULT 0,
    total_duration       REAL    NOT NULL DEFAULT 0,
    custom_artwork_data  BLOB,
    color_scheme         TEXT,
    is_favorite          INTEGER NOT NULL DEFAULT 0,
    sort_order           INTEGER NOT NULL DEFAULT 0,
    is_smart             INTEGER NOT NULL DEFAULT 0,
    date_last_played     TEXT,
    play_count           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_playlists_name     ON playlists (name);
CREATE INDEX IF NOT EXISTS idx_playlists_is_smart ON playlists (is_smart);

-- =============================================================================
-- 7. playlist_tracks (junction table)
-- =============================================================================
CREATE TABLE IF NOT EXISTS playlist_tracks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id  INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE ON UPDATE CASCADE,
    track_id     INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE ON UPDATE CASCADE,
    position     INTEGER NOT NULL,
    date_added   TEXT    NOT NULL,
    UNIQUE (playlist_id, position)
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks (playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track    ON playlist_tracks (track_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_position ON playlist_tracks (playlist_id, position);

-- =============================================================================
-- 8. queue
-- =============================================================================
CREATE TABLE IF NOT EXISTS queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    position  INTEGER NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_queue_position ON queue (position);
CREATE INDEX IF NOT EXISTS idx_queue_track    ON queue (track_id);

-- =============================================================================
-- 9. lyrics
-- =============================================================================
CREATE TABLE IF NOT EXISTS lyrics (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id       INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    lrc_content    TEXT    NOT NULL,
    language       TEXT,
    source         TEXT,
    date_added     TEXT NOT NULL,
    date_modified  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lyrics_track          ON lyrics (track_id);
CREATE INDEX IF NOT EXISTS idx_lyrics_track_language ON lyrics (track_id, language);

-- =============================================================================
-- 10. song_features (ML embeddings, audio analysis)
-- =============================================================================
CREATE TABLE IF NOT EXISTS song_features (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id              INTEGER NOT NULL UNIQUE REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,

    -- Normalized features (0..1)
    tempo                 REAL,
    energy                REAL,
    valence               REAL,
    danceability          REAL,
    acousticness          REAL,
    instrumentalness      REAL,
    liveness              REAL,
    speechiness           REAL,

    loudness              REAL,
    key                   INTEGER,
    mode                  INTEGER,
    time_signature        INTEGER,
    mood                  TEXT,

    -- Spectral
    spectral_centroid     REAL,
    spectral_rolloff      REAL,
    zero_crossing_rate    REAL,

    -- Embedding
    embedding             TEXT,
    embedding_model       TEXT,
    embedding_dimension   INTEGER,

    -- Bookkeeping
    extracted_at          TEXT NOT NULL,
    extractor_version     TEXT,
    confidence            REAL,
    needs_update          INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_song_features_track        ON song_features (track_id);
CREATE INDEX        IF NOT EXISTS idx_song_features_needs_update ON song_features (needs_update);
CREATE INDEX        IF NOT EXISTS idx_song_features_energy       ON song_features (energy);
CREATE INDEX        IF NOT EXISTS idx_song_features_valence      ON song_features (valence);
CREATE INDEX        IF NOT EXISTS idx_song_features_danceability ON song_features (danceability);
CREATE INDEX        IF NOT EXISTS idx_song_features_tempo        ON song_features (tempo);
CREATE INDEX        IF NOT EXISTS idx_song_features_mood         ON song_features (mood);
