// Package transport maintains the controller's outbound connection to the
// gateway: a minimal std-lib RFC 6455 WebSocket client over TLS (wss),
// challenge/response auth per proto/pairing.md, jittered reconnect backoff,
// and an HTTPS long-poll fallback. No third-party dependencies — the frame
// codec below implements exactly the client side this agent needs.
package transport

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WSConn is a client WebSocket connection (text messages).
type WSConn struct {
	conn net.Conn
	br   *bufio.Reader
}

// NewWSConn wraps an already-upgraded connection (used by the fake-gateway
// test server; the reader tolerates masked and unmasked frames alike).
func NewWSConn(conn net.Conn) *WSConn {
	return &WSConn{conn: conn, br: bufio.NewReader(conn)}
}

// DialWS dials a ws:// or wss:// URL and completes the RFC 6455 handshake.
// ws:// is permitted only when allowInsecure (tests/dev).
func DialWS(ctx context.Context, wsURL string, allowInsecure bool) (*WSConn, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}
	var d net.Dialer
	host := u.Host
	var conn net.Conn
	switch u.Scheme {
	case "wss":
		if u.Port() == "" {
			host = net.JoinHostPort(u.Hostname(), "443")
		}
		raw, err := d.DialContext(ctx, "tcp", host)
		if err != nil {
			return nil, err
		}
		tc := tls.Client(raw, &tls.Config{ServerName: u.Hostname()})
		if err := tc.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		conn = tc
	case "ws":
		if !allowInsecure {
			return nil, fmt.Errorf("transport: ws:// refused (wss only)")
		}
		if u.Port() == "" {
			host = net.JoinHostPort(u.Hostname(), "80")
		}
		conn, err = d.DialContext(ctx, "tcp", host)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("transport: unsupported scheme %q", u.Scheme)
	}

	keyRaw := make([]byte, 16)
	if _, err := rand.Read(keyRaw); err != nil {
		conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyRaw)
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
		path, u.Host, key)
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	} else {
		conn.SetDeadline(time.Now().Add(15 * time.Second))
	}
	if _, err := io.WriteString(conn, req); err != nil {
		conn.Close()
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodGet})
	if err != nil {
		conn.Close()
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		return nil, fmt.Errorf("transport: upgrade refused: %s", resp.Status)
	}
	want := wsAccept(key)
	if resp.Header.Get("Sec-WebSocket-Accept") != want ||
		!strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
		conn.Close()
		return nil, fmt.Errorf("transport: bad upgrade response")
	}
	conn.SetDeadline(time.Time{})
	return &WSConn{conn: conn, br: br}, nil
}

// WSAccept computes the Sec-WebSocket-Accept for a key (exported for the
// fake-gateway test server).
func wsAccept(key string) string {
	h := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}

// WSAccept is the server-side accept-key helper (tests).
func WSAccept(key string) string { return wsAccept(key) }

// ReadMessage returns the next data message payload, transparently handling
// ping (answers pong), pong, continuation frames, and close (io.EOF).
func (c *WSConn) ReadMessage() ([]byte, error) {
	var msg []byte
	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			return nil, err
		}
		switch opcode {
		case 0x1, 0x2: // text/binary
			msg = payload
		case 0x0: // continuation
			msg = append(msg, payload...)
		case 0x8: // close
			_ = c.writeFrame(0x8, nil)
			return nil, io.EOF
		case 0x9: // ping → pong
			if err := c.writeFrame(0xA, payload); err != nil {
				return nil, err
			}
			continue
		case 0xA: // pong
			continue
		default:
			return nil, fmt.Errorf("transport: unknown opcode %d", opcode)
		}
		if fin {
			return msg, nil
		}
	}
}

func (c *WSConn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return
	}
	fin = hdr[0]&0x80 != 0
	if hdr[0]&0x70 != 0 {
		return false, 0, nil, fmt.Errorf("transport: nonzero RSV bits")
	}
	opcode = hdr[0] & 0x0F
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 1<<20 {
		return false, 0, nil, fmt.Errorf("transport: frame too large (%d)", length)
	}
	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, maskKey[:]); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return fin, opcode, payload, nil
}

// WriteMessage sends payload as one masked text frame (client → server).
func (c *WSConn) WriteMessage(payload []byte) error {
	return c.writeFrame(0x1, payload)
}

func (c *WSConn) writeFrame(opcode byte, payload []byte) error {
	var maskKey [4]byte
	if _, err := rand.Read(maskKey[:]); err != nil {
		return err
	}
	hdr := []byte{0x80 | opcode}
	n := len(payload)
	switch {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n <= 0xFFFF:
		hdr = append(hdr, 0x80|126)
		hdr = binary.BigEndian.AppendUint16(hdr, uint16(n))
	default:
		hdr = append(hdr, 0x80|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	hdr = append(hdr, maskKey[:]...)
	masked := make([]byte, n)
	for i, b := range payload {
		masked[i] = b ^ maskKey[i%4]
	}
	if _, err := c.conn.Write(append(hdr, masked...)); err != nil {
		return err
	}
	return nil
}

// SetReadDeadline bounds the next read.
func (c *WSConn) SetReadDeadline(t time.Time) error { return c.conn.SetReadDeadline(t) }

// Close sends a close frame and tears the connection down.
func (c *WSConn) Close() error {
	_ = c.writeFrame(0x8, nil)
	return c.conn.Close()
}
