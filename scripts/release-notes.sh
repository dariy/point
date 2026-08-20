#!/usr/bin/env bash
# Print the GitHub Release body for a tag, on stdout.
#
# Two sources, because the repo has two kinds of tag. tag-release.yml bumps a
# patch tag on every merge to main, so most tags have no CHANGELOG section of
# their own and never will; CHANGELOG.md says so itself ("this file records
# notable changes, not one section per tag"). The notes therefore lead with the
# curated `## [x.y.z]` section when one exists, and always carry the commit
# range for the tag, which is the part that is true per-release.
#
# The Unreleased section is deliberately NOT used as a fallback: it accumulates
# across dozens of patch tags, so pasting it into each release would claim
# changes that shipped twenty tags ago.
#
# Usage: ./scripts/release-notes.sh <tag> [--changelog=PATH] [--repo=owner/name]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG=""
CHANGELOG="$ROOT_DIR/CHANGELOG.md"
REPO="${GITHUB_REPOSITORY:-dariy/point}"
MAX_COMMITS=50

for arg in "$@"; do
    case "$arg" in
        --changelog=*) CHANGELOG="${arg#*=}" ;;
        --repo=*)      REPO="${arg#*=}" ;;
        -h|--help)     sed -n '2,16p' "$0"; exit 0 ;;
        -*)            echo "unknown option: $arg" >&2; exit 2 ;;
        *)             TAG="$arg" ;;
    esac
done

[ -n "$TAG" ] || { echo "usage: $0 <tag>" >&2; exit 2; }
VERSION="${TAG#v}"

# ── Curated section, if this version has one ──────────────────────────────────
# Matches `## [0.1.0]` with or without a trailing title, and stops at the next
# `## ` heading.
section="$(awk -v ver="$VERSION" '
    $0 ~ "^## \\[" ver "\\]" { in_section = 1; next }
    in_section && /^## / { exit }
    # The link-reference block at the foot of the file follows the last
    # section without a heading of its own.
    in_section && /^\[[^]]+\]:[ \t]*http/ { exit }
    in_section {
        # Trim the blank lines around the section: skip them before the first
        # real line, and hold them back afterwards so a trailing run is dropped.
        if (!started && $0 ~ /^[ \t]*$/) next
        started = 1
        if ($0 ~ /^[ \t]*$/) { pending = pending "\n"; next }
        printf "%s", pending; pending = ""
        print
    }
' "$CHANGELOG" 2>/dev/null || true)"

# ── Commit range ──────────────────────────────────────────────────────────────
# The tag has to be a real rev here; when it is not (notes generated before the
# tag is pushed) fall back to HEAD so the range is still meaningful.
ref="$TAG"
git -C "$ROOT_DIR" rev-parse -q --verify "${TAG}^{commit}" >/dev/null 2>&1 || ref="HEAD"
prev="$(git -C "$ROOT_DIR" describe --tags --abbrev=0 "${ref}^" 2>/dev/null || true)"

if [ -n "$prev" ]; then
    range="${prev}..${ref}"
else
    range="$ref"
fi
commits="$(git -C "$ROOT_DIR" log --pretty='- %s (%h)' --max-count="$((MAX_COMMITS + 1))" "$range" 2>/dev/null || true)"
total="$(git -C "$ROOT_DIR" rev-list --count "$range" 2>/dev/null || echo 0)"

# ── Body ──────────────────────────────────────────────────────────────────────
if [ -n "$section" ]; then
    printf '%s\n\n' "$section"
else
    printf 'Automatic patch release. Notable changes across releases are recorded in [CHANGELOG.md](https://github.com/%s/blob/main/CHANGELOG.md).\n\n' "$REPO"
fi

if [ -n "$commits" ]; then
    if [ -n "$prev" ]; then
        printf '### Commits since %s\n\n' "$prev"
    else
        printf '### Commits\n\n'
    fi
    printf '%s\n' "$commits" | head -n "$MAX_COMMITS"
    if [ "$total" -gt "$MAX_COMMITS" ]; then
        printf -- '- …and %s more\n' "$((total - MAX_COMMITS))"
    fi
    printf '\n'
fi

cat <<EOF
### Install

Docker:

\`\`\`sh
docker pull ghcr.io/${REPO}:${TAG}
\`\`\`

Native (linux amd64 / arm64) — the wizard downloads the tarball attached below:

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/${REPO}/main/quickstart/install.sh | sudo bash -s -- --method=native
\`\`\`

\`checksums.txt\` holds the SHA-256 of each tarball.
EOF

if [ -n "$prev" ]; then
    printf '\n**Full changelog**: https://github.com/%s/compare/%s...%s\n' "$REPO" "$prev" "$TAG"
fi
