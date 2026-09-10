# Test fixtures

Binary fixtures, with the recipe that made each one. Regenerate rather than
hand-edit — and if you do, check the test that reads it still names the same
entries.

## `zip-shape.pptx`

A ZIP with the shape a real `.pptx` has — mixed stored and deflated members,
directory entries, nested paths — read by `carouselImportZip.test.js`. It is
*not* a complete OOXML package (no `_rels/`, no slide layouts), and PowerPoint
will not open it: what it proves is that the reader handles a real archiver's
output rather than only the archives the test builds itself.

```bash
tmp=$(mktemp -d) && cd "$tmp" && mkdir -p ppt/slides
# [Content_Types].xml, ppt/presentation.xml (with <p:sldSz cx="12192000" cy="6858000"/>)
# and ppt/slides/slide1.xml (one <p:sp> titled "Seamless cover") — see the
# entries the test asserts on for the exact content.
find . -exec touch -t 202601010000 {} +      # byte-reproducible archive
zip -q -X -0 out.zip '[Content_Types].xml'   # stored
zip -q -X -9 -r out.zip ppt                  # deflated, plus directory entries
```

`-X` drops the uid/gid and timestamp extra fields, which is what makes the
archive reproducible on another machine. Extra-field skipping is covered by a
synthesized archive in the test instead.

## `deck-*.pptx`

Six hand-written OOXML packages read by `carouselImportPptx.test.js`, all
produced by `make-pptx.sh` in this directory:

```bash
bash frontend/test/fixtures/make-pptx.sh
```

| Fixture | What it is for |
|---|---|
| `deck-basic.pptx` | 4:5, three slides listed 1 → 2 → 10 (the order a filename sort gets wrong), a text box, a rounded translucent band, a theme colour and an inherited one |
| `deck-wide.pptx` | 16:9 against Point's widest 1.91:1 — the margin the report has to name — plus a full-frame gradient that becomes the slide background |
| `deck-image.pptx` | 1:1, a cropped full-frame picture (the slide's own source) and a small one beside it (an `image` layer) |
| `deck-mixed.pptx` | the drop report: a group, a chart, a table, two ellipses, an outline-only box, a rotated shape with a shadow, a layout-inherited placeholder, an EMF, a connector |
| `deck-empty.pptx` | a canvas and no slides |
| `deck-broken.pptx` | three slides where the second is not XML — one bad slide must cost that slide only |

The XML lives in the generator rather than in the committed bytes on purpose:
a reviewer can see what each test is asserting on, and a new case is an edit
there rather than a binary nobody can read. They are complete enough for the
importer — `[Content_Types].xml`, `_rels`, a theme colour scheme, slide
relationships — and deliberately not complete enough for PowerPoint, which
wants slide layouts and a master. Same `-X` and fixed-mtime trick as above, so
regenerating them is not a diff.
