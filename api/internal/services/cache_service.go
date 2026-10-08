package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"point-api/internal/metrics"

	"golang.org/x/sync/singleflight"
)

// tmpPrefix marks the half-written files Set leaves in the cache directory for
// the instant between create and rename. It starts with a dot so it sorts away
// from real keys, and nothing composes a key that begins with it.
const tmpPrefix = ".tmp-"

// DefaultBudgetMB is the cache directory's size ceiling when the operator sets
// none. A rendered page payload is tens of kilobytes, so 64 MB holds several
// hundred entries — far more than a blog's live key set — while costing a
// quarter of a percent of a 25 GB root volume. That volume is the reason there
// is a ceiling at all: nothing else evicts, so an unbounded cache is a slow
// leak with the whole host downstream of it.
const DefaultBudgetMB = 64

// tmpMaxAge is how long a leftover temp file is tolerated before a sweep
// collects it. Set writes and renames within one call, so anything this old
// belongs to a process that died mid-write; the margin is generous because
// deleting a temp file another process is still writing to would cost it its
// entry.
const tmpMaxAge = time.Hour

// sweepEvery is how much of the budget may be written between directory scans
// (one tenth), and sweepTargetPct is how far below the budget a scan cuts the
// cache back to.
//
// The gap between them is what makes the budget a real ceiling rather than a
// line the cache crosses and then notices: a sweep leaves the directory at 80%,
// and no more than a tenth of the budget plus one entry can be added before the
// next one runs. That holds as long as a single entry is smaller than a tenth
// of the budget — a rendered page is tens of kilobytes against a budget in
// megabytes, so it is not close.
//
// Cutting back to 80% rather than to the budget itself is also what keeps a
// warm cache from sweeping on every write.
const (
	sweepEvery     = 10
	sweepTargetPct = 80
)

type CacheService struct {
	cacheDir string

	// flight coalesces the renders behind GetOrRender, keyed by cache key.
	flight singleflight.Group

	// maxBytes is the directory's size ceiling; 0 disables eviction entirely.
	maxBytes int64

	// mu guards sinceSweep and serialises sweeps, so concurrent Sets scan the
	// directory once between them rather than each racing the others' deletes.
	mu sync.Mutex
	// sinceSweep counts bytes written since the last sweep. It starts at the
	// budget so the first Set after a restart always sweeps — otherwise a
	// directory left oversized by a crash, or by the operator lowering the
	// budget, would sit there until a tenth of a budget had been rewritten.
	sinceSweep int64

	// metrics counts cache outcomes. Nil is valid and counts nothing, which is
	// what METRICS_ENABLED=false leaves here.
	metrics *metrics.Registry
}

// WithMetrics attaches the metrics registry so page-cache effectiveness is
// visible. GetOrRender records the hit and the miss; a render that was never
// cacheable never reaches it, so the caller reports that one through
// NoteBypass.
func (s *CacheService) WithMetrics(m *metrics.Registry) *CacheService {
	s.metrics = m
	return s
}

// NoteBypass records a public page render that was not eligible for the cache
// at all. It is worth separating from a miss: a rising bypass rate means more
// requests are being routed around the cache, a rising miss rate means the
// cache is not holding what it is asked for.
func (s *CacheService) NoteBypass() {
	if s == nil {
		return
	}
	s.metrics.PageCache(metrics.CacheBypass)
}

func NewCacheService(dataPath string) *CacheService {
	cacheDir := filepath.Join(dataPath, "cache")
	_ = os.MkdirAll(cacheDir, 0755)
	s := &CacheService{cacheDir: cacheDir}
	return s.WithBudgetMB(DefaultBudgetMB)
}

// WithBudgetMB sets the cache directory's size ceiling in megabytes. A
// non-positive value turns eviction off, which is only sane where the volume
// is not shared with anything that matters.
func (s *CacheService) WithBudgetMB(mb int) *CacheService {
	s.mu.Lock()
	defer s.mu.Unlock()
	if mb <= 0 {
		s.maxBytes = 0
		return s
	}
	s.maxBytes = int64(mb) * 1024 * 1024
	s.sinceSweep = s.maxBytes
	return s
}

func (s *CacheService) validateKey(key string) error {
	if key == "." || strings.Contains(key, "..") || strings.ContainsAny(key, "/\\") {
		return wrapKind(ErrInvalidInput, errors.New("invalid cache key"))
	}
	return nil
}

