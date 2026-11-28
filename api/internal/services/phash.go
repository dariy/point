package services

import (
	"database/sql"
	"image"
	"math/bits"
	"sort"
)

// Possible duplicates (NF-16). An exact duplicate has the same bytes and so the
// same media.checksum. A possible duplicate is the same picture at a different
// size or in a different format: its bytes differ, but its perceptual hash
// (media.phash) is near.

// PhashMaxDistance is the largest Hamming distance between two perceptual
// hashes that still makes the two images possible duplicates. A re-encode or a
// resize of one photo moves a few bits; two different photos differ in about
// half of the 64 bits. TestPerceptualHash_Fixtures pins this value against the
// fixture set in testdata/phash.
const PhashMaxDistance = 10

// phashCellSamples bounds the samples per cell on each axis, so the hash of a
// large photo reads at most 9*8*32*32 pixels and not every pixel.
const phashCellSamples = 32

// perceptualHash returns the 64-bit difference hash (dHash) of img. It
// averages the luminance of a 9×8 grid of cells, then sets one bit for each
// pair of adjacent cells in a row: 1 when the left cell is brighter. The hash
// depends on the shape of the picture and not on its size, its encoder or
// small changes of color.
//
// Give it the oriented image (decodeOriented), so a photo and its rotated
// copy with an EXIF Orientation tag get the same hash.
func perceptualHash(img image.Image) uint64 {
	const cols, rows = 9, 8
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return 0
	}
	var lum [rows][cols]float64
	for cy := 0; cy < rows; cy++ {
		y0, y1 := b.Min.Y+cy*h/rows, b.Min.Y+(cy+1)*h/rows
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for cx := 0; cx < cols; cx++ {
			x0, x1 := b.Min.X+cx*w/cols, b.Min.X+(cx+1)*w/cols
			if x1 <= x0 {
				x1 = x0 + 1
			}
			lum[cy][cx] = cellLuminance(img, x0, y0, x1, y1)
		}
	}
	var hash uint64
	for cy := 0; cy < rows; cy++ {
		for cx := 0; cx < cols-1; cx++ {
			hash <<= 1
			if lum[cy][cx] > lum[cy][cx+1] {
				hash |= 1
			}
		}
	}
	return hash
}

// cellLuminance is the mean BT.601 luma of the pixels sampled in the
// rectangle [x0,x1)×[y0,y1). Each axis gets at most phashCellSamples evenly
// spaced samples, at the centers of equal spans.
func cellLuminance(img image.Image, x0, y0, x1, y1 int) float64 {
	nx := min(x1-x0, phashCellSamples)
	ny := min(y1-y0, phashCellSamples)
	var sum float64
	for j := 0; j < ny; j++ {
		y := y0 + (2*j+1)*(y1-y0)/(2*ny)
		for i := 0; i < nx; i++ {
			x := x0 + (2*i+1)*(x1-x0)/(2*nx)
			r, g, bl, _ := img.At(x, y).RGBA()
			sum += 0.299*float64(r) + 0.587*float64(g) + 0.114*float64(bl)
		}
	}
	return sum / float64(nx*ny)
}

// phashValue is the media.phash column value of a hash. SQLite integers are
// signed 64-bit, so the bits are stored as an int64.
func phashValue(img image.Image) sql.NullInt64 {
	if img == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: int64(perceptualHash(img)), Valid: true}
}

// phashDistance is the Hamming distance between two stored hashes.
func phashDistance(a, b int64) int {
	return bits.OnesCount64(uint64(a) ^ uint64(b))
}

// phashEntry is one media id and its stored hash.
type phashEntry struct {
	id   int64
	hash int64
}

// groupByPhash puts the ids whose hashes are within PhashMaxDistance into the
// same group, transitively. It returns only groups of two or more ids. Each
// group is in id order. The group with the newest upload (the highest id)
// comes first.
//
// It compares every pair. A library of 10 000 images is 50 million XOR and
// popcount steps, which is a fraction of a second.
func groupByPhash(entries []phashEntry) [][]int64 {
	parent := make([]int, len(entries))
	for i := range parent {
		parent[i] = i
	}
	find := func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	for i, a := range entries {
		for k, b := range entries[i+1:] {
			if phashDistance(a.hash, b.hash) <= PhashMaxDistance {
				if ri, rj := find(i), find(i+1+k); ri != rj {
					parent[rj] = ri
				}
			}
		}
	}
	byRoot := map[int][]int64{}
	for i, e := range entries {
		r := find(i)
		byRoot[r] = append(byRoot[r], e.id)
	}
	var groups [][]int64
	for _, ids := range byRoot {
		if len(ids) < 2 {
			continue
		}
		sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
		groups = append(groups, ids)
	}
	sort.Slice(groups, func(a, b int) bool { return groups[a][len(groups[a])-1] > groups[b][len(groups[b])-1] })
	return groups
}
