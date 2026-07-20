// Package events is the controller's durable upstream event queue
// (proto/events.md): signed event envelopes, ring-buffer semantics with
// capacity 10k, oldest-dropped — except grant_redeemed events, which occupy
// a reserved partition and are NEVER dropped before delivery. Drained over
// the WebSocket on reconnect; the gateway dedupes on event_id.
//
// Storage choice (justified): a plain append-only JSONL log per partition
// with an atomically-updated cursor file, compacted opportunistically —
// NOT SQLite. Rationale: the module must be pure std-lib/no-CGO and
// vendorable onto small devices (modernc.org/sqlite is a multi-MB
// transpiled dependency); the write pattern is strictly append + advance
// cursor, which JSONL serves crash-safely (a torn final line is detected
// and truncated on open, everything before it survives kill -9).
package events

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/vul-os/lintel/controller/internal/clock"
	"github.com/vul-os/lintel/controller/internal/wire"
)

const (
	// Capacity is the total ring capacity (proto/events.md: ≥ 10k).
	Capacity = 10000
	// GrantReserved is the reserved partition for grant_redeemed events.
	GrantReserved = 1000
)

// overflowFileName is the last-resort local record for grant_redeemed
// events that could not be enqueued into the reserved partition because it
// is already full — proto/events.md's stated v0 gap: that needs roughly a
// thousand undelivered offline opens to happen, already an extreme,
// extended outage. It is deliberately NOT part of the ring/ack machinery
// above: by the time anything lands here the reserved partition itself has
// already saturated, so folding this into "just more queue" would only
// relocate the same problem, not solve it. Its only job is making sure a
// physical open this extreme still leaves SOME durable trace on the
// device — recoverable from disk by an operator even though it never
// reached the gateway automatically. See agent.OnRedeemed for the
// actuation-safety reasoning this exists to support.
const overflowFileName = "grant_overflow.jsonl"

type entry struct {
	Seq int64           `json:"seq"`
	Raw json.RawMessage `json:"raw"` // signed event envelope, wire JSON
}

// partition is one JSONL log + delivery cursor.
type partition struct {
	path    string
	cursor  string // cursor file path (last delivered seq)
	entries []entry
	nextSeq int64
	deliv   int64 // seqs ≤ deliv are delivered
	f       *os.File
	sync    bool // fsync after each append (see Queue.syncEveryWrite)
}

// Queue is the two-partition durable event queue.
type Queue struct {
	mu           sync.Mutex
	normal       *partition
	grants       *partition
	overflowPath string // last-resort grant_redeemed overflow log; see overflowFileName
	// syncEveryWrite fsyncs after every append (default true): each event
	// — especially grant_redeemed — must survive kill -9 / power loss
	// (load-shedding reality). Bulk perf tests may disable it via
	// SetSyncForTest; production never does.
	syncEveryWrite bool
}

// Open loads (or creates) the queue under dir.
func Open(dir string) (*Queue, error) {
	qdir := filepath.Join(dir, "queue")
	if err := os.MkdirAll(qdir, 0o700); err != nil {
		return nil, err
	}
	n, err := openPartition(filepath.Join(qdir, "events"))
	if err != nil {
		return nil, err
	}
	g, err := openPartition(filepath.Join(qdir, "grants"))
	if err != nil {
		return nil, err
	}
	return &Queue{normal: n, grants: g, overflowPath: filepath.Join(qdir, overflowFileName), syncEveryWrite: true}, nil
}

// SetSyncForTest toggles fsync-per-append. TEST-ONLY: production keeps it on
// (the default) so every event survives power loss.
func (q *Queue) SetSyncForTest(on bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.syncEveryWrite = on
	q.normal.sync = on
	q.grants.sync = on
}

