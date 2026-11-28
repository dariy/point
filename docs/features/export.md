# Portable export

A backup (`docs/plugins/backups.md`) restores this engine. Only this engine can read
it: it holds the SQLite file. The **portable export** holds the same content in open
formats: Markdown, JSON and the original files. Another program can read it, and the
import of a new instance can read it (see [Import](#import)).

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
- The body is followed by exactly one `\n` that is not part of the body. A reader
  removes the last `\n` to get the body as it is stored.
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

## Import

The **Import** block on the System page, under the Export block, reads an export
archive into an **empty** site: a site with no posts and no media rows (the trash
included). Use it to move a site to a new instance.

- The import refuses a site that has posts or media (`409`), a file that is not a
  `.tar.gz` with `manifest.json` as the first entry, a `format` that is not
  `point-export`, and a `version` higher than the version this build writes (`400`).
  The UI disables the button when the site is not empty.
- It reads the archive two times. The first pass reads every entry and writes
  nothing. A damaged archive, a post without front matter, an original without its
  sidecar, or an unsafe path stops the import before it changes the site.
- Each entry has a maximum size, and the first pass refuses an archive with an
  entry above it (`400`). An original, or a sidecar that comes alone, can have
  `MAX_IMPORT_ENTRY_MB` (2048 MB if not set). This limit is not the upload limit
  (`MAX_UPLOAD_SIZE_MB`): a folder import can add originals that are larger than
  an upload, and the export of that site must import again. Each original goes
  to a temporary file in `<data>/backups/imports/`, not into memory. An original
  above `MAX_UPLOAD_SIZE_MB` moves into the media directory from that file: it
  gets its size, checksum and EXIF, and its thumbnails come on request. A post
  file, `tags.json` and a sidecar can have 8 MB. All decompressed data of the
  archive can have 20 times the size of the archive file, and 1 GiB at minimum.
  This stops a decompression bomb before it uses all memory or disk.
- The second pass writes. Tags come first, from `tags.json`, with their parent links
  and sort order. The system tags of the new site stay as they are. Then each post
  goes through the normal post create (`PostService.CreatePost`), with its slug,
  status, type, front matter fields and tags. The import then sets `created_at`,
  `updated_at` and `published_at` from the front matter, and replaces
  `../media/originals/` with `/` in the body and the thumbnail.
- Each original goes through the normal upload (`MediaService.UploadFile`), so the
  derived files and the EXIF read are the same as for an upload. The original keeps
  its path (`originals/YYYY/MM/file`), so the references in the posts stay correct.
  The import then sets the caption, alt text, `uploaded_at`, the post link and the
  two metadata columns from the sidecar.
- At the end it counts the posts of each tag again and recalculates media
  visibility from the posts. The visibility in the sidecar is the same value,
  derived from the same posts.
- A file that cannot be imported does not stop the import. The result lists it
  under `problems`: a sidecar with `"missing": true` (the archive has no file), a
  file the upload refuses (too many pixels, for example), a file with the same bytes
  as an earlier file, and a checksum that is not the one in the sidecar.
- If the second pass fails (a full disk, for example), the error says how far it
  got. The site is not empty then, so a second import is refused. Restore a backup
  or use a new site.
- The import does not bring users, settings or themes: the export does not have
  them. The posts belong to the user who imports.
- The upload streams to `<data>/backups/imports/` and the import removes it when it
  ends. One import runs at a time. The result is in
  `<data>/backups/imports/import.json`.

## API

| Request | Result |
|---|---|
| `POST /api/system/export` | Starts an export in the background: `202`. `409` when an export runs. `507` when the disk does not have space (the same check as a backup). |
| `GET /api/system/export` | `{"running": …, "last": <result or null>}`. The result has `filename`, `size`, `sha256`, `created_at`, `counts`, `missing` (the first 20), `missing_count`, `error` and `duration_ms`. |
| `POST /api/system/export/<file>/authorize-download` | Body `{"current_name": "<sha256-hex of the password>"}`. Returns a single-use token. A session is necessary (no API key), as for a backup download. |
| `GET /api/system/export/<file>/download?token=…` | Streams the archive. The `X-Archive-SHA256` header has its checksum. Range requests work. |

| `POST /api/system/import` | The raw request body is the archive. Header `X-Confirm-Password: <sha256-hex of the password>`. A session is necessary (no API key). The route has no body-size limit. Starts the import in the background: `202`. `409` when an import runs or the site is not empty. `400` for an unknown archive. |
| `GET /api/system/import` | `{"running": …, "progress": …, "last": …, "empty": …}`. `progress` (null when no import runs) has `phase` (`check`, `tags`, `posts`, `media`, `finish`), `total` and `done` counts. `last` has `started_at`, `source_version`, `exported_at`, `counts`, `problems` (the first 20), `problem_count`, `error` and `duration_ms`. |

The `portable export` task in `/api/system/health` shows the outcome of the last
export. It shows a failure when one or more originals were missing. The
`portable import` task shows the outcome of the last import. It shows a failure
when one or more files were not imported as they are in the archive.

Code: `api/internal/services/system_export.go`, `api/internal/services/system_import.go`,
`api/internal/repository/export_snapshot.go`, `api/internal/repository/queries_import.go`,
`api/internal/api/system_export.go`.
