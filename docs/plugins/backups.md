# Backups (`backups`)

**Type:** service · **Default:** enabled

Backend service backing the System page's backup functionality: create and restore
`tar.gz` backups of the data store, with disk-space checks before creating a new one
(a backup isn't started if it would leave insufficient free space, accounting for the
previous backup's size). No dedicated frontend chunk — the System page's backup
controls are what the plugin gates.
