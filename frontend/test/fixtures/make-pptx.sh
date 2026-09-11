#!/bin/bash
# Regenerate the .pptx fixtures `carouselImportPptx.test.js` reads.
#
# These are hand-written OOXML packages, not PowerPoint output: each one is the
# smallest package that exercises one part of the importer, and the XML lives
# here rather than as opaque committed bytes so a reviewer can see what a test
# is actually asserting on. They are complete enough for the importer
# (`[Content_Types].xml`, `_rels`, a theme, slide rels) and deliberately not
# complete enough for PowerPoint — no slide layouts, no masters, no notes.
#
# Usage: bash frontend/test/fixtures/make-pptx.sh
#
# `-X` and the fixed mtime are what make the archives byte-reproducible, so
# rerunning this on another machine does not show up as a diff.
set -euo pipefail

OUT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

NS_P='http://schemas.openxmlformats.org/presentationml/2006/main'
NS_A='http://schemas.openxmlformats.org/drawingml/2006/main'
NS_R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
XMLNS="xmlns:a=\"$NS_A\" xmlns:r=\"$NS_R\" xmlns:p=\"$NS_P\""

# A 1x1 PNG and a 1x1 GIF — real image bytes, small enough to read in a diff.
PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
GIF_B64='R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs='

# ── package scaffolding ──────────────────────────────────────────────────────

# stage <slide-count> — a fresh package root with everything but the slides.
stage() {
    rm -rf "$WORK/pkg"
    mkdir -p "$WORK/pkg/ppt/slides/_rels" "$WORK/pkg/ppt/_rels" "$WORK/pkg/ppt/theme" \
        "$WORK/pkg/ppt/media" "$WORK/pkg/_rels"

    cat >"$WORK/pkg/[Content_Types].xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Default Extension="emf" ContentType="image/x-emf"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>
EOF

    cat >"$WORK/pkg/_rels/.rels" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="$NS_R/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>
EOF

    # dk1 is the body colour an unstyled run inherits, accent1 the one a
    # `schemeClr` run asks for, and lt1 is a `sysClr` so both spellings are read.
    cat >"$WORK/pkg/ppt/theme/theme1.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="$NS_A" name="Fixture">
  <a:themeElements>
    <a:clrScheme name="Fixture">
      <a:dk1><a:srgbClr val="1A1A1A"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="333333"/></a:dk2>
      <a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>
      <a:accent1><a:srgbClr val="FF5A5F"/></a:accent1>
      <a:accent2><a:srgbClr val="00A699"/></a:accent2>
      <a:accent3><a:srgbClr val="FC642D"/></a:accent3>
      <a:accent4><a:srgbClr val="484848"/></a:accent4>
      <a:accent5><a:srgbClr val="767676"/></a:accent5>
      <a:accent6><a:srgbClr val="C4C4C4"/></a:accent6>
      <a:hlink><a:srgbClr val="0000EE"/></a:hlink>
      <a:folHlink><a:srgbClr val="551A8B"/></a:folHlink>
    </a:clrScheme>
  </a:themeElements>
</a:theme>
EOF
}

# presentation <cx> <cy> <slide-part>... — the deck: its canvas, and the slide
# order, which comes from `sldIdLst` through the relationships and from nothing
# else. The fixtures rely on that: `deck-basic` lists slide10 last while a
# filename sort would put it second.
presentation() {
    local cx="$1" cy="$2"
    shift 2
    local ids='' rels='' n=0
    for part in "$@"; do
        n=$((n + 1))
        ids="$ids
    <p:sldId id=\"$((255 + n))\" r:id=\"rId$n\"/>"
        rels="$rels
  <Relationship Id=\"rId$n\" Type=\"$NS_R/slide\" Target=\"slides/$part\"/>"
    done

    cat >"$WORK/pkg/ppt/presentation.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation $XMLNS>
  <p:sldIdLst>$ids
  </p:sldIdLst>
  <p:sldSz cx="$cx" cy="$cy"/>
</p:presentation>
EOF

    cat >"$WORK/pkg/ppt/_rels/presentation.xml.rels" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">$rels
  <Relationship Id="rId90" Type="$NS_R/theme" Target="theme/theme1.xml"/>
</Relationships>
EOF
}

