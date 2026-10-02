package services

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/draw"
	"image/jpeg"
	"io"
	"os"
	"sort"
	"sync"

	// Formats that decodeOriented accepts. image/png and image/gif register
	// through their own imports elsewhere; these add the ones only
	// x/image has.
	_ "image/gif"
	_ "image/png"

	_ "golang.org/x/image/bmp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
)

// fitImage scales src down so it fits inside maxW×maxH with its aspect ratio
// kept. A source that already fits comes back unchanged: the ladder never
// upscales.
//
// The output size uses one truncation rule: the side that hits the bound is
// the bound, and the other side is int(bound * aspect). articleSrcset in
// api/internal/api/srcset.go and thumbSrcset in frontend/src/utils/mediaUrl.ts
// compute width descriptors with the same expression, so a change here must
// change them too. TestFitSizeRule pins it.
func fitImage(src image.Image, maxW, maxH int) image.Image {
	b := src.Bounds()
	w, h := fitSize(b.Dx(), b.Dy(), maxW, maxH)
	return scaleTo(src, w, h)
}

// scaleTo resamples src to exactly w×h with Catmull-Rom. It returns src when
// the size already matches.
func scaleTo(src image.Image, w, h int) image.Image {
	b := src.Bounds()
	if w == b.Dx() && h == b.Dy() {
		return src
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, xdraw.Src, nil)
	return dst
}

// fitLadder fits src into a square box of each size and returns the results
// keyed by size. Each output has the size fitImage gives the source.
//
// A resample from the full source costs about the same at every size,
// because the kernel widens with the reduction. So a size gets its pixels
// from an already-made rung when that rung is at least twice as large, and
// the sizes that must come from the source run concurrently.
func fitLadder(src image.Image, sizes []int) map[int]image.Image {
	desc := append([]int(nil), sizes...)
	sort.Sort(sort.Reverse(sort.IntSlice(desc)))
	b := src.Bounds()

	// base[i] is the index in desc whose output size i resamples, or -1 for
	// the source.
	base := make([]int, len(desc))
	for i, size := range desc {
		base[i] = -1
		for j := i - 1; j >= 0; j-- {
			if desc[j] >= 2*size {
				base[i] = j
				break
			}
		}
	}

	out := make([]image.Image, len(desc))
	var wg sync.WaitGroup
	for i, size := range desc {
		if base[i] != -1 {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = fitImage(src, size, size)
		}()
	}
	wg.Wait()
	for i, size := range desc {
		if base[i] == -1 {
			continue
		}
		w, h := fitSize(b.Dx(), b.Dy(), size, size)
		out[i] = scaleTo(out[base[i]], w, h)
	}

	m := make(map[int]image.Image, len(desc))
	for i, size := range desc {
		m[size] = out[i]
	}
	return m
}

// fitSize is the size fitImage gives a srcW×srcH image in a maxW×maxH box.
func fitSize(srcW, srcH, maxW, maxH int) (int, int) {
	if srcW <= maxW && srcH <= maxH {
		return srcW, srcH
	}
	srcAspect := float64(srcW) / float64(srcH)
	w, h := maxW, maxH
	if srcAspect > float64(maxW)/float64(maxH) {
		h = int(float64(w) / srcAspect)
	} else {
		w = int(float64(h) * srcAspect)
	}
	return max(w, 1), max(h, 1)
}

// decodeOriented decodes r and applies the EXIF Orientation tag of a JPEG,
// so the bounds a caller reads are the displayed size.
func decodeOriented(r io.Reader) (image.Image, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return orient(img, jpegOrientation(data)), nil
}

// jpegOrientation reads the EXIF Orientation tag (1–8) from JPEG bytes. It
// returns 1 for a non-JPEG, a missing tag, or a malformed segment.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	p := 2
	for p+4 <= len(data) {
		if data[p] != 0xFF {
			return 1
		}
		marker := data[p+1]
		if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 || marker == 0xFF {
			p += 2
			if marker == 0xFF {
				p--
			}
			continue
		}
		if marker == 0xDA || marker == 0xD9 {
			return 1 // start of scan: no EXIF before the image data
		}
		size := int(binary.BigEndian.Uint16(data[p+2:]))
		if size < 2 || p+2+size > len(data) {
			return 1
		}
		seg := data[p+4 : p+2+size]
		if marker == 0xE1 && len(seg) >= 6 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		p += 2 + size
	}
	return 1
}

// tiffOrientation reads tag 0x0112 from IFD0 of a TIFF header.
func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:]))
	if off < 8 || off+2 > len(t) {
		return 1
	}
	n := int(bo.Uint16(t[off:]))
	for i := 0; i < n; i++ {
		e := off + 2 + i*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:]) != 0x0112 {
			continue
		}
		if v := int(bo.Uint16(t[e+8:])); v >= 1 && v <= 8 {
			return v
		}
		return 1
	}
	return 1
}

// orient returns img turned and flipped as EXIF orientation o asks.
func orient(img image.Image, o int) image.Image {
	if o < 2 || o > 8 {
		return img
	}
	b := img.Bounds()
	src := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(src, src.Bounds(), img, b.Min, draw.Src)
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sx, sy int
			switch o {
			case 2: // mirror horizontal
				sx, sy = w-1-x, y
			case 3: // rotate 180
				sx, sy = w-1-x, h-1-y
			case 4: // mirror vertical
				sx, sy = x, h-1-y
			case 5: // transpose
				sx, sy = y, x
			case 6: // rotate 90 clockwise
				sx, sy = y, h-1-x
			case 7: // transverse
				sx, sy = w-1-y, h-1-x
			case 8: // rotate 90 counter-clockwise
				sx, sy = w-1-y, x
			}
			si := src.PixOffset(sx, sy)
			di := dst.PixOffset(x, y)
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

// encodeJPEG writes img to w as a JPEG at quality (1–100).
func encodeJPEG(w io.Writer, img image.Image, quality int) error {
	return jpeg.Encode(w, img, &jpeg.Options{Quality: quality})
}

// saveJPEG writes img to path as a JPEG at quality.
func saveJPEG(img image.Image, path string, quality int) error {
	var buf bytes.Buffer
	if err := encodeJPEG(&buf, img, quality); err != nil {
		return err
	}
	// path is composed from the storage root, never request input.
	//nolint:gosec // G703: path is composed from the storage root, not from input
	return os.WriteFile(path, buf.Bytes(), 0644)
}
