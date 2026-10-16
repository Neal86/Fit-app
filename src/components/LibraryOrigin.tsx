import type { Exercise } from '../types'

// This is immutable ancestry from the copy, never a lookup of the current library.
export default function LibraryOrigin({ origin }: { origin: Exercise['libraryOrigin'] }) {
  return origin ? <small className="library-origin">Copied from your library, revision {origin.revision}; this copy may have been edited</small> : null
}
