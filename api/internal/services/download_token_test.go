package services

import (
	"testing"
	"time"
)

func TestDownloadTokenStore_SingleUse(t *testing.T) {
	s := NewDownloadTokenStore()

	tok, err := s.Issue(7, "backup_x.tar.gz")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	uid, file, ok := s.Consume(tok)
	if !ok || uid != 7 || file != "backup_x.tar.gz" {
		t.Fatalf("first Consume: got (%d,%q,%v), want (7,backup_x.tar.gz,true)", uid, file, ok)
	}

	// A token works exactly once.
	if _, _, ok := s.Consume(tok); ok {
		t.Fatal("second Consume of the same token should fail")
	}
}

func TestDownloadTokenStore_Invalid(t *testing.T) {
	s := NewDownloadTokenStore()
	if _, _, ok := s.Consume(""); ok {
		t.Fatal("empty token should never validate")
	}
	if _, _, ok := s.Consume("deadbeef"); ok {
		t.Fatal("unknown token should never validate")
	}
}

func TestDownloadTokenStore_EvictsExpiredOnIssue(t *testing.T) {
	s := NewDownloadTokenStore()

	// An old token that is already past its expiry.
	stale, err := s.Issue(1, "old.tar.gz")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	s.mu.Lock()
	e := s.tokens[stale]
	e.expires = time.Now().Add(-time.Second)
	s.tokens[stale] = e
	s.mu.Unlock()

	// Issuing another token opportunistically evicts the expired entry.
	if _, err := s.Issue(2, "new.tar.gz"); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	s.mu.Lock()
	_, present := s.tokens[stale]
	s.mu.Unlock()
	if present {
		t.Fatal("expired token should have been evicted on the next Issue")
	}
}

func TestDownloadTokenStore_Expiry(t *testing.T) {
	s := NewDownloadTokenStore()
	tok, err := s.Issue(1, "b.tar.gz")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	// Force the entry to be already expired.
	s.mu.Lock()
	e := s.tokens[tok]
	e.expires = time.Now().Add(-time.Second)
	s.tokens[tok] = e
	s.mu.Unlock()

	if _, _, ok := s.Consume(tok); ok {
		t.Fatal("expired token should not validate")
	}
}
