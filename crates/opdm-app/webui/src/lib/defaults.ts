import type { Settings } from '@/types'

// Real backend defaults mirror the Rust Settings (cfg.rs): port 9100,
// max_segments 8, integrate_takeover true. Dark theme matches the app look
// (docs/MIGRATE_TO_NEW_FRONTEND.md, Phase 1 step 8).
export const DEFAULT_SETTINGS: Settings = {
  downloadDir: '~/Downloads', theme: 'dark', language: 'en', notifyInApp: true, notifySystem: true, restoreQueue: true,
  maxSegments: 8, capturePort: 9100, integrateTakeover: true, userAgent: '',
  maxConcurrent: 3, fragmentThreads: 4, speedLimitKb: 0, autoStart: true, filenameTemplate: '%(title)s [%(id)s].%(ext)s', sponsorBlock: false,
  proxy: '', cookieMode: 'none', cookieText: '', cookieFile: '',
  reencode: 'none', embedSubs: false, embedThumb: true, embedMeta: true, embedChapters: false,
}
