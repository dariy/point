# Immersive Share (`immersive-share`)

**Type:** slot · **Slot:** `immersive-share` · **Default:** enabled

A floating share button injected into the media viewer (both the
[immersive viewer](immersive.md) and the lightbox), via the `immersive-share` sub-slot
inside `.media-viewer-wrapper`. Uses `navigator.share` where available, falling back to
copy-link with a toast. Disabling the plugin removes the button everywhere the media
viewer renders, without affecting the viewer itself.