func openPartition(base string) (*partition, error) {
	// deliv = -1 means nothing delivered yet; seq numbering starts at 0, so
	// a 0 default would wrongly treat entry seq 0 as already delivered.
	p := &partition{path: base + ".jsonl", cursor: base + ".cursor", deliv: -1, sync: true}
	if raw, err := os.ReadFile(p.cursor); err == nil {
		fmt.Sscanf(string(raw), "%d", &p.deliv)
	}
	raw, err := os.ReadFile(p.path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	// Replay intact lines; a torn tail (no trailing \n, or corrupt JSON —
	// kill -9 mid-write) is truncated away and everything before survives.
	valid := 0
	for off := 0; off < len(raw); {
		nl := bytes.IndexByte(raw[off:], '\n')
		if nl < 0 {
			break // final line without \n = torn
		}
		line := raw[off : off+nl]
		var e entry
		if json.Unmarshal(line, &e) != nil {
			break // corrupt tail: keep everything before it
		}
		if e.Seq > p.deliv {
			p.entries = append(p.entries, e)
		}
		if e.Seq >= p.nextSeq {
			p.nextSeq = e.Seq + 1
		}
		off += nl + 1
		valid = off
	}
	if valid < len(raw) {
		if err := os.Truncate(p.path, int64(valid)); err != nil {
			return nil, err
		}
	}
	f, err := os.OpenFile(p.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	p.f = f
	return p, nil
}

func (p *partition) append(raw []byte) error {
	e := entry{Seq: p.nextSeq, Raw: raw}
	line, err := json.Marshal(&e)
	if err != nil {
		return err
	}
	if _, err := p.f.Write(append(line, '\n')); err != nil {
		return err
	}
	if p.sync {
		if err := p.f.Sync(); err != nil {
			return err
		}
	}
	p.nextSeq++
	p.entries = append(p.entries, e)
	return nil
}

// Enqueue appends a signed event envelope. kind selects the partition;
// grant_redeemed events are never dropped before delivery (enqueue fails
// when the reserved partition is full of undelivered events); normal events
// drop-oldest when the ring is full.
func (q *Queue) Enqueue(kind string, raw []byte) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if kind == "grant_redeemed" {
		if len(q.grants.entries) >= GrantReserved {
			return fmt.Errorf("events: grant partition full (%d undelivered) — refusing to drop audit events", GrantReserved)
		}
		return q.grants.append(raw)
	}
	if len(q.normal.entries) >= Capacity-GrantReserved {
		q.normal.entries = q.normal.entries[1:] // ring: drop oldest undelivered
		// advance the durable cursor past the dropped entry at next Ack/compact
		if len(q.normal.entries) > 0 && q.normal.entries[0].Seq-1 > q.normal.deliv {
			q.normal.deliv = q.normal.entries[0].Seq - 1
			_ = q.normal.saveCursor()
		}
	}
	return q.normal.append(raw)
}

// EnqueueGrantRedeemed durably records one grant_redeemed event, preferring
// the reserved partition (delivered to the gateway like any other event on
// reconnect, per Drain/Ack above). If — and only if — the reserved
// partition is already full, it falls back to appendOverflow, a minimal
// always-on local overflow log, so the event this call describes is never
// simply discarded. It returns an error only when BOTH the reserved
// partition AND the overflow log fail to accept the write (e.g. the
// filesystem itself is unwritable) — the caller (agent.OnRedeemed) decides
// policy for that case. Per proto/events.md's "reserved partition full"
// gap, this offline-emergency path must not fail-closed on an
// audit-recording failure alone.
func (q *Queue) EnqueueGrantRedeemed(raw []byte) error {
	if err := q.Enqueue("grant_redeemed", raw); err == nil {
		return nil
	}
	return q.appendOverflow(raw)
}

// appendOverflow appends one raw signed event to the overflow log, fsync'd
// like every other durable write in this package. Opened/closed per call
// rather than held open: this path is rare by construction (the reserved
// partition must already be full), so the extra syscalls are immaterial.
func (q *Queue) appendOverflow(raw []byte) error {
	f, err := os.OpenFile(q.overflowPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("events: overflow record failed: %w", err)
	}
	defer f.Close()
	line := append(append([]byte(nil), raw...), '\n')
	if _, err := f.Write(line); err != nil {
		return fmt.Errorf("events: overflow record failed: %w", err)
	}
	return f.Sync()
}

// OverflowEntriesForTest reads back the raw lines written to the overflow
// log. TEST-ONLY (mirrors SetSyncForTest).
func (q *Queue) OverflowEntriesForTest() ([][]byte, error) {
	raw, err := os.ReadFile(q.overflowPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out [][]byte
	for _, line := range bytes.Split(bytes.TrimRight(raw, "\n"), []byte("\n")) {
		if len(line) > 0 {
			out = append(out, line)
		}
	}
	return out, nil
}

// Pending returns up to max undelivered events, grant partition first
// (audit continuity), each with its opaque ack token (seq).
type Pending struct {
	Grant bool
	Seq   int64
	Raw   json.RawMessage
}

// Drain returns undelivered events, grants first.
func (q *Queue) Drain(max int) []Pending {
	q.mu.Lock()
	defer q.mu.Unlock()
	var out []Pending
	for _, e := range q.grants.entries {
		if len(out) >= max {
			return out
		}
		out = append(out, Pending{Grant: true, Seq: e.Seq, Raw: e.Raw})
	}
	for _, e := range q.normal.entries {
		if len(out) >= max {
			return out
		}
		out = append(out, Pending{Grant: false, Seq: e.Seq, Raw: e.Raw})
	}
	return out
}

// Ack marks an event delivered; durable (cursor file, atomic rename).
func (q *Queue) Ack(p Pending) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	part := q.normal
	if p.Grant {
		part = q.grants
	}
	for i, e := range part.entries {
		if e.Seq == p.Seq {
			part.entries = append(part.entries[:i], part.entries[i+1:]...)
			break
		}
	}
	if p.Seq > part.deliv {
		part.deliv = p.Seq
	}
	return part.saveCursor()
}

func (p *partition) saveCursor() error {
	tmp := p.cursor + ".tmp"
	if err := os.WriteFile(tmp, []byte(fmt.Sprintf("%d\n", p.deliv)), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.cursor)
}

// Len reports undelivered (normal, grant) counts.
func (q *Queue) Len() (normal, grant int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.normal.entries), len(q.grants.entries)
}

