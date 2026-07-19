// Package framing implements the BLE GATT frame codec from proto/grants.md
// §Transports: each JSON message is one logical frame — a 4-byte
// little-endian total length, then the UTF-8 JSON bytes — chunked to the
// negotiated ATT MTU across as many writes/notifications as needed. Max
// frame 8 KiB (frame_too_large). A new frame on `rx` aborts any partial
// previous frame (Reassembler.Abort, called by the session layer on state
// transitions/timeouts and on every new connection).
//
// The codec is transport-agnostic and fully unit-tested against synthetic
// MTUs; the radio layer (build tag `ble`) and the sim's in-memory transport
// both sit on top of it.
package framing

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// MaxFrame is the maximum logical frame size (8 KiB).
const MaxFrame = 8 * 1024

// HeaderSize is the 4-byte little-endian length prefix.
const HeaderSize = 4

// ErrFrameTooLarge is returned when a frame header declares more than
// MaxFrame bytes; the session layer maps it to the `frame_too_large` wire
// reason and drops the connection.
var ErrFrameTooLarge = errors.New("framing: frame_too_large")

// Chunk splits one logical message into transport chunks of at most mtu
// bytes each: the first chunk begins with the 4-byte LE length header, the
// JSON bytes follow across chunks. mtu must exceed HeaderSize so the header
// always fits the first chunk whole.
func Chunk(msg []byte, mtu int) ([][]byte, error) {
	if len(msg) > MaxFrame {
		return nil, ErrFrameTooLarge
	}
	if mtu <= HeaderSize {
		return nil, fmt.Errorf("framing: mtu %d too small (need > %d)", mtu, HeaderSize)
	}
	frame := make([]byte, HeaderSize+len(msg))
	binary.LittleEndian.PutUint32(frame, uint32(len(msg)))
	copy(frame[HeaderSize:], msg)
	var chunks [][]byte
	for off := 0; off < len(frame); off += mtu {
		end := off + mtu
		if end > len(frame) {
			end = len(frame)
		}
		chunks = append(chunks, frame[off:end])
	}
	return chunks, nil
}

// Reassembler is the streaming decoder: feed it chunks in arrival order and
// it emits completed messages. It tolerates a header split across chunks
// and multiple messages back-to-back within one chunk.
type Reassembler struct {
	header []byte // partial length header
	want   int    // total payload bytes of the current frame (-1 = no frame)
	buf    []byte // payload accumulated so far
}

// NewReassembler returns an idle reassembler.
func NewReassembler() *Reassembler { return &Reassembler{want: -1} }

// Abort drops any partially-received frame. The session layer calls this
// when a new logical exchange begins (spec: "a new frame on rx aborts any
// partial previous frame") and on connection (re)establishment.
func (r *Reassembler) Abort() {
	r.header = r.header[:0]
	r.want = -1
	r.buf = nil
}

// Partial reports whether a frame is partially received.
func (r *Reassembler) Partial() bool { return r.want >= 0 || len(r.header) > 0 }

// Push consumes one transport chunk and returns any completed messages.
// On ErrFrameTooLarge the reassembler resets itself; the caller must treat
// the stream as broken (reply frame_too_large / drop the connection).
func (r *Reassembler) Push(chunk []byte) ([][]byte, error) {
	var out [][]byte
	data := chunk
	for {
		if r.want < 0 {
			if len(data) == 0 {
				return out, nil
			}
			// Accumulate the 4-byte header (may itself span chunks).
			need := HeaderSize - len(r.header)
			take := min(need, len(data))
			r.header = append(r.header, data[:take]...)
			data = data[take:]
			if len(r.header) < HeaderSize {
				return out, nil
			}
			n := binary.LittleEndian.Uint32(r.header)
			r.header = r.header[:0]
			if n > MaxFrame {
				r.Abort()
				return out, ErrFrameTooLarge
			}
			r.want = int(n)
			r.buf = make([]byte, 0, r.want)
		}
		take := min(r.want-len(r.buf), len(data))
		r.buf = append(r.buf, data[:take]...)
		data = data[take:]
		if len(r.buf) == r.want {
			out = append(out, r.buf)
			r.want = -1
			r.buf = nil
			continue // data may hold the next frame (or be empty)
		}
		return out, nil // mid-frame, wait for more chunks
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
