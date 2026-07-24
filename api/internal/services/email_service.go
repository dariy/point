package services

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/mail"
	"net/smtp"
	"strings"
	"time"
)

// smtpTimeout bounds the whole SMTP exchange so a blackholed host can never
// block a request handler indefinitely.
const smtpTimeout = 30 * time.Second

type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
}

func sanitizeHeader(v string) string {
	v = strings.ReplaceAll(v, "\r", "")
	v = strings.ReplaceAll(v, "\n", "")
	return v
}

// envelopeAddr reduces a From value like `Name <user@host>` to the bare
// address the SMTP envelope requires — smtp.Client.Mail wraps its argument
// in MAIL FROM:<...> verbatim, so a display name there is a syntax error.
func envelopeAddr(from string) string {
	if a, err := mail.ParseAddress(from); err == nil {
		return a.Address
	}
	return from
}

// isLocalHost reports whether host is a loopback address that we trust to
// carry mail in cleartext (e.g. a local relay or test server).
func isLocalHost(host string) bool {
	switch host {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// toCRLF normalizes bare LF line endings to CRLF, which strict SMTP servers
// require in message data.
func toCRLF(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\n", "\r\n")
}

// SendEmail sends a plain-text email via SMTP.
// Port 465 uses implicit TLS; port 587 uses STARTTLS; others use plain SMTP.
func SendEmail(cfg SMTPConfig, to, subject, body string) error {
	if cfg.Host == "" {
		return fmt.Errorf("SMTP not configured: set SMTP_HOST in your .env file")
	}

	// Parse the recipient up front: the bare .Address goes into the RCPT TO
	// envelope command (Go does not strip CRLF from commands, so a raw string
	// here is an SMTP injection vector), while the header keeps its display
	// form. A malformed address is rejected before we dial.
	rcpt, err := mail.ParseAddress(to)
	if err != nil {
		return fmt.Errorf("invalid recipient address %q: %w", to, err)
	}

	header := strings.Join([]string{
		"From: " + sanitizeHeader(cfg.From),
		"To: " + sanitizeHeader(to),
		"Subject: " + sanitizeHeader(subject),
		"Content-Type: text/plain; charset=UTF-8",
		"",
		"",
	}, "\r\n")
	msg := []byte(header + toCRLF(body))

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

	var auth smtp.Auth
	if cfg.Username != "" {
		auth = smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
	}

	from := envelopeAddr(cfg.From)
	if cfg.Port == 465 {
		return sendImplicitTLS(cfg.Host, addr, auth, from, rcpt.Address, msg)
	}
	return sendSTARTTLS(cfg.Host, addr, auth, from, rcpt.Address, msg)
}

func sendImplicitTLS(host, addr string, auth smtp.Auth, from, to string, msg []byte) error {
	dialer := &net.Dialer{Timeout: smtpTimeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{ServerName: host})
	if err != nil {
		return fmt.Errorf("SMTP TLS dial: %w", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(smtpTimeout))

	c, err := smtp.NewClient(conn, host)
	if err != nil {
		return fmt.Errorf("SMTP client: %w", err)
	}
	defer func() { _ = c.Close() }()

	if auth != nil {
		if err = c.Auth(auth); err != nil {
			return fmt.Errorf("SMTP auth: %w", err)
		}
	}
	return sendData(c, from, to, msg)
}

func sendSTARTTLS(host, addr string, auth smtp.Auth, from, to string, msg []byte) error {
	dialer := &net.Dialer{Timeout: smtpTimeout}
	conn, err := dialer.Dial("tcp", addr)
	if err != nil {
		return fmt.Errorf("SMTP dial: %w", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(smtpTimeout))

	c, err := smtp.NewClient(conn, host)
	if err != nil {
		return fmt.Errorf("SMTP client: %w", err)
	}
	defer func() { _ = c.Close() }()

	// For non-local hosts require STARTTLS: a MITM can strip the advertisement,
	// so a missing extension must be a hard error rather than a cleartext send.
	if !isLocalHost(host) {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("SMTP server %q does not advertise STARTTLS; refusing to send in cleartext", host)
		}
		if err = c.StartTLS(&tls.Config{ServerName: host}); err != nil {
			return fmt.Errorf("SMTP STARTTLS: %w", err)
		}
	}

	if auth != nil {
		if err = c.Auth(auth); err != nil {
			return fmt.Errorf("SMTP auth: %w", err)
		}
	}
	return sendData(c, from, to, msg)
}

func sendData(c *smtp.Client, from, to string, msg []byte) error {
	if err := c.Mail(from); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err = w.Write(msg); err != nil {
		return err
	}
	if err = w.Close(); err != nil {
		return err
	}
	// Graceful QUIT surfaces a final server-side rejection that a bare Close
	// would drop.
	return c.Quit()
}
