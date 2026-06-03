package services

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/smtp"
	"strings"
)

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

// SendEmail sends a plain-text email via SMTP.
// Port 465 uses implicit TLS; port 587 uses STARTTLS; others use plain SMTP.
func SendEmail(cfg SMTPConfig, to, subject, body string) error {
	if cfg.Host == "" {
		return fmt.Errorf("SMTP not configured: set SMTP_HOST in your .env file")
	}

	header := strings.Join([]string{
		"From: " + sanitizeHeader(cfg.From),
		"To: " + sanitizeHeader(to),
		"Subject: " + sanitizeHeader(subject),
		"Content-Type: text/plain; charset=UTF-8",
		"",
		"",
	}, "\r\n")
	msg := []byte(header + body)

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)

	var auth smtp.Auth
	if cfg.Username != "" {
		auth = smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
	}

	if cfg.Port == 465 {
		return sendImplicitTLS(cfg.Host, addr, auth, cfg.From, to, msg)
	}
	return sendSTARTTLS(cfg.Host, addr, auth, cfg.From, to, msg)
}

func sendImplicitTLS(host, addr string, auth smtp.Auth, from, to string, msg []byte) error {
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: host})
	if err != nil {
		return fmt.Errorf("SMTP TLS dial: %w", err)
	}
	defer func() { _ = conn.Close() }()

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
	c, err := smtp.Dial(addr)
	if err != nil {
		return fmt.Errorf("SMTP dial: %w", err)
	}
	defer func() { _ = c.Close() }()

	// Use STARTTLS when connecting to a non-local host.
	if h, _, _ := net.SplitHostPort(addr); h != "localhost" && h != "127.0.0.1" {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err = c.StartTLS(&tls.Config{ServerName: host}); err != nil {
				return fmt.Errorf("SMTP STARTTLS: %w", err)
			}
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
	return w.Close()
}
