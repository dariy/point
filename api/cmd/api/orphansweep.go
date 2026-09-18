package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
)

// The fenced-div class that marks a carousel block, duplicated here because Go
// and JS cannot share a constant — see CAROUSEL_BLOCK_CLASS in
// frontend/src/utils/postNodes.js.
const carouselBlockClass = "carousel-block"

// carouselFenceRe matches a `:::{…}\n…\n:::` fenced div, non-greedy to its
// first closing `:::` (a slide path can never contain one) — mirrors
// carouselFences in frontend/src/plugins/carousel/document.js so the sweep and
// the studio agree on which fences a post's content holds.
var carouselFenceRe = regexp.MustCompile(`:::\{([^}\n]*)\}\n(?s:.*?)\n:::`)

// liveBlockKeys returns the block keys a post's content still fences. A
// keyless fence (no #id attribute) counts as the empty-string key, matching
// firstBlockKey in api/internal/api/carousel.go and the block_key migration's
// backfill of every pre-existing row.
func liveBlockKeys(content string) map[string]bool {
	keys := map[string]bool{}
	for _, m := range carouselFenceRe.FindAllStringSubmatch(content, -1) {
		isCarousel := false
		key := ""
		for _, attr := range strings.Fields(m[1]) {
			switch {
			case attr == "."+carouselBlockClass:
				isCarousel = true
			case len(attr) > 1 && strings.HasPrefix(attr, "#"):
				key = attr[1:]
			}
		}
		if isCarousel {
			keys[key] = true
		}
	}
	return keys
}

// runSweepOrphanCarouselsCLI implements `point sweep-orphan-carousels`: it
// deletes every `carousels` row whose (post_id, block_key) matches no fence in
// that post's own content — the row a carousel block deleted by hand in Text
// mode leaves behind, addressable by no fence.
func runSweepOrphanCarouselsCLI(repo repository.Repository) {
	ctx := context.Background()

	posts, err := repo.ListPostIDsAndContent(ctx)
	if err != nil {
		slog.Error("sweep-orphan-carousels: failed to list posts", "error", err)
		os.Exit(1)
	}
	live := make(map[int64]map[string]bool, len(posts))
	for _, p := range posts {
		live[p.ID] = liveBlockKeys(p.Content)
	}

	rows, err := repo.ListAllCarouselBlockKeys(ctx)
	if err != nil {
		slog.Error("sweep-orphan-carousels: failed to list carousels", "error", err)
		os.Exit(1)
	}

	swept := 0
	for _, row := range rows {
		if live[row.PostID][row.BlockKey] {
			continue
		}
		if err := repo.DeleteCarouselByBlockKey(ctx, models.DeleteCarouselByBlockKeyParams(row)); err != nil {
			slog.Error("sweep-orphan-carousels: failed to delete orphan row",
				"post_id", row.PostID, "block_key", row.BlockKey, "error", err)
			os.Exit(1)
		}
		swept++
		fmt.Printf("deleted orphan carousel: post_id=%d block_key=%q\n", row.PostID, row.BlockKey)
	}

	fmt.Printf("swept %d orphan carousel row(s) out of %d\n", swept, len(rows))
}
