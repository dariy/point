# Distraction-Free Mode (`distraction-free`)

**Type:** slot · **Slot:** `post-list-tools` · **Default:** enabled

A guest-facing toggle on the public post list: a floating button that hides all chrome
— header, footer, timeline, tag cloud, pagination — leaving only the post grid, via a
`body.distraction-free` class the plugin's CSS keys off. The choice persists in
`localStorage` but the body class is scoped to the list page, so navigating away
restores normal chrome. Disabling the plugin removes the toggle button; guests can no
longer enter full-screen browsing mode.