func (s *CacheService) Get(ctx context.Context, key string) ([]byte, error) {
	if err := s.validateKey(key); err != nil {
		return nil, err
	}
	path := filepath.Join(s.cacheDir, key)
	_, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		_ = os.Remove(path)
		return nil, fmt.Errorf("cache file empty")
	}
	return data, nil
}

// Set writes a cache entry atomically: into a sibling temp file, then rename.
//
// os.WriteFile truncates the live path before it writes, so a reader arriving
// mid-write on a hot key — the home feed and the tag archives are shared by
// every anonymous visitor — could read a prefix of the payload and serve it as
// application/json. The zero-length case was caught; a truncated one was not,
// and it surfaces as an intermittent SPA parse error on a page that works on
// reload. Rename is atomic within a filesystem, so a reader sees either the
// whole previous entry or the whole new one.
func (s *CacheService) Set(ctx context.Context, key string, data []byte) (err error) {
	if err := s.validateKey(key); err != nil {
		return err
	}
	path := filepath.Join(s.cacheDir, key)

	f, err := os.CreateTemp(s.cacheDir, tmpPrefix+"*")
	if err != nil {
		return err
	}
	tmpPath := f.Name()
	// One cleanup path for every way the write can fail: close the handle, keep
	// the first error, and leave nothing behind. A successful rename has already
	// moved tmpPath away. The sweep collects temp files too, but only ones old
	// enough to be certain their writer is gone — this is what keeps the common
	// failure from waiting an hour for that.
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	// CreateTemp opens at 0600; cache entries have always been world-readable.
	if err = f.Chmod(0644); err != nil {
		return err
	}
	if err = os.Rename(tmpPath, path); err != nil {
		return err
	}
	s.noteWrite(int64(len(data)))
	return nil
}

// noteWrite charges n bytes against the sweep allowance and runs a sweep once
// the allowance is spent.
//
// Set is the only growth path, so it is also the only place eviction has to
// hook into; hanging it off a timer would mean a goroutine per instance doing
// nothing on a quiet blog. The scan is O(entries) and runs once per
// budget/sweepEvery bytes written, so a hot cache pays it rarely and an idle
// one never.
func (s *CacheService) noteWrite(n int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.maxBytes == 0 {
		return
	}
	s.sinceSweep += n
	if s.sinceSweep < s.maxBytes/sweepEvery {
		return
	}
	s.sinceSweep = 0
	if err := s.sweepLocked(); err != nil {
		slog.Warn("page cache sweep failed", "error", err)
	}
}

// sweepLocked deletes oldest-first until the directory is back under
// sweepTargetPct of the budget, and collects temp files a crashed write left
// behind.
//
// Oldest-by-mtime is a coarse stand-in for least-recently-used: entries are
// written once and never touched again, so mtime is really "least recently
// rendered". That is the right thing to drop anyway — an entry nobody has
// re-rendered since the last invalidation is one nobody is asking for, and a
// wrong eviction costs a single re-render, not a wrong answer.
func (s *CacheService) sweepLocked() error {
	entries, err := os.ReadDir(s.cacheDir)
	if err != nil {
		return err
	}

	type entry struct {
		name    string
		size    int64
		modTime time.Time
	}
	files := make([]entry, 0, len(entries))
	var total int64
	var firstErr error
	cutoff := time.Now().Add(-tmpMaxAge)

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // vanished under us; nothing to account for
		}
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			if info.ModTime().Before(cutoff) {
				if err := os.Remove(filepath.Join(s.cacheDir, e.Name())); err != nil && firstErr == nil {
					firstErr = err
				}
			}
			continue
		}
		files = append(files, entry{e.Name(), info.Size(), info.ModTime()})
		total += info.Size()
	}

	// Against the target, not the budget: stopping at the budget would leave the
	// directory sitting on the ceiling, and the next tenth of a budget written
	// between sweeps would go straight through it.
	target := s.maxBytes / 100 * sweepTargetPct
	if total <= target {
		return firstErr
	}

	sort.Slice(files, func(i, j int) bool { return files[i].modTime.Before(files[j].modTime) })
	evicted := 0
	for _, f := range files {
		if total <= target {
			break
		}
		if err := os.Remove(filepath.Join(s.cacheDir, f.name)); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		total -= f.size
		evicted++
	}
	slog.Info("page cache evicted", "entries", evicted, "bytes_remaining", total, "budget", s.maxBytes)
	return firstErr
}

