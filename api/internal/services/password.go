package services

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
)

// Argon2id parameters
const (
	argon2Memory      = 64 * 1024 // 64 MB
	argon2Iterations  = 3
	argon2Parallelism = 2
	argon2SaltLength  = 16
	argon2KeyLength   = 32
)

var (
	ErrInvalidHash         = errors.New("the encoded hash is not in the correct format")
	ErrIncompatibleVersion = errors.New("incompatible version of argon2")
)

// hashPasswordArgon2id hashes a password using Argon2id.
// Format: $argon2id$v=19$m=65536,t=3,p=2$salt$hash
func hashPasswordArgon2id(password string) (string, error) {
	salt := make([]byte, argon2SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}

	hash := argon2.IDKey([]byte(password), salt, argon2Iterations, argon2Memory, argon2Parallelism, argon2KeyLength)

	b64Salt := base64.RawStdEncoding.EncodeToString(salt)
	b64Hash := base64.RawStdEncoding.EncodeToString(hash)

	encodedHash := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argon2Memory, argon2Iterations, argon2Parallelism, b64Salt, b64Hash)

	return encodedHash, nil
}

// verifyPasswordArgon2id verifies a password against an Argon2id hash.
func verifyPasswordArgon2id(password, encodedHash string) (bool, error) {
	vals := strings.Split(encodedHash, "$")
	if len(vals) != 6 {
		return false, ErrInvalidHash
	}

	var version int
	_, err := fmt.Sscanf(vals[2], "v=%d", &version)
	if err != nil {
		return false, err
	}
	if version != argon2.Version {
		return false, ErrIncompatibleVersion
	}

	var memory uint32
	var iterations uint32
	var parallelism uint8
	_, err = fmt.Sscanf(vals[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism)
	if err != nil {
		return false, err
	}

	salt, err := base64.RawStdEncoding.DecodeString(vals[4])
	if err != nil {
		return false, err
	}

	hash, err := base64.RawStdEncoding.DecodeString(vals[5])
	if err != nil {
		return false, err
	}

	comparisonHash := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(hash)))

	return subtle.ConstantTimeCompare(hash, comparisonHash) == 1, nil
}

// HashPassword hashes a password using the current preferred algorithm (Argon2id).
func HashPassword(password string) (string, error) {
	return hashPasswordArgon2id(password)
}

// VerifyPassword verifies a password against a hash (supports Argon2id and bcrypt).
func VerifyPassword(password, hash string) bool {
	if strings.HasPrefix(hash, "$argon2id$") {
		match, err := verifyPasswordArgon2id(password, hash)
		if err != nil {
			return false
		}
		return match
	}

	// Fallback to bcrypt
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// IsBcryptHash returns true if the hash is a bcrypt hash.
func IsBcryptHash(hash string) bool {
	return strings.HasPrefix(hash, "$2a$") || strings.HasPrefix(hash, "$2b$") || strings.HasPrefix(hash, "$2y$")
}
