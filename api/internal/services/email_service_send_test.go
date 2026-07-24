package services

import (
	"bufio"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeSMTP is a minimal in-process SMTP server: enough of the protocol to let
// net/smtp complete a cleartext exchange (or be refused before one). It never
// advertises STARTTLS, so it doubles as the downgrade-attack stand-in.
type fakeSMTP struct {
	ln       net.Listener
	mu       sync.Mutex
	received string // the DATA payload of the last accepted message
	gotRcpt  string // the argument of the last RCPT TO command
}

func newFakeSMTP(t *testing.T) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	s := &fakeSMTP{ln: ln}
	go s.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeSMTP) addr() string { return s.ln.Addr().String() }

func (s *fakeSMTP) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *fakeSMTP) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	w := bufio.NewWriter(conn)
	r := bufio.NewReader(conn)
	write := func(line string) {
		_, _ = w.WriteString(line + "\r\n")
		_ = w.Flush()
	}

	write("220 fake ESMTP")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimRight(line, "\r\n")
		upper := strings.ToUpper(cmd)
		switch {
		case strings.HasPrefix(upper, "EHLO"), strings.HasPrefix(upper, "HELO"):
			// Deliberately omit STARTTLS from the extension list.
			write("250-fake greets you")
			write("250 8BITMIME")
		case strings.HasPrefix(upper, "MAIL FROM"):
			write("250 OK")
		case strings.HasPrefix(upper, "RCPT TO"):
			s.mu.Lock()
			s.gotRcpt = cmd
			s.mu.Unlock()
			write("250 OK")
		case upper == "DATA":
			write("354 End data with <CR><LF>.<CR><LF>")
			var body strings.Builder
			for {
				dl, derr := r.ReadString('\n')
				if derr != nil {
					return
				}
				if dl == ".\r\n" || dl == ".\n" {
					break
				}
				body.WriteString(dl)
			}
			s.mu.Lock()
			s.received = body.String()
			s.mu.Unlock()
			write("250 OK: queued")
		case upper == "QUIT":
			write("221 Bye")
			return
		default:
			write("250 OK")
		}
	}
}

// A local host bypasses the STARTTLS requirement, so the full cleartext send
// path (dial → HELO → MAIL/RCPT/DATA → QUIT) runs against the fake server.
func TestSendSTARTTLSLocalCleartextPath(t *testing.T) {
	srv := newFakeSMTP(t)

	msg := []byte("Subject: Hi\r\n\r\nhello body\r\n")
	err := sendSTARTTLS("localhost", srv.addr(), nil, "from@example.com", "to@example.com", msg)
	require.NoError(t, err)

	srv.mu.Lock()
	defer srv.mu.Unlock()
	assert.Contains(t, srv.gotRcpt, "to@example.com")
	assert.Contains(t, srv.received, "hello body")
}

// A non-local host whose server never advertises STARTTLS must be refused
// rather than downgraded to cleartext.
func TestSendSTARTTLSRefusesCleartextForRemoteHost(t *testing.T) {
	srv := newFakeSMTP(t)

	msg := []byte("Subject: Hi\r\n\r\nbody\r\n")
	err := sendSTARTTLS("smtp.example.test", srv.addr(), nil, "from@example.com", "to@example.com", msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "does not advertise STARTTLS")

	srv.mu.Lock()
	defer srv.mu.Unlock()
	assert.Empty(t, srv.received, "no message should be transmitted when STARTTLS is refused")
}

// A dial failure surfaces as an error instead of a panic.
func TestSendSTARTTLSDialError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	_ = ln.Close() // nothing is listening now

	err = sendSTARTTLS("localhost", addr, nil, "from@example.com", "to@example.com", []byte("x"))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SMTP dial")
}

// SendEmail's happy path wires the recipient, header, and body through to the
// server when pointed at a local relay on a non-465 port.
func TestSendEmailDeliversToLocalRelay(t *testing.T) {
	srv := newFakeSMTP(t)
	host, portStr, err := net.SplitHostPort(srv.addr())
	require.NoError(t, err)
	port := mustAtoi(t, portStr)

	cfg := SMTPConfig{Host: host, Port: port, From: "Sender <sender@example.com>"}
	err = SendEmail(cfg, "Recipient <rcpt@example.com>", "Greetings", "line one\nline two")
	require.NoError(t, err)

	srv.mu.Lock()
	defer srv.mu.Unlock()
	// Envelope uses the bare address; header keeps the display form.
	assert.Contains(t, srv.gotRcpt, "rcpt@example.com")
	assert.Contains(t, srv.received, "Subject: Greetings")
	assert.Contains(t, srv.received, "To: Recipient <rcpt@example.com>")
	// Bare LF in the body was normalized to CRLF.
	assert.Contains(t, srv.received, "line one\r\nline two")
}

func TestSendEmailMissingHost(t *testing.T) {
	err := SendEmail(SMTPConfig{}, "to@example.com", "Hi", "body")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SMTP not configured")
}

func mustAtoi(t *testing.T, s string) int {
	t.Helper()
	n := 0
	for _, c := range s {
		require.True(t, c >= '0' && c <= '9', "non-numeric port %q", s)
		n = n*10 + int(c-'0')
	}
	return n
}
