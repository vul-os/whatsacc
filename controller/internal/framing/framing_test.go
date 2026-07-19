package framing_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"testing"

	"github.com/vul-os/whatsacc/controller/internal/framing"
)

// synthetic ATT MTUs required by the BLE addendum; usable payload = MTU − 3.
var attMTUs = []int{23, 185, 512}

func roundTrip(t *testing.T, msg []byte, mtu int) {
	t.Helper()
	chunks, err := framing.Chunk(msg, mtu)
	if err != nil {
		t.Fatalf("chunk(mtu=%d,len=%d): %v", mtu, len(msg), err)
	}
	// Every chunk must respect the MTU; total = header + payload.
	total := 0
	for i, c := range chunks {
		if len(c) > mtu {
			t.Fatalf("chunk %d exceeds mtu: %d > %d", i, len(c), mtu)
		}
		if i < len(chunks)-1 && len(c) != mtu {
			t.Fatalf("non-final chunk %d not full: %d != %d", i, len(c), mtu)
		}
		total += len(c)
	}
	if total != framing.HeaderSize+len(msg) {
		t.Fatalf("total bytes %d != header+payload %d", total, framing.HeaderSize+len(msg))
	}
	r := framing.NewReassembler()
	var out [][]byte
	for _, c := range chunks {
		msgs, err := r.Push(c)
		if err != nil {
			t.Fatalf("push: %v", err)
		}
		out = append(out, msgs...)
	}
	if len(out) != 1 || !bytes.Equal(out[0], msg) {
		t.Fatalf("round-trip failed: got %d messages", len(out))
	}
	if r.Partial() {
		t.Fatal("reassembler left partial after complete frame")
	}
}

func TestRoundTripSyntheticMTUs(t *testing.T) {
	sizes := []int{0, 1, 16, 19, 20, 21, 182, 509, 510, 1024, 4096, framing.MaxFrame}
	for _, att := range attMTUs {
		usable := att - 3
		for _, n := range sizes {
			msg := make([]byte, n)
			for i := range msg {
				msg[i] = byte(i * 7)
			}
			t.Run(fmt.Sprintf("mtu%d/size%d", att, n), func(t *testing.T) {
				roundTrip(t, msg, usable)
			})
		}
	}
}

func TestChunkErrors(t *testing.T) {
	if _, err := framing.Chunk(make([]byte, framing.MaxFrame+1), 100); !errors.Is(err, framing.ErrFrameTooLarge) {
		t.Errorf("oversize message: %v", err)
	}
	for _, mtu := range []int{0, 1, 4} {
		if _, err := framing.Chunk([]byte("x"), mtu); err == nil {
			t.Errorf("mtu %d accepted", mtu)
		}
	}
	// mtu 5 (header 4 + 1 byte payload per chunk) must still work.
	roundTripBytes := []byte("hello framing")
	chunks, err := framing.Chunk(roundTripBytes, 5)
	if err != nil {
		t.Fatal(err)
	}
	r := framing.NewReassembler()
	var got []byte
	for _, c := range chunks {
		msgs, err := r.Push(c)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range msgs {
			got = m
		}
	}
	if !bytes.Equal(got, roundTripBytes) {
		t.Fatal("tiny-mtu round trip failed")
	}
}

// TestHeaderSplitAcrossChunks feeds the 4-byte header one byte at a time.
func TestHeaderSplitAcrossChunks(t *testing.T) {
	msg := []byte(`{"v":0}`)
	frame := append(binary.LittleEndian.AppendUint32(nil, uint32(len(msg))), msg...)
	r := framing.NewReassembler()
	var out [][]byte
	for _, b := range frame {
		msgs, err := r.Push([]byte{b})
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, msgs...)
	}
	if len(out) != 1 || !bytes.Equal(out[0], msg) {
		t.Fatal("byte-at-a-time reassembly failed")
	}
}

// TestBackToBackMessagesInOneChunk: two frames concatenated arrive in a
// single push (write-without-response bursts coalesce).
func TestBackToBackMessagesInOneChunk(t *testing.T) {
	m1, m2 := []byte(`{"a":1}`), []byte(`{"b":2,"c":"xyzzy"}`)
	var stream []byte
	for _, m := range [][]byte{m1, m2} {
		stream = append(stream, binary.LittleEndian.AppendUint32(nil, uint32(len(m)))...)
		stream = append(stream, m...)
	}
	r := framing.NewReassembler()
	msgs, err := r.Push(stream)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 || !bytes.Equal(msgs[0], m1) || !bytes.Equal(msgs[1], m2) {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	// Second frame boundary straddling a push.
	r = framing.NewReassembler()
	var out [][]byte
	half := len(m1) // splits mid-way through the first frame's payload
	for _, part := range [][]byte{stream[:half], stream[half:]} {
		msgs, err := r.Push(part)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, msgs...)
	}
	if len(out) != 2 || !bytes.Equal(out[0], m1) || !bytes.Equal(out[1], m2) {
		t.Fatalf("straddled push: expected 2 messages, got %d", len(out))
	}
}

func TestFrameTooLarge(t *testing.T) {
	hdr := binary.LittleEndian.AppendUint32(nil, framing.MaxFrame+1)
	r := framing.NewReassembler()
	if _, err := r.Push(hdr); !errors.Is(err, framing.ErrFrameTooLarge) {
		t.Fatalf("expected ErrFrameTooLarge, got %v", err)
	}
	if r.Partial() {
		t.Fatal("reassembler not reset after frame_too_large")
	}
	// Exactly MaxFrame is fine.
	msg := make([]byte, framing.MaxFrame)
	roundTrip(t, msg, 512)
}

// TestAbortOnNewFrame: a stale partial frame is dropped by Abort and a
// fresh frame decodes cleanly (spec: new frame on rx aborts any partial
// previous frame; the session layer calls Abort on exchange boundaries).
func TestAbortOnNewFrame(t *testing.T) {
	r := framing.NewReassembler()
	// Push a header promising 100 bytes plus only 10 of them.
	partial := append(binary.LittleEndian.AppendUint32(nil, 100), make([]byte, 10)...)
	if msgs, err := r.Push(partial); err != nil || len(msgs) != 0 {
		t.Fatalf("partial push: %v msgs=%d", err, len(msgs))
	}
	if !r.Partial() {
		t.Fatal("expected partial state")
	}
	r.Abort()
	if r.Partial() {
		t.Fatal("Abort did not clear partial state")
	}
	msg := []byte(`{"fresh":true}`)
	frame := append(binary.LittleEndian.AppendUint32(nil, uint32(len(msg))), msg...)
	msgs, err := r.Push(frame)
	if err != nil || len(msgs) != 1 || !bytes.Equal(msgs[0], msg) {
		t.Fatalf("fresh frame after abort failed: %v msgs=%d", err, len(msgs))
	}
	// Without Abort, those 10 stale bytes would corrupt the next frame —
	// prove the partial actually consumes new bytes.
	r2 := framing.NewReassembler()
	_, _ = r2.Push(partial)
	msgs, err = r2.Push(frame)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatal("stale partial unexpectedly completed")
	}
}

func TestZeroLengthMessage(t *testing.T) {
	chunks, err := framing.Chunk(nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 1 || len(chunks[0]) != framing.HeaderSize {
		t.Fatalf("zero-length framing: %d chunks", len(chunks))
	}
	r := framing.NewReassembler()
	msgs, err := r.Push(chunks[0])
	if err != nil || len(msgs) != 1 || len(msgs[0]) != 0 {
		t.Fatalf("zero-length reassembly: %v msgs=%d", err, len(msgs))
	}
}
