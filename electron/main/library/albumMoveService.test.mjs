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
  assert.match(source, /const albumId = targetAlbum\?\.id \?\? this\.createAlbumForMovedTrack\(md\)/, 'DB update must move the row to the target (or newly created) album')
  assert.match(source, /moveAndUpdateMetadata\(\{[\s\S]*?albumId,[\s\S]*?\}\)/, 'the moved row points at the resolved album')
  assert.match(source, /this\.deps\.recordMove\(moveRecord\)/, 'sync movement journal must be recorded')
  assert.match(source, /scheduleBackupForTrack\(originalTrack\.id\)/, 'changed track must be scheduled for backup')
})

test('preview moves between existing library albums and confirms with MusicBrainz without blocking on it', () => {
  assert.match(source, /lookupRecordingOnAlbum\(/, 'preview still confirms the move with MusicBrainz')
  assert.match(source, /se usan los datos de la biblioteca/, 'a missing or uncertain MusicBrainz answer must not block the move')
  assert.match(source, /suggestedTrackNumber = firstFreeAlbumSlot\(occupants, totalTracks\)/, 'preview recommends the first free slot from the library album')
  assert.match(source, /Se recomendó la primera pista libre/, 'a recommended free slot is surfaced as a note')
  assert.match(source, /musicBrainzConfidence: match\?\.confidence \?\? 0/, 'confidence shows when MusicBrainz confirms, 0 otherwise')
  assert.doesNotMatch(source, /errors\.push\('MusicBrainz/, 'MusicBrainz outcomes are warnings, never blocking errors')
  assert.match(source, /findAlbumMoveDuplicate\(/, 'preview must detect occupied slot or title duplicate')
  assert.match(source, /Ya existe un archivo en destino/, 'preview must block audio destination collisions')
  assert.match(source, /Ya existe una letra \.lrc en destino/, 'preview must block lrc destination collisions')
})

test('preview pinpoints the track via the official tracklist before appending at the end', () => {
  assert.match(source, /lookupAlbumTracklist\(/, 'preview fetches the destination album official tracklist')
  assert.match(source, /findTracklistSlot\(/, 'preview locates the incoming track within the official tracklist')
  assert.match(source, /placementSource = 'tracklist'/, 'a tracklist match is recorded as the placement source')
  assert.match(source, /placementSource = 'append'/, 'appending at the end is an explicit, flagged last resort')
  assert.match(source, /No se encontró esta pista en el álbum; se agregará al final/, 'append is surfaced as a clear warning')
  assert.match(source, /No se pudo obtener la lista oficial del álbum/, 'a tracklist fetch failure degrades to library data, never blocks')
})

test('preview auto-replaces only on better quality, and offers a confirm for equal/lower', () => {
  assert.match(source, /compareTrackQuality\(incoming, existing\) > 0/, 'replacement is gated on the incoming file being higher quality')
  assert.match(source, /Podés borrarlo y mover igual/, 'equal or worse quality is a warning offering an explicit confirm, not a hard block')
  assert.doesNotMatch(source, /errors\.push\([^)]*no se reemplaza/, 'equal/lower quality must not push a blocking error in buildPreview')
  assert.match(source, /Se reemplazará/, 'a better incoming file produces a replacement warning')
})

test('apply stages the displaced track reversibly and retires it only after commit', () => {
  assert.match(source, /async apply\(previewId: string, confirmLowerQualityReplace = false\)/, 'apply accepts the explicit lower-quality confirmation')
  assert.match(source, /if \(replacement && \(replacement\.incomingIsBetter \|\| confirmLowerQualityReplace\)\)/, 'replacement runs on better quality or confirmed deletion')
  assert.match(source, /preview\.replacement\.incomingIsBetter \|\| confirmLowerQualityReplace/, 'validateStoredPreview honours the confirmation')
  assert.match(source, /stageAlbumMoveReplacement\(replacedPath\)/, 'the replaced file is staged before the move')
  assert.match(source, /replacementStage\.rollback\(\)/, 'a failed move restores the displaced file')
  assert.match(source, /replacementStage\.retire\(path => this\.deps\.trashItem\(path\)\)/, 'staged files reach trash only after commit')
  assert.match(source, /this\.deps\.repos\.tracks\.deleteById\(replacedTrack\.id\)/, 'the replaced track row is removed in the move transaction')
})

test('apply revalidates replacement filesystem authority immediately before staging', () => {
  assert.match(
    source,
    /const replacedPath = requireLocalLibraryTrackPath\(\{[\s\S]*?track: replacedTrack,[\s\S]*?expectedPath: replacement\.path,[\s\S]*?\}\)[\s\S]*?stageAlbumMoveReplacement\(replacedPath\)/,
    'replacement must still be local, unchanged, and in a normal library before filesystem staging',
  )
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

test('preview can target an album that is not in the library yet', () => {
  assert.match(source, /async preview\(trackId: number, target: TrackAlbumMoveTarget, trackNumberOverride: number \| null = null\)/)
  assert.match(source, /target\.kind === 'library'[\s\S]*?this\.buildPreview\([\s\S]*?this\.buildNewAlbumPreview\(track, target, trackNumberOverride\)/)
  assert.match(source, /this\.loadRelease\(target\.releaseId\)/, 'a MusicBrainz target is built from the full release')
  assert.match(source, /lookupReleaseDetail\(releaseId\)/)
  assert.match(source, /this\.releases\.set\(releaseId, loaded\)/, 'release + cover are cached so slot changes stay fast')
  assert.match(source, /normalizeManualAlbum\(target\.album\)/, 'a manual target is validated')
  assert.match(source, /chooseNewAlbumDirectory\(\{[\s\S]*?rootPath: sourceFolder\.path/, 'the new album stays in the track library root')
  assert.match(source, /planNewAlbumDestination\(/)
})

test('a new-album target that already exists locally becomes a plain library move', () => {
  assert.match(
    source,
    /const existing = matchLocalAlbumForRelease\([\s\S]*?if \(existing\) \{[\s\S]*?this\.buildPreview\(track, existing, trackNumberOverride\)/,
  )
  assert.match(source, /private assertNewAlbumStillMissing/, 'apply re-checks the library before creating the album')
  assert.match(source, /if \(stored\.target\.kind === 'new'\) this\.assertNewAlbumStillMissing\(stored\.target\)/)
})

test('new album previews keep the same safety checks and never block on cover art', () => {
  const body = source.slice(source.indexOf('private async buildNewAlbumPreview'), source.indexOf('private artistAlbumDirectories'))
  assert.match(body, /Ya existe un archivo en destino/)
  assert.match(body, /Ya existe una letra \.lrc en destino/)
  assert.match(body, /La ruta destino queda fuera de la biblioteca del álbum/)
  assert.match(source, /fetchCoverArt\(detail\.releaseId, detail\.releaseGroupId\)/)
  assert.match(body, /se mantiene la carátula actual/, 'missing cover art is a warning, not an error')
  assert.doesNotMatch(body, /errors\.push\([^)]*Cover Art/)
  assert.match(body, /tracklist\.find\(entry => entry\.recordingId === target\.recordingId\)/, 'the exact recording locates the slot first')
})

test('apply writes release tags so nothing from the compilation survives', () => {
  assert.match(source, /release: stored\.release,/, 'the move writes the destination release identity')
  assert.match(source, /isCompilation: isVariousArtists\(albumArtist\)/)
  assert.match(source, /clearAlbumReplayGain: true/)
  assert.match(source, /private releaseTagsForLibraryAlbum/, 'moves into library albums also replace release tags')
  assert.match(source, /release: this\.releaseTagsForLibraryAlbum\(track, targetAlbum, targetTracks\)/)
})

test('a new album row is created inside the move transaction with its release identity set outright', () => {
  assert.match(source, /private createAlbumForMovedTrack\(md: TrackMetadata\): number/)
  assert.match(source, /albums\.getOrCreate\(md\.album, md\.albumArtist \?\? null, md\.year \|\| null\)/, 'keyed exactly like the importer')
  assert.match(source, /replaceReleaseMetadataIfEmpty\(album\.id, md\)/, 'stale MAX/COALESCE merging is bypassed for new rows')
  assert.match(source, /extendedMetadata: serializeTrackExtendedMetadata\(md\)/, 'extended metadata is refreshed after the move')
  assert.match(source, /releaseDate: md\.releaseDate/)
})

test('original album candidates are matched against library albums', () => {
  assert.match(source, /async findOriginalAlbums\(trackId: number\): Promise<OriginalAlbumCandidatesResult>/)
  assert.match(source, /localAlbumId: local\?\.id \?\? null/)
  assert.match(source, /isCurrentAlbum: local != null && local\.id === track\.album_id/)
  assert.match(source, /Podés crear el álbum a mano/, 'MusicBrainz failures degrade to the manual album form')
})

test('album repository can reset the release identity of a brand-new album only', () => {
  assert.match(albumRepo, /replaceReleaseMetadataIfEmpty\(/)
  assert.match(albumRepo, /WHERE id = \? AND track_count = 0/)
})
