import { getDatabase } from '../database'
import { FolderRepo, toLibraryLocation } from './FolderRepo'
import { TrackRepo } from './TrackRepo'
import { AlbumRepo } from './AlbumRepo'
import { ArtistRepo } from './ArtistRepo'
import { GenreRepo } from './GenreRepo'
import { EntityTracksRepo } from './EntityTracksRepo'
import { SearchRepo } from './SearchRepo'
import { PlaylistRepo } from './PlaylistRepo'
import { QueueRepo } from './QueueRepo'
import { DownloadJobRepo } from './DownloadJobRepo'
import { PlaybackAnalysisRepo } from './PlaybackAnalysisRepo'
import { LibraryScanLogRepo } from './LibraryScanLogRepo'

let cached: Repos | null = null

export interface Repos {
  folders: FolderRepo
  tracks: TrackRepo
  albums: AlbumRepo
  artists: ArtistRepo
  genres: GenreRepo
  entityTracks: EntityTracksRepo
  search: SearchRepo
  playlists: PlaylistRepo
  queue: QueueRepo
  downloadJobs: DownloadJobRepo
  playbackAnalysis: PlaybackAnalysisRepo
  libraryScanLog: LibraryScanLogRepo
}

export function getRepos(): Repos {
  if (cached) return cached
  const db = getDatabase()
  cached = {
    folders: new FolderRepo(db),
    tracks: new TrackRepo(db),
    albums: new AlbumRepo(db),
    artists: new ArtistRepo(db),
    genres: new GenreRepo(db),
    entityTracks: new EntityTracksRepo(db),
    search: new SearchRepo(db),
    playlists: new PlaylistRepo(db),
    queue: new QueueRepo(db),
    downloadJobs: new DownloadJobRepo(db),
    playbackAnalysis: new PlaybackAnalysisRepo(db),
    libraryScanLog: new LibraryScanLogRepo(db),
  }
  return cached
}

export {
  FolderRepo,
  toLibraryLocation,
  TrackRepo,
  AlbumRepo,
  ArtistRepo,
  GenreRepo,
  EntityTracksRepo,
  SearchRepo,
  PlaylistRepo,
  QueueRepo,
  DownloadJobRepo,
  PlaybackAnalysisRepo,
  LibraryScanLogRepo,
}
