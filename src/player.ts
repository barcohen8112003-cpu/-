// Plays an exact-length snippet of a YouTube video through a hidden IFrame player.

declare global {
  interface Window {
    YT?: any
    onYouTubeIframeAPIReady?: () => void
  }
}

const PLAYING = 1
const PRIME_TIMEOUT_MS = 4000

let api: Promise<void> | undefined
function loadApi() {
  api ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve()
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    document.head.append(script)
  })
  return api
}

type Handlers = {
  onReady: () => void // the current video is buffered and can start instantly
  onPlaying: (playing: boolean) => void
  onError: () => void // the video cannot be embedded or no longer exists
}

export class SnippetPlayer {
  private player: any
  private created: Promise<void>
  private start = 0
  private primed = false
  private clipMs: number | null = null
  private stopTimer = 0
  private primeTimer = 0

  constructor(host: HTMLElement, private handlers: Handlers) {
    this.created = loadApi().then(
      () =>
        new Promise((resolve) => {
          this.player = new window.YT.Player(host, {
            width: 200,
            height: 200,
            playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
            events: {
              onReady: () => resolve(),
              onStateChange: (event: { data: number }) => this.onState(event.data),
            },
          })
        }),
    )
  }

  // Buffers the video muted, so the first audible play starts without delay.
  async load(videoId: string, start: number) {
    await this.created
    this.reset()
    this.start = start
    this.primed = false
    this.player.mute()
    this.player.loadVideoById({ videoId, startSeconds: start })
    // Browsers may block muted autoplay; the first click will start playback instead.
    this.primeTimer = window.setTimeout(() => this.markPrimed(), PRIME_TIMEOUT_MS)
  }

  // Plays `seconds` from the start point; Infinity plays on until stopped.
  play(seconds: number) {
    this.reset()
    this.primed = true
    this.clipMs = seconds * 1000
    this.player.seekTo(this.start, true)
    this.player.unMute()
    this.player.playVideo()
  }

  stop() {
    this.reset()
    this.player?.pauseVideo?.()
    this.handlers.onPlaying(false)
  }

  setVolume(volume: number) {
    this.created.then(() => this.player.setVolume(volume))
  }

  private reset() {
    clearTimeout(this.stopTimer)
    clearTimeout(this.primeTimer)
    this.clipMs = null
  }

  private markPrimed() {
    if (this.primed) return
    this.primed = true
    this.handlers.onReady()
  }

  private onState(state: number) {
    if (state !== PLAYING) {
      if (this.primed && this.clipMs === null) this.handlers.onPlaying(false)
      return
    }
    if (!this.primed) {
      clearTimeout(this.primeTimer)
      this.player.pauseVideo()
      this.player.seekTo(this.start, true)
      this.markPrimed()
      return
    }
    if (this.clipMs === null) return
    // The clock starts only once audio is really running, which keeps short snippets accurate.
    const clipMs = this.clipMs
    this.clipMs = null
    this.handlers.onPlaying(true)
    if (Number.isFinite(clipMs)) this.stopTimer = window.setTimeout(() => this.stop(), clipMs)
  }
}
