/**
 * Shared fullscreen media viewer state. A single overlay (mounted once in the
 * default layout) is driven by this composable so any component — ResultViewer,
 * TaskDetail overview refs, asset picker — can open fullscreen without each
 * re-implementing the overlay.
 */
interface FullscreenState {
  url: string | null
  kind: 'image' | 'video' | 'audio'
  trimSeconds: number | null
  trimStartSeconds: number | null
  trimEndSeconds: number | null
  durationSeconds: number | null
  filename: string | null
  error: string | null
  onTrim?: (selection: { start: number; end: number } | null, file?: File) => void
}

const state = reactive<FullscreenState>({
  url: null,
  kind: 'image',
  trimSeconds: null,
  trimStartSeconds: null,
  trimEndSeconds: null,
  durationSeconds: null,
  filename: null,
  error: null,
})

export interface FullscreenOpenOptions {
  trimSeconds?: number | null
  trimStartSeconds?: number | null
  trimEndSeconds?: number | null
  durationSeconds?: number | null
  filename?: string | null
  onTrim?: (selection: { start: number; end: number } | null, file?: File) => void
}

export function useFullscreenViewer() {
  function open(url: string, kind: 'image' | 'video' | 'audio' = 'image', options: FullscreenOpenOptions = {}) {
    state.url = url
    state.kind = kind
    state.trimSeconds = options.trimSeconds ?? null
    state.trimStartSeconds = options.trimStartSeconds ?? null
    state.trimEndSeconds = options.trimEndSeconds ?? options.trimSeconds ?? null
    state.durationSeconds = options.durationSeconds ?? null
    state.filename = options.filename ?? null
    state.error = null
    state.onTrim = options.onTrim
  }
  function close() {
    state.url = null
    state.trimSeconds = null
    state.trimStartSeconds = null
    state.trimEndSeconds = null
    state.durationSeconds = null
    state.filename = null
    state.error = null
    state.onTrim = undefined
  }
  return { state, open, close }
}
