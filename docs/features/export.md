# Portable export

A backup (`docs/plugins/backups.md`) restores this engine. Only this engine can read
it: it holds the SQLite file. The **portable export** holds the same content in open
formats: Markdown, JSON and the original files. Another program can read it, and the
import of a new instance can read it.

The export is part of the `backups` plugin. The **Export** block on the System
page, under the backups list, starts it.

## The archive

The export is one `.tar.gz` file, `point-export_<YYYYMMDD_HHMMSS>.tar.gz`:

```
manifest.json
tags.json
posts/<slug>.md
media/originals/<YYYY>/<MM>/<file>
media/originals/<YYYY>/<MM>/<file>.json
```

`manifest.json` is the **first** entry, so a reader can refuse an unknown version
before it reads the rest.

```json
{
  "format": "point-export",
  "version": 1,
  "instance_version": "v1.40.0",
  "created_at": "2026-11-26T12:00:00Z",
  "counts": { "posts": 240, "pages": 3, "media": 1210, "tags": 58 }
}
```

- `format` is always `point-export`. `version` is the format version. An import
  refuses a version that is higher than the version it knows. This version is
  separate from the version of the backup manifest.
- `counts` are the row counts of the export: posts and pages that are not in the
  trash, media rows that are not in the trash, and all tags.

### Posts: `posts/<slug>.md`

One file for each post and each page that is not in the trash. The file has YAML
front matter, then the post body as it is stored:

```markdown
---
title: Evening walk
slug: evening-walk
type: post
status: published
formatter: markdown
featured: true
created_at: 2024-01-05T17:00:00Z
updated_at: 2024-01-06T09:00:00Z
published_at: 2024-01-05T18:00:00Z
tags:
    - paris
    - places
thumbnail: ../media/originals/2024/01/river.jpg
css: '.post { color: red; }'
---

../media/originals/2024/01/river.jpg
```

- `type` is `post` or `page`. `status` is `draft`, `published` or `scheduled`.
- `tags` holds tag slugs. `tags.json` has the tag data.
- These fields are in the file only when they have a value: `featured`,
  `published_at`, `scheduled_at`, `thumbnail`, `excerpt`, `meta_description`,
  `immersive_mode` (left out when it is `auto`) and `css`.
- All times are UTC.
- A slug that cannot be a file name (it holds `/`, `\` or is `.`/`..`) gives the
  file name `post-<id>.md`. The front matter has the real slug.

**Media references.** The engine stores a reference to a photo as `/YYYY/MM/file`.
The export writes it as `../media/originals/YYYY/MM/file`, which is the path of the
original from the post file. A Markdown viewer that opens the unpacked archive
shows the photos. The export changes a reference only when that file is in the
export. It does not change a `/YYYY/MM/` part of a longer URL
(`https://host/2024/01/x.jpg`). To get the stored form back, replace
`../media/originals/` with `/`.

### Media: `media/originals/…` and the sidecar

Each media row that is not in the trash gives the original file and a JSON sidecar
with the same name plus `.json`:

```json
{
  "filename": "river.jpg",
  "original_path": "originals/2024/01/river.jpg",
  "file_type": "image",
  "mime_type": "image/jpeg",
  "file_size": 4812233,
  "width": 4000,
  "height": 3000,
  "uploaded_at": "2024-01-05T16:00:00Z",
  "checksum": "…",
  "alt_text": "A river",
  "caption": "The river at dusk",
  "exif": { "Make": "NIKON", "FNumber": "28/10" },
  "original_exif": { … },
  "visibility": "public",
  "post": "evening-walk"
}
```

- `exif` is the metadata as the instance shows it. `original_exif` is the metadata
  read from the file at upload. An empty value is left out.
- `visibility` is `public` when the file is in a visible published post, else
  `private`.
- `post` is the slug of the post that the file was uploaded to.
- Media has no tags of its own in this version. The tags of a post are in its
  front matter.
- When the original is not on disk at export time, the sidecar has
  `"missing": true` and the archive has no file for it. The export does not stop.

### Tags: `tags.json`

A list of all tags in slug order. Each tag has `name`, `slug`, `description`,
`kind`, `hidden`, `hides_posts`, `nav_order`, `in_breadcrumbs`, `show_related`,
`in_ancestor_flyout`, `latitude`/`longitude` (both or none), `created_at`, and
`parents`: a list of `{ "slug", "sort_order" }`.

### What the export leaves out

The same derived data as the backup: thumbnails, variants and the page cache. The
engine makes them again from the originals. The export also leaves out users,
sessions, API keys, settings, themes, jobs, view counts and the trash. Use a backup
to move a whole instance.

## How the export runs

- It takes a `VACUUM INTO` snapshot of the database, as the backup does, and reads
  the content from the snapshot. The archive shows one consistent state.
- It streams each post, each sidecar and each original into the archive. It reads
  database rows one at a time. A large library does not go into memory.
- It writes `<name>.tar.gz.partial` and renames it when the archive is complete. A
  start of the server removes a stale partial.
- One export runs at a time. When an export is complete, the older exports are
  removed: each export holds a copy of every original.
- The archives go into `<data>/backups/exports/`. The backup skips `backups/`, so an
  export never goes into a backup.
- gzip runs at `BestSpeed`, because the archive is mostly JPEGs.

## API

| Request | Result |
|---|---|
| `POST /api/system/export` | Starts an export in the background: `202`. `409` when an export runs. `507` when the disk does not have space (the same check as a backup). |
| `GET /api/system/export` | `{"running": …, "last": <result or null>}`. The result has `filename`, `size`, `sha256`, `created_at`, `counts`, `missing` (the first 20), `missing_count`, `error` and `duration_ms`. |
| `POST /api/system/export/<file>/authorize-download` | Body `{"current_name": "<sha256-hex of the password>"}`. Returns a single-use token. A session is necessary (no API key), as for a backup download. |
| `GET /api/system/export/<file>/download?token=…` | Streams the archive. The `X-Archive-SHA256` header has its checksum. Range requests work. |

The `portable export` task in `/api/system/health` shows the outcome of the last
export. It shows a failure when one or more originals were missing.

Code: `api/internal/services/system_export.go`,
`api/internal/repository/export_snapshot.go`, `api/internal/api/system_export.go`.
