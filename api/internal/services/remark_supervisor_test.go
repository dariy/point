package services

import (
	"slices"
	"testing"
)

func TestSMTPEnvFallback(t *testing.T) {
	getenv := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}

	if got := smtpEnvFallback(getenv(nil)); got != nil {
		t.Errorf("no SMTP_HOST: want nil, got %v", got)
	}

	got := smtpEnvFallback(getenv(map[string]string{
		"SMTP_HOST":     "smtp.mailgun.org",
		"SMTP_USERNAME": "postmaster@example.com",
		"SMTP_PASSWORD": "secret",
	}))
	want := []string{
		"SMTP_HOST=smtp.mailgun.org",
		"SMTP_PORT=587",
		"SMTP_USERNAME=postmaster@example.com",
		"SMTP_PASSWORD=secret",
		"SMTP_STARTTLS=true",
		"AUTH_EMAIL_FROM=postmaster@example.com", // falls back to username
	}
	if !slices.Equal(got, want) {
		t.Errorf("587 defaults:\n got %v\nwant %v", got, want)
	}

	got = smtpEnvFallback(getenv(map[string]string{
		"SMTP_HOST": "mail.example.com",
		"SMTP_PORT": "465",
		"SMTP_FROM": "blog@example.com",
	}))
	if !slices.Contains(got, "SMTP_TLS=true") || slices.Contains(got, "SMTP_STARTTLS=true") {
		t.Errorf("port 465 should use implicit TLS, got %v", got)
	}
	if !slices.Contains(got, "AUTH_EMAIL_FROM=blog@example.com") {
		t.Errorf("SMTP_FROM should win over username, got %v", got)
	}
}
