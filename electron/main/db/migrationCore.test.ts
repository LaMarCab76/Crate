import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildMigrationCatalog, planMigrations } from './migrationCore.ts'

function sources(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map(name => [`./migrations/${name}`, `-- ${name}`]))
}

function numberedNames(max: number): string[] {
  return Array.from({ length: max }, (_, index) => {
    const version = index + 1
    return `${String(version).padStart(4, '0')}_migration_${version}.sql`
  })
}

test('catalog derives versions from filenames and preserves current 22 through 30 mapping', () => {
  const names = [
    ...numberedNames(21),
    '0022_track_album_moves.sql',
    '0023_cleanup_orphaned_entities_on_track_update.sql',
    '0024_drop_device_legacy_flags.sql',
    '0025_playlist_metrics.sql',
    '0026_download_job_reservations.sql',
    '0027_library_locations.sql',
    '0028_library_mirror_journal.sql',
    '0029_library_location_presentation.sql',
    '0030_library_location_migrations.sql',
  ]
  const catalog = buildMigrationCatalog(sources([...names].reverse()))

  assert.equal(catalog.length, 30)
  assert.deepEqual(catalog.slice(21).map(({ version, name }) => ({ version, name })), [
    { version: 22, name: '0022_track_album_moves.sql' },
    { version: 23, name: '0023_cleanup_orphaned_entities_on_track_update.sql' },
    { version: 24, name: '0024_drop_device_legacy_flags.sql' },
    { version: 25, name: '0025_playlist_metrics.sql' },
    { version: 26, name: '0026_download_job_reservations.sql' },
    { version: 27, name: '0027_library_locations.sql' },
    { version: 28, name: '0028_library_mirror_journal.sql' },
    { version: 29, name: '0029_library_location_presentation.sql' },
    { version: 30, name: '0030_library_location_migrations.sql' },
  ])

  const upgrade = planMigrations(catalog, 24)
  assert.equal(upgrade.targetVersion, 30)
  assert.deepEqual(upgrade.pending.map(migration => migration.name), [
    '0025_playlist_metrics.sql',
    '0026_download_job_reservations.sql',
    '0027_library_locations.sql',
    '0028_library_mirror_journal.sql',
    '0029_library_location_presentation.sql',
    '0030_library_location_migrations.sql',
  ])
  assert.deepEqual(planMigrations(catalog, 30).pending, [])
})

test('catalog rejects duplicate versions deterministically', () => {
  const input = sources([
    ...numberedNames(21),
    '0022_track_album_moves.sql',
    '0022_cloud_source.sql',
  ])
  const expected = 'Duplicate migration version 0022: 0022_cloud_source.sql, 0022_track_album_moves.sql'
  assert.throws(() => buildMigrationCatalog(input), { message: expected })
  assert.throws(() => buildMigrationCatalog(Object.fromEntries(Object.entries(input).reverse())), { message: expected })
})

test('catalog rejects gaps, zero, malformed names and empty sources', () => {
  assert.throws(
    () => buildMigrationCatalog(sources(['0001_one.sql', '0002_two.sql', '0004_four.sql'])),
    /Missing migration 0003/,
  )
  assert.throws(() => buildMigrationCatalog(sources(['0002_two.sql'])), /Missing migration 0001/)
  assert.throws(() => buildMigrationCatalog(sources(['0000_zero.sql'])), /must start at 0001/)
  for (const name of ['25_name.sql', '0025.sql', '0025_name.txt', '00001_name.sql']) {
    assert.throws(() => buildMigrationCatalog(sources([name])), /Invalid migration filename/)
  }
  assert.throws(() => buildMigrationCatalog({}), /No migration files/)
})

test('planning rejects invalid and newer database versions', () => {
  const catalog = buildMigrationCatalog(sources(numberedNames(3)))
  for (const version of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => planMigrations(catalog, version), /Invalid database schema version/)
  }
  assert.throws(
    () => planMigrations(catalog, 4),
    /Database schema version 4 is newer.*maximum supported version 3/,
  )
})

test('repository migration layout is contiguous and includes finalized local migrations', () => {
  const directory = new URL('./migrations/', import.meta.url)
  const names = readdirSync(directory)
  const migrationLooking = names.filter(name => /^\d/.test(name))
  for (const name of migrationLooking) {
    assert.match(name, /^\d{4}_[^/]+\.sql$/, `nonconforming migration-like file: ${name}`)
  }

  const source = Object.fromEntries(
    names
      .filter(name => name.endsWith('.sql'))
      .map(name => [`./migrations/${name}`, readFileSync(new URL(name, directory), 'utf8')]),
  )
  const catalog = buildMigrationCatalog(source)
  assert.equal(catalog.at(-1)?.version, 30)
  assert.deepEqual(catalog.slice(21).map(migration => migration.name), [
    '0022_track_album_moves.sql',
    '0023_cleanup_orphaned_entities_on_track_update.sql',
    '0024_drop_device_legacy_flags.sql',
    '0025_playlist_metrics.sql',
    '0026_download_job_reservations.sql',
    '0027_library_locations.sql',
    '0028_library_mirror_journal.sql',
    '0029_library_location_presentation.sql',
    '0030_library_location_migrations.sql',
  ])
})

test('database startup prepares migrations before lyrics preflight and runs the prepared plan after it', () => {
  const source = readFileSync(new URL('./database.ts', import.meta.url), 'utf8')
  const prepare = source.indexOf('prepareMigrations(db)')
  const lyrics = source.indexOf('materializeLyricsSidecars(db, dirname(path))')
  const apply = source.indexOf('runPreparedMigrations(db, migrationPlan)')
  assert.ok(prepare >= 0 && lyrics > prepare && apply > lyrics)
})
