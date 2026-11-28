package services

import (
	"image"
	"image/color"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// phashFixtures are in testdata/phash. a.* and b.* are each one picture in
// several forms: a.jpg (480×360 JPEG), a-small.jpg (200×150 JPEG, quality
// 60) and a.webp (320×240 lossy WebP from cwebp). c.jpg to f.jpg are other
// pictures, one form each.
func loadPhashFixture(t *testing.T, name string) image.Image {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "phash", name))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	img, err := decodeOriented(f)
	if err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	return img
}

func TestPerceptualHash_Fixtures(t *testing.T) {
	names := []string{"a.jpg", "a-small.jpg", "a.webp", "b.jpg", "b-small.jpg", "b.webp", "c.jpg", "d.jpg", "e.jpg", "f.jpg"}
	hashes := map[string]int64{}
	for _, n := range names {
		hashes[n] = int64(perceptualHash(loadPhashFixture(t, n)))
	}
	picture := func(n string) string { return strings.SplitN(strings.TrimSuffix(n, filepath.Ext(n)), "-", 2)[0] }
	for i, x := range names {
		for _, y := range names[i+1:] {
			d := phashDistance(hashes[x], hashes[y])
			same := picture(x) == picture(y)
			if same && d > PhashMaxDistance {
				t.Errorf("%s and %s are one picture, but the distance is %d (max %d)", x, y, d, PhashMaxDistance)
			}
			if !same && d <= PhashMaxDistance {
				t.Errorf("%s and %s are different pictures, but the distance is %d (max %d)", x, y, d, PhashMaxDistance)
			}
		}
	}
}

func TestPerceptualHash_Orientation(t *testing.T) {
	src := loadPhashFixture(t, "c.jpg")
	// orient with tag 8 turns the picture one way, and tag 6 turns it back.
	// The hash reads the pixels as they are, so the turned-back copy has the
	// hash of the source.
	turned := orient(src, 8)
	back := orient(turned, 6)
	if d := phashDistance(int64(perceptualHash(src)), int64(perceptualHash(back))); d != 0 {
		t.Fatalf("distance after a turn and a turn back = %d, want 0", d)
	}
}

func TestPerceptualHash_TinyAndFlatImages(t *testing.T) {
	tiny := image.NewRGBA(image.Rect(0, 0, 1, 1))
	tiny.Set(0, 0, color.White)
	if got := perceptualHash(tiny); got != 0 {
		t.Errorf("1×1 image hash = %#x, want 0", got)
	}
	if got := perceptualHash(image.NewRGBA(image.Rect(0, 0, 0, 0))); got != 0 {
		t.Errorf("empty image hash = %#x, want 0", got)
	}
	if got := phashValue(nil); got.Valid {
		t.Errorf("phashValue(nil) is valid: %+v", got)
	}
}

func TestGroupByPhash(t *testing.T) {
	near := int64(0x0F0F0F0F0F0F0F0F)
	entries := []phashEntry{
		{1, near},
		{2, 0x7777777777777777},
		{3, near ^ 0b111},              // 3 bits from 1
		{4, 0x7777777777777777 ^ 0xFF}, // 8 bits from 2
		{5, int64(^uint64(near))},      // far from everything
		{6, near ^ 0b111 ^ 0xF0000},    // 4 bits from 3, 7 bits from 1
	}
	got := groupByPhash(entries)
	want := [][]int64{{1, 3, 6}, {2, 4}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if got := groupByPhash(entries[:1]); got != nil {
		t.Fatalf("one entry gives groups %v, want none", got)
	}
}
