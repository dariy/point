package services

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// downloadTokenTTL is how long an authorized backup-download token stays valid
// after the password has been re-entered.
const downloadTokenTTL = 5 * time.Minute

type downloadToken struct {
	userID   int64
	filename string
	expires  time.Time
}

// DownloadTokenStore issues short-lived, single-use tokens that authorize a
// backup-archive download over a plain GET. The download itself is a browser
// "save to disk" navigation that can't carry a password body, so the password is
// checked once (at Issue time) and exchanged for a token that the GET presents.
// In-memory storage is correct here: the server runs single-instance, like the
// import-job state.
type DownloadTokenStore struct {
	mu     sync.Mutex
	tokens map[string]downloadToken
}

func NewDownloadTokenStore() *DownloadTokenStore {
	return &DownloadTokenStore{tokens: make(map[string]downloadToken)}
}

// Issue mints a token bound to userID and filename, opportunistically evicting
// expired entries.
func (s *DownloadTokenStore) Issue(userID int64, filename string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw)

	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, v := range s.tokens {
		if now.After(v.expires) {
			delete(s.tokens, k)
		}
	}
	s.tokens[token] = downloadToken{userID: userID, filename: filename, expires: now.Add(downloadTokenTTL)}
	return token, nil
}

// Consume validates and removes a token, returning the user and filename it
// authorizes. A token works exactly once and only before it expires.
func (s *DownloadTokenStore) Consume(token string) (userID int64, filename string, ok bool) {
	if token == "" {
		return 0, "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t, present := s.tokens[token]
	if !present {
		return 0, "", false
	}
	delete(s.tokens, token)
	if time.Now().After(t.expires) {
		return 0, "", false
	}
	return t.userID, t.filename, true
}