# slide <part> [<bg-xml>] — reads the shapes from stdin.
slide() {
    local part="$1" bg="${2-}"
    cat >"$WORK/pkg/ppt/slides/$part" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld $XMLNS>
  <p:cSld>
    $bg
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
$(cat)
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>
EOF
}

# imagerels <part> <rId:target>... — one slide's image relationships.
imagerels() {
    local part="$1"
    shift
    local rels=''
    for pair in "$@"; do
        rels="$rels
  <Relationship Id=\"${pair%%:*}\" Type=\"$NS_R/image\" Target=\"../media/${pair##*:}\"/>"
    done
    cat >"$WORK/pkg/ppt/slides/_rels/$part.rels" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">$rels
</Relationships>
EOF
}

# pack <name.pptx>
pack() {
    ( cd "$WORK/pkg" && find . -exec touch -t 202601010000 {} + && \
      rm -f "$OUT/$1" && zip -q -X -9 -r "$OUT/$1" . -x '.*' )
    echo "  $1"
}

# ── shape snippets ───────────────────────────────────────────────────────────

# textbox <id> <x> <y> <cx> <cy> <sz> <rpr-attrs> <rpr-children> <ppr-attrs> \
#         <ppr-children> <bodypr-attrs> <text>
textbox() {
    cat <<EOF
      <p:sp>
        <p:nvSpPr><p:cNvPr id="$1" name="Text $1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="$2" y="$3"/><a:ext cx="$4" cy="$5"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr ${11}/><a:lstStyle/>
          <a:p>
            <a:pPr $9>${10}</a:pPr>
            <a:r><a:rPr lang="en-US" sz="$6" $7>$8<a:latin typeface="Poppins"/></a:rPr><a:t>${12}</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
EOF
}

echo "writing fixtures to $OUT"

# ── deck-basic.pptx ──────────────────────────────────────────────────────────
# 4:5 exactly (1080x1350 at 96dpi), so the fit is exact and the report says so.
# Three slides, listed 1 → 2 → 10, which is the order a filename sort gets
# wrong. Slide 1 has the rounded band and the white headline; slide 2 takes its
# colour from the theme; slide 10 is plain and last.
stage
presentation 10287000 12858750 slide1.xml slide2.xml slide10.xml

slide slide1.xml <<EOF
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="514350" y="9643500"/><a:ext cx="9258300" cy="2571600"/></a:xfrm>
          <a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom>
          <a:solidFill><a:srgbClr val="112233"><a:alpha val="80000"/></a:srgbClr></a:solidFill>
        </p:spPr>
      </p:sp>
$(textbox 3 514350 1028700 9258300 2571600 4000 'b="1"' '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' 'algn="ctr"' '<a:lnSpc><a:spcPct val="90000"/></a:lnSpc>' 'anchor="ctr"' 'One')
EOF

slide slide2.xml <<EOF
$(textbox 2 514350 514350 9258300 1285800 2400 '' '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>' 'algn="r"' '' 'anchor="b"' 'Two')
EOF

slide slide10.xml <<EOF
$(textbox 2 514350 514350 9258300 1285800 1800 '' '' '' '' '' 'Ten')
EOF

pack deck-basic.pptx

# ── deck-wide.pptx ───────────────────────────────────────────────────────────
# The common PowerPoint case: 16:9 (1280x720) against Point's widest 1.91:1, so
# the report has a margin to name. The full-frame gradient becomes the slide's
# background rather than a layer.
stage
presentation 12192000 6858000 slide1.xml

slide slide1.xml <<EOF
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Wash"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:gradFill>
            <a:gsLst>
              <a:gs pos="0"><a:srgbClr val="101820"/></a:gs>
              <a:gs pos="100000"><a:srgbClr val="486070"/></a:gs>
            </a:gsLst>
            <a:lin ang="5400000"/>
          </a:gradFill>
        </p:spPr>
      </p:sp>
$(textbox 3 914400 2286000 10363200 2286000 2800 'b="1"' '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' 'algn="ctr"' '' 'anchor="ctr"' 'Wide')
EOF

pack deck-wide.pptx

