import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./TrackAlbumMoveService.ts', import.meta.url), 'utf8')
const cleanupMigration = readFileSync(
  new URL('../db/migrations/0023_cleanup_orphaned_entities_on_track_update.sql', import.meta.url),
  'utf8',
)
const albumRepo = readFileSync(new URL('../db/repositories/AlbumRepo.ts', import.meta.url), 'utf8')

test('apply keeps the original track row and records a per-device sync move', () => {
  assert.match(source, /applyAlbumMoveFileOperation\(/, 'apply must use the rollback-capable file operation')
  assert.match(source, /moveAndUpdateMetadata\(\{[\s\S]*?id: originalTrack\.id/, 'DB update must preserve the track id')
  assert.match(source, /albumId: targetAlbum\.id/, 'DB update must move the row to the target album')
  assert.match(source, /this\.deps\.recordMove\(moveRecord\)/, 'sync movement journal must be recorded')
  assert.match(source, /scheduleBackupForTrack\(originalTrack\.id\)/, 'changed track must be scheduled for backup')
})

test('preview moves between existing library albums and confirms with MusicBrainz without blocking on it', () => {
  assert.match(source, /lookupRecordingOnAlbum\(/, 'preview still confirms the move with MusicBrainz')
  assert.match(source, /se usan los datos de la biblioteca/, 'a missing or uncertain MusicBrainz answer must not block the move')
  assert.match(source, /suggestedTrackNumber = firstFreeAlbumSlot\(occupants, totalTracks\)/, 'preview recommends the first free slot from the library album')
  assert.match(source, /Se recomendó la pista/, 'a recommended slot is surfaced as a note')
  assert.match(source, /musicBrainzConfidence: match\?\.confidence \?\? 0/, 'confidence shows when MusicBrainz confirms, 0 otherwise')
  assert.doesNotMatch(source, /errors\.push\('MusicBrainz/, 'MusicBrainz outcomes are warnings, never blocking errors')
  assert.match(source, /findAlbumMoveDuplicate\(/, 'preview must detect occupied slot or title duplicate')
  assert.match(source, /Ya existe un archivo en destino/, 'preview must block audio destination collisions')
  assert.match(source, /Ya existe una letra \.lrc en destino/, 'preview must block lrc destination collisions')
})

test('preview compares quality and only allows replacing a lower-quality track', () => {
  assert.match(source, /compareTrackQuality\(incoming, existing\) > 0/, 'replacement is gated on the incoming file being higher quality')
  assert.match(source, /con calidad igual o superior \(\$\{describeTrackQuality\(existing\)\}\); no se reemplaza/, 'equal or worse quality blocks the move')
  assert.match(source, /Se reemplazará/, 'a better incoming file produces a replacement warning')
})

test('apply trashes the displaced track and removes its row when replacing', () => {
  assert.match(source, /if \(replacement && replacement\.incomingIsBetter\)/, 'replacement only runs when the incoming file is better')
  assert.match(source, /this\.deps\.trashItem\(replacedPath\)/, 'the replaced file is sent to the OS trash')
  assert.match(source, /this\.deps\.repos\.tracks\.deleteById\(replacedTrack\.id\)/, 'the replaced track row is removed in the move transaction')
})

test('album move cleanup removes source albums orphaned by track album_id updates', () => {
  assert.match(cleanupMigration, /cleanup_orphaned_albums_on_update/, 'migration must add album cleanup on UPDATE')
  assert.match(cleanupMigration, /AFTER UPDATE OF album_id ON tracks/, 'cleanup must run when a track moves albums')
  assert.match(cleanupMigration, /DELETE FROM albums[\s\S]*NOT EXISTS \(SELECT 1 FROM tracks WHERE album_id = OLD\.album_id\)/, 'old album must be deleted when it has no tracks')
  assert.match(cleanupMigration, /DROP TRIGGER IF EXISTS update_artist_stats_on_update/, 'artist album_count trigger must be replaced')
  assert.match(cleanupMigration, /OLD\.artist_id IS NOT NEW\.artist_id OR OLD\.album_id IS NOT NEW\.album_id/, 'artist stats must update when only album_id changes')
})

test('album repository does not return empty normalized album rows', () => {
  assert.match(albumRepo, /WHERE track_count > 0[\s\S]*ORDER BY sort_name/, 'getAll must hide empty albums')
  assert.match(albumRepo, /album_artist = \? AND track_count > 0/, 'getByArtist must hide empty albums')
})
