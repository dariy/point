# Distraction-Free Mode (`distraction-free`)

**Type:** slot · **Slot:** `post-list-tools` · **Default:** enabled

A guest-facing toggle on the public post list: a floating button that hides all chrome
— header, footer, timeline, tag cloud, pagination — leaving only the post grid, via a
`body.distraction-free` class the plugin's CSS keys off. The choice persists in
`localStorage` but the body class is scoped to the list page, so navigating away
restores normal chrome. Disabling the plugin removes the toggle button; guests can no
longer enter full-screen browsing mode.

## Gestures

On touch the button is the entrance only — inside the mode it is hidden (a second exit
floating over the very grid the mode exists to clear), and vertical flicks work it
instead:

| Flick  | Overlay down                    | Overlay up          |
| ------ | ------------------------------- | ------------------- |
| Up     | raises the overlay              | —                   |
| Down   | leaves the mode                 | lowers the overlay  |

The overlay is the site footer — copyright, actions, and the paginator, which this mode
forces on in every orientation because the in-flow paginator it normally defers to on
portrait phones is chrome that is hidden here. It slides up over the grid
(`body.distraction-overlay`) rather than re-flowing it, so the fit never changes and
leaving the mode is always exactly one flick away from the overlay.

Mouse and trackpad sessions keep the button (`html:not(.pointer-fine)` scopes the
hiding), since they have no flick.

The gestures come from `GridPager`, which owns the only gesture recogniser on a grid
page and forwards vertical commits as a `point:grid-swipe-vertical` window event —
raised at the scroll extremes only, so mid-document the same flick stays a plain
scroll. Every page that mounts the pager (home, tag, search) feeds it.