# ── deck-image.pptx ──────────────────────────────────────────────────────────
# 1:1. A full-frame picture with a crop becomes the slide's own source — which
# is what makes the photo replaceable when the template is applied — and the
# small one beside it becomes an `image` layer.
stage
presentation 10287000 10287000 slide1.xml
printf '%s' "$PNG_B64" | base64 -d >"$WORK/pkg/ppt/media/image1.png"
printf '%s' "$GIF_B64" | base64 -d >"$WORK/pkg/ppt/media/image2.gif"
imagerels slide1.xml rId1:image1.png rId2:image2.gif

slide slide1.xml <<EOF
      <p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="Photo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="rId1"/>
          <a:srcRect l="10000" t="5000" r="0" b="15000"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="10287000" cy="10287000"/></a:xfrm></p:spPr>
      </p:pic>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="3" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"><a:alphaModFix amt="60000"/></a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="8229600" y="8229600"/><a:ext cx="1028700" cy="1028700"/></a:xfrm></p:spPr>
      </p:pic>
EOF

pack deck-image.pptx

# ── deck-mixed.pptx ──────────────────────────────────────────────────────────
# The drop report. One text layer and one rotated rectangle survive; everything
# else here is something the layer schema has no room for, and each one has to be
# named and counted — the two ellipses as a single entry with a count of 2.
stage
presentation 10287000 12858750 slide1.xml
printf 'not really an EMF' >"$WORK/pkg/ppt/media/logo.emf"
imagerels slide1.xml rId1:logo.emf

slide slide1.xml '<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="lt2"/></a:gs><a:gs pos="100000"><a:srgbClr val="203040"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></p:bgPr></p:bg>' <<EOF
$(textbox 2 514350 514350 9258300 1285800 3200 'b="1" i="1"' '' 'algn="l"' '' '' 'Kept')
      <p:grpSp>
        <p:nvGrpSpPr><p:cNvPr id="3" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr>
        <p:sp><p:nvSpPr><p:cNvPr id="4" name="In group"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>
      </p:grpSp>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="5" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic>
      </p:graphicFrame>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></p:xfrm>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"/></a:graphic>
      </p:graphicFrame>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="7" name="Blob"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="514350" y="3000000"/><a:ext cx="1028700" cy="1028700"/></a:xfrm>
          <a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="FF5A5F"/></a:solidFill>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="13" name="Blob 2"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="2000000" y="3000000"/><a:ext cx="1028700" cy="1028700"/></a:xfrm>
          <a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="00A699"/></a:solidFill>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="8" name="Outline"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="514350" y="4500000"/><a:ext cx="1028700" cy="1028700"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
          <a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="9" name="Turned"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm rot="2700000"><a:off x="514350" y="6000000"/><a:ext cx="2057400" cy="1028700"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="00A699"/></a:solidFill>
          <a:effectLst><a:outerShdw blurRad="50800"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>
        </p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="10" name="Inherited"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>From the layout</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="11" name="Vector"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="514350" y="8000000"/><a:ext cx="1028700" cy="1028700"/></a:xfrm></p:spPr>
      </p:pic>
      <p:cxnSp>
        <p:nvCxnSpPr><p:cNvPr id="12" name="Line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom></p:spPr>
      </p:cxnSp>
EOF

pack deck-mixed.pptx

# ── deck-empty.pptx ──────────────────────────────────────────────────────────
# A canvas and no slides. No exporter writes this; it is the branch that has to
# say "this file contains no slides" rather than produce a template of nothing.
stage
presentation 10287000 12858750
pack deck-empty.pptx

# ── deck-broken.pptx ─────────────────────────────────────────────────────────
# One bad slide must cost that slide and nothing else: the deck comes back short
# with the failure named. Slide 2 is not XML at all, which is the case both DOMs
# agree on — a browser makes a `parsererror` document, linkedom makes none.
stage
presentation 10287000 12858750 slide1.xml slide2.xml slide3.xml
slide slide1.xml <<EOF
$(textbox 2 514350 514350 9258300 1285800 2400 '' '' '' '' '' 'First')
EOF
printf 'this is not xml' >"$WORK/pkg/ppt/slides/slide2.xml"
slide slide3.xml <<EOF
$(textbox 2 514350 514350 9258300 1285800 2400 '' '' '' '' '' 'Third')
EOF

pack deck-broken.pptx

echo "done"
