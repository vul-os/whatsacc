package blesession_test

import (
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/vul-os/whatsacc/controller/internal/blesession"
	"github.com/vul-os/whatsacc/controller/internal/framing"
	"github.com/vul-os/whatsacc/controller/internal/grants"
	"github.com/vul-os/whatsacc/controller/internal/vectorfile"
	"github.com/vul-os/whatsacc/controller/internal/wire"
)

type memConn struct {
	out    [][]byte
	closed bool
}

func (m *memConn) SendMessage(msg []byte) error { m.out = append(m.out, msg); return nil }
func (m *memConn) Close() error                 { m.closed = true; return nil }

func fixture(t *testing.T) (*vectorfile.Vector, func() grants.Env, *grants.Exchange) {
	t.Helper()
	dir, err := vectorfile.FindDir("")
	if err != nil {
		t.Fatal(err)
	}
	f, err := vectorfile.Load(dir, "grants.json")
	if err != nil {
		t.Fatal(err)
	}
	keys, err := vectorfile.LoadKeys(dir)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := wire.DecodePub(keys.Keys["gateway"].PublicKeyB64u)
	if err != nil {
		t.Fatal(err)
	}
	var valid *vectorfile.Vector
	for i := range f.Vectors {
		if f.Vectors[i].Name == "grant-redeem-valid" {
			valid = &f.Vectors[i]
			break
		}
	}
	if valid == nil {
		t.Fatal("grant-redeem-valid fixture missing")
	}
	env := func() grants.Env {
		return grants.Env{
			Now:             valid.Check.Now,
			LastGatewaySync: valid.Check.LastGatewaySync,
			DeviceID:        valid.Check.DeviceID,
			GatewayKey:      pub,
		}
	}
	var ch grants.Challenge
	if err := json.Unmarshal(valid.Transcript.Challenge, &ch); err != nil {
		t.Fatal(err)
	}
	x := grants.NewExchange()
	x.NewCnonce = func() (string, error) { return ch.Cnonce, nil } // deterministic → fixture proof verifies
	return valid, env, x
}

// TestFullSequenceOverMTUs drives grant.open → challenge → grant.proof →
// result through the session at each synthetic MTU, chunked by the real
// framing codec — the exact path the radio layer uses, no radio required.
func TestFullSequenceOverMTUs(t *testing.T) {
	for _, att := range []int{23, 185, 512} {
		usable := att - 3
		valid, env, x := fixture(t)
		conn := &memConn{}
		opened := false
		sess := blesession.New(x, env, conn, func(g *grants.Grant, p *grants.Proof) { opened = true }, nil)

		feed := func(msg []byte, wantDone bool) {
			t.Helper()
			chunks, err := framing.Chunk(msg, usable)
			if err != nil {
				t.Fatal(err)
			}
			done := false
			for _, c := range chunks {
				done = sess.HandleChunk(c)
			}
			if done != wantDone {
				t.Fatalf("mtu %d: done=%v want %v", att, done, wantDone)
			}
		}
		feed(valid.Transcript.Open.Object, false)
		if len(conn.out) != 1 {
			t.Fatalf("mtu %d: expected challenge, got %d msgs", att, len(conn.out))
		}
		var ch grants.Challenge
		if err := json.Unmarshal(conn.out[0], &ch); err != nil || ch.Typ != "grant.challenge" {
			t.Fatalf("mtu %d: bad challenge %s", att, conn.out[0])
		}
		feed(valid.Transcript.Proof.Object, true)
		var res grants.Result
		if err := json.Unmarshal(conn.out[len(conn.out)-1], &res); err != nil || res.Result != "opened" {
			t.Fatalf("mtu %d: bad result %s", att, conn.out[len(conn.out)-1])
		}
		if !opened || !conn.closed {
			t.Fatalf("mtu %d: opened=%v closed=%v", att, opened, conn.closed)
		}
	}
}

// TestProofBeforeOpen: a proof with no preceding open is denied and the
// connection dropped.
func TestProofBeforeOpen(t *testing.T) {
	valid, env, x := fixture(t)
	conn := &memConn{}
	sess := blesession.New(x, env, conn, nil, nil)
	chunks, _ := framing.Chunk(valid.Transcript.Proof.Object, 100)
	done := false
	for _, c := range chunks {
		done = sess.HandleChunk(c)
	}
	if !done || !conn.closed {
		t.Fatal("expected session end")
	}
	var res grants.Result
	if err := json.Unmarshal(conn.out[len(conn.out)-1], &res); err != nil || res.Result != "denied" {
		t.Fatalf("expected denied, got %s", conn.out[len(conn.out)-1])
	}
}

// TestFrameTooLargeDeniesAndDrops: an oversize frame header yields a
// frame_too_large denial and ends the session.
func TestFrameTooLargeDeniesAndDrops(t *testing.T) {
	_, env, x := fixture(t)
	conn := &memConn{}
	sess := blesession.New(x, env, conn, nil, nil)
	hdr := binary.LittleEndian.AppendUint32(nil, framing.MaxFrame+1)
	if done := sess.HandleChunk(hdr); !done {
		t.Fatal("expected done")
	}
	var res grants.Result
	if err := json.Unmarshal(conn.out[len(conn.out)-1], &res); err != nil || res.Detail != "frame_too_large" {
		t.Fatalf("expected frame_too_large, got %s", conn.out[len(conn.out)-1])
	}
	if !conn.closed {
		t.Fatal("connection not dropped")
	}
}

// TestGarbageMessage: a non-JSON frame is denied fail-closed.
func TestGarbageMessage(t *testing.T) {
	_, env, x := fixture(t)
	conn := &memConn{}
	sess := blesession.New(x, env, conn, nil, nil)
	chunks, _ := framing.Chunk([]byte("not json at all"), 100)
	done := false
	for _, c := range chunks {
		done = sess.HandleChunk(c)
	}
	if !done || !conn.closed {
		t.Fatal("expected session end")
	}
	var res grants.Result
	if err := json.Unmarshal(conn.out[len(conn.out)-1], &res); err != nil || res.Result != "denied" {
		t.Fatalf("expected denied, got %s", conn.out[len(conn.out)-1])
	}
}
