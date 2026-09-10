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
