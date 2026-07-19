# Offline Sync (`offline-sync`)

**Type:** service · **Default:** enabled

PWA offline support: registers the service worker (`/sw.js`) for app-shell caching and
the Web Share Target, tracks last-sync metadata, and syncs a queued-writes buffer
(`utils/sync.js`) whenever the browser comes back online (or immediately, if already
online at mount). Backs the "available offline" indicator and lets the admin app queue
edits made while disconnected for replay once connectivity returns.
