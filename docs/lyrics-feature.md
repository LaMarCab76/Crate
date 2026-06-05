# Lyrics feature — reference for future re-implementation

> This is a frozen record of how time-synced lyrics worked in the legacy Swift app
> (`old_swift/`, since deleted). The feature was **not** ported to the Electron app yet.
> Use this as the spec to rebuild it in Electron/TypeScript.
>
> Current Electron policy: lyrics are written as mandatory `.lrc` sidecars next to
> the audio file for local library/playback use. Device Sync does not copy/import
> `.lrc` sidecars or read embedded lyrics for propagation. The app may read
> embedded lyrics for compatibility, but does not expose writing lyrics into
> audio files.

## Overview

Time-synced (karaoke-style) lyrics. A track's lyrics are fetched from the public
**lrclib.net** API (or imported from a local `.lrc` file), stored in the database as raw
LRC text, parsed into timestamped lines, and highlighted/auto-scrolled in sync with the
playhead.

## Provider: lrclib.net

- Base URL: `https://lrclib.net/api` — no auth, no API key. Docs: https://lrclib.net/docs
- Send a descriptive `User-Agent` header (lrclib asks for one identifying the app —
  when reimplementing, use something like `Crate/<version> (<repo url>)`).
- HTTP timeouts used in the old client: 30s request / 60s resource.

### Endpoints

`GET /api/search` — returns an **array** of candidates.
Query params:
- `track_name` (required)
- `artist_name` (required)
- `album_name` (optional)
- `duration` (optional, **seconds**, integer; omit when 0 — helps narrow the match)

`GET /api/get` — returns a **single** best match (same query params as search).

`GET /api/get/{id}` — fetch a specific record by lrclib id.

### Response shape (`LyricsSearchResult`)

```jsonc
{
  "id": 123,
  "trackName": "…",
  "artistName": "…",
  "albumName": "…",      // nullable
  "duration": 215.0,      // seconds (float)
  "instrumental": false,
  "plainLyrics": "…",    // nullable, unsynced text
  "syncedLyrics": "…"    // nullable, LRC with timestamps
}
```

Status handling: `200` → decode; `404` → no lyrics (return empty array / null);
`429` → rate limited (surface a "try again later" message; the old app did **not**
auto-retry/backoff — user re-triggers manually); other → server error.

Content selection: prefer `syncedLyrics`; if absent, fall back to `plainLyrics`
(rendered as plain text, no per-line highlight). `instrumental: true` ⇒ show an
"instrumental / no lyrics" state.

## LRC format & parser

LRC lines look like `[mm:ss.xx]text`. Parser details:
- Line regex: `\[(\d+):(\d+)\.(\d+)\](.+)` → minutes, seconds, centiseconds, text.
  `timestamp = minutes*60 + seconds + centiseconds/100` (seconds, float).
- Metadata tags (one per line): `[ti:title]`, `[ar:artist]`, `[al:album]`,
  `[by:lrc-author]`, `[offset:milliseconds]`. `offset` is converted to seconds and is
  a **global time shift** applied when computing the current line (compensates sync drift).
- Empty lines ignored; parsed lines **sorted by timestamp**.
- Round-trip: can re-serialize back to LRC (metadata header block, then `[mm:ss.xx]text`
  per line) for export.

### Current-line lookup (the core sync primitive)

```
adjustedTime = playheadSeconds - (metadata.offset ?? 0)
currentLineIndex = the line i where  line[i].timestamp <= adjustedTime < line[i+1].timestamp
                   (last line matches when its timestamp <= adjustedTime)
```

Recompute on every playhead tick (old app: ~50ms cadence) while the window is focused.
Lines are pre-parsed and cached in memory — do not re-parse per frame.

## Persistence (DB)

Single table `lyrics`, one (or more) rows per track. SQL (SQLite):

```sql
CREATE TABLE lyrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id      INTEGER NOT NULL UNIQUE
                  REFERENCES tracks(id) ON DELETE CASCADE ON UPDATE CASCADE,
  lrc_content   TEXT NOT NULL,        -- full LRC file as text
  language      TEXT,                  -- ISO 639-1 ("en","es","ja"…)
  source        TEXT,                  -- "user" | "api" | "embedded" | "file"
  date_added    DATETIME NOT NULL,
  date_modified DATETIME NOT NULL
);
CREATE INDEX idx_lyrics_track          ON lyrics(track_id);
CREATE INDEX idx_lyrics_track_language ON lyrics(track_id, language);
```

> Note: the legacy code modeled this as one-to-many (Track hasMany lyrics, e.g. multiple
> languages) but the table had `track_id UNIQUE`, so in practice one active row per track.
> Decide intentionally when reimplementing: keep UNIQUE for one-per-track, or drop it to
> support multiple languages and select by `language`.

CRUD covered: insert (from object / params / `.lrc` file), get by id / by track_id /
by (track_id, language) / all-for-track, `hasLyrics(trackId)`, list tracks-with-lyrics,
update content/language, delete (by id / all-for-track / by language), export to `.lrc`,
plus stats (counts by source and by language). `lrc_content` is stored verbatim and
parsed on demand.

> Embedded tags: the metadata extractor also read ID3 `USLT` (unsynced lyrics) and
> `lyricist`/`TEXT` into the track's extended metadata, but that was **separate** from this
> feature and not used for the synced display. A future port could auto-seed `lyrics` from
> embedded `USLT` with `source = "embedded"`.

## UX

Two surfaces: a full **Lyrics panel** (right sidebar) and a compact **mini-player** view.
Both subscribe to the same playback controller and run identical sync logic; the mini view
just has smaller fonts and no actions.

Panel behavior:
- On track change: load `lyrics` row for the new track → parse → reset current line.
- On playhead change (while focused): recompute current line; the current line is
  emphasized (bold/primary color, highlighted background), past lines dimmed, future lines
  faint; auto-scroll the current line into view with a smooth animation.
- Empty state when no row: offer **Search online** and **Import LRC**.

Actions:
- **Search online** → `searchLyrics(title, artist, album, durationSeconds)`. If exactly one
  result *with synced lyrics* → auto-import it. If multiple → show a chooser (each row:
  track/artist/album, duration, "Synced"/"Plain" badge, instrumental flag); picking one
  imports it (`source = "api"`). If none → error/empty message.
- **Import `.lrc` file** (file picker) and **drag & drop** a `.lrc` onto the panel →
  read UTF-8 → save (`source = "user"`); upsert if a row already exists.
- **Export `.lrc`** → serialize current lyrics; default filename `"<title> - <artist>.lrc"`.
- **Remove** → delete all lyrics rows for the track; show empty state.

## End-to-end flow

```
play track
  → load lyrics row by track_id (DB)
  → parse lrc_content → sorted timestamped lines (+ optional offset)
  → on each playhead tick: currentLineIndex(adjustedTime) → highlight + autoscroll
```

## Porting notes / gaps in the old implementation

- No multi-timestamp lines (`[t1][t2]text`), no LRC+ / enhanced word-level timing.
- No manual per-track sync-offset UI (the `[offset:…]` tag is honored, but not editable).
- No background auto-fetch on import, no search-result caching, no lyrics editor,
  no translation.
- When reimplementing in Electron: do the lrclib HTTP calls in the **main** process
  (avoids CSP/CORS in the renderer), persist via the existing better-sqlite3 DB with a new
  migration for the `lyrics` table, and drive highlight/scroll from the renderer's existing
  playback time state.