func (s *CacheService) Invalidate(ctx context.Context, key string) error {
	if err := s.validateKey(key); err != nil {
		return err
	}
	path := filepath.Join(s.cacheDir, key)
	return os.Remove(path)
}

// Clear empties the cache, keeping the directory itself. Removing the
// directory would leave every subsequent Set writing into a path that no longer
// exists — and since callers discard Set's error, caching would silently stay
// off until the next restart.
func (s *CacheService) Clear(ctx context.Context) error {
	entries, err := os.ReadDir(s.cacheDir)
	if err != nil {
		if os.IsNotExist(err) {
			return os.MkdirAll(s.cacheDir, 0755)
		}
		return err
	}
	var firstErr error
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(s.cacheDir, e.Name())); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	// The directory is empty, so the next Set starts the sweep allowance over
	// rather than paying for a scan it cannot possibly need.
	s.mu.Lock()
	s.sinceSweep = 0
	s.mu.Unlock()
	return firstErr
}

// InvalidatePublicPages drops every cached public payload after a write that
// could change what a guest sees.
//
// It is deliberately all-or-nothing. Every entry in this cache — the home feed
// pages, the tag archives, feed.xml, sitemap.xml — is derived from which posts
// are publicly visible, and the keys are per page *and* per `per_page` (which
// is device-fit, so the key space is wide even after bucketing). There is no way
// to map "post 244 became hidden" back to the handful of keys that mentioned it,
// and serving a post in a list that 404s when opened is a worse outcome than
// re-rendering a few pages.
func (s *CacheService) InvalidatePublicPages(ctx context.Context) error {
	return s.Clear(ctx)
}

func (s *CacheService) GetWithTTL(ctx context.Context, key string, ttl time.Duration) ([]byte, error) {
	if err := s.validateKey(key); err != nil {
		return nil, err
	}
	path := filepath.Join(s.cacheDir, key)
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	if time.Since(info.ModTime()) > ttl {
		_ = os.Remove(path)
		return nil, fmt.Errorf("cache expired")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		_ = os.Remove(path)
		return nil, fmt.Errorf("cache file empty")
	}
	return data, nil
}

// GetOrRender serves key from the cache, calling render at most once per key
// per expiry when the entry is missing or older than ttl.
//
// Without this, a TTL expiry on a hot key is a stampede: the home feed and the
// tag archives are shared by every anonymous visitor, so all of them miss in
// the same instant and every one of them runs the full render — the tag
// snapshot, the recursive tag-tree query, the post list, the media joins, the
// marshal. InvalidatePublicPages compounds it, because one publish drops the
// whole cache and turns every in-flight request into an uncached render at
// once. Coalescing means one render and N-1 short waits instead.
//
// A render failure is returned to every waiter and nothing is cached, so an
// error page never becomes the entry for the next ttl. A failed *write* only
// costs the next reader a re-render, so it is logged rather than returned —
// but it is logged, because discarding it is what let a permanently dead cache
// key go unnoticed.
//
// render receives a context detached from cancellation: the leader is one
// arbitrary request among the waiters, and its client hanging up must not fail
// the responses of everyone queued behind it.
//
// The returned slice is shared by every waiter of the same flight. Callers
// write it to a response; none of them may modify it.
func (s *CacheService) GetOrRender(ctx context.Context, key string, ttl time.Duration, render func(context.Context) ([]byte, error)) ([]byte, error) {
	if data, err := s.GetWithTTL(ctx, key, ttl); err == nil {
		s.metrics.PageCache(metrics.CacheHit)
		return data, nil
	}
	// Counted once per caller, not once per render: the waiters a flight
	// coalesces missed the cache too, and a hit rate that counted only the
	// leader would flatter the cache exactly when it is under load.
	s.metrics.PageCache(metrics.CacheMiss)

	v, err, _ := s.flight.Do(key, func() (any, error) {
		// Look again: a previous flight may have filled the key between this
		// goroutine's miss above and its arrival here, in which case starting a
		// fresh render would defeat the point.
		if data, err := s.GetWithTTL(ctx, key, ttl); err == nil {
			return data, nil
		}

		data, err := render(context.WithoutCancel(ctx))
		if err != nil {
			return nil, err
		}
		if err := s.Set(ctx, key, data); err != nil {
			slog.Warn("page cache write failed", "key", key, "error", err)
		}
		return data, nil
	})
	if err != nil {
		return nil, err
	}
	return v.([]byte), nil
}