// Compact rewrites the logs keeping only undelivered entries (called
// opportunistically after big drains).
func (q *Queue) Compact() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, part := range []*partition{q.normal, q.grants} {
		if err := part.compact(); err != nil {
			return err
		}
	}
	return nil
}

func (p *partition) compact() error {
	tmp := p.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	for _, e := range p.entries {
		line, err := json.Marshal(&e)
		if err != nil {
			f.Close()
			return err
		}
		w.Write(line)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	if err := os.Rename(tmp, p.path); err != nil {
		return err
	}
	p.f.Close()
	nf, err := os.OpenFile(p.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	p.f = nf
	return nil
}

// Close releases file handles.
func (q *Queue) Close() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.normal.f.Close()
	q.grants.f.Close()
	return nil
}

// ---- Recorder: sign + enqueue ----

// Recorder builds, signs and enqueues event envelopes for this device.
type Recorder struct {
	Priv     ed25519.PrivateKey
	DeviceID string
	Clock    clock.Clock
	Queue    *Queue
	Log      *slog.Logger
}

// Record signs and enqueues an event of the given kind. Errors are logged,
// not returned: event recording must never block actuation (but
// grant_redeemed failures are loud — they mean the audit partition is full).
func (r *Recorder) Record(kind string, data map[string]any) {
	log := r.Log
	if log == nil {
		log = slog.Default()
	}
	raw, err := wire.SignEvent(r.Priv, &wire.Event{
		V: wire.Version, Typ: "event",
		EventID:  NewEventID(),
		DeviceID: r.DeviceID,
		Kind:     kind,
		TS:       r.Clock.Now(),
		Data:     data,
	})
	if err == nil {
		err = r.Queue.Enqueue(kind, raw)
	}
	if err != nil {
		log.Error("event record failed", "kind", kind, "err", err)
	}
}

// RecordGrantRedeemed signs and durably records a grant_redeemed event
// (proto/events.md), returning the error instead of only logging it —
// unlike Record. Callers on this path (agent.OnRedeemed) need to know
// whether the audit trail actually captured the event, because it is the
// primary evidence of an offline emergency-access open: "did we manage to
// record this at all" is a decision the caller must be able to see and act
// on (see EnqueueGrantRedeemed for the reserved-partition/overflow
// fallback this wraps).
func (r *Recorder) RecordGrantRedeemed(data map[string]any) error {
	log := r.Log
	if log == nil {
		log = slog.Default()
	}
	raw, err := wire.SignEvent(r.Priv, &wire.Event{
		V: wire.Version, Typ: "event",
		EventID:  NewEventID(),
		DeviceID: r.DeviceID,
		Kind:     "grant_redeemed",
		TS:       r.Clock.Now(),
		Data:     data,
	})
	if err != nil {
		log.Error("event record failed", "kind", "grant_redeemed", "err", err)
		return err
	}
	if err := r.Queue.EnqueueGrantRedeemed(raw); err != nil {
		log.Error("grant_redeemed durable record failed (reserved partition AND overflow log)", "err", err)
		return err
	}
	return nil
}

// NewEventID returns a random UUIDv4 string (the event idempotency key).
func NewEventID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("events: crypto/rand unavailable: " + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
