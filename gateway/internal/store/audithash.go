package store

// Tamper-evident hash chain for the two append-only audit tables
// (access_logs, admin_audit_log). See migrations/0007_audit_hash_chain.sql
// for the full design write-up; this file is the implementation.
//
// HONESTY, STATED PLAINLY (repeated from the migration on purpose — this is
// the load-bearing claim and it should be impossible to miss): a hash chain
// does NOT stop an attacker who edits the SQLite file directly AND
// recomputes every hash after their edit forward through the end of the
// chain. That attacker can still rewrite history undetectably. What this
// DOES do is turn silent tampering into detectable tampering for anyone who
// edits a row without also redoing that work (which is most tampering in
// practice — it requires noticing the chain exists, understanding the
// canonicalization, and re-deriving potentially thousands of downstream
// hashes), and it turns "was this tampered with?" from an unknowable
// question into a checkable one (VerifyAccessLogHashChain /
// VerifyAdminAuditHashChain, wired to GET /v1/admin/audit/verify and the
// `gateway verify-audit` CLI subcommand). It is a detection control, not a
// prevention control, and it does not claim otherwise.
//
// WHAT'S COVERED vs NOT — access_logs:
//   COVERED:     id, command, source, lat, long, distance_m, success, error,
//                ts, created_at, reconciles_log_id, and the four *_snapshot
//                columns (permanent insert-time copies of
//                account_id/location_id/access_point_id/user_id).
//   NOT COVERED: the LIVE access_point_id/location_id/account_id/user_id
//                columns themselves. They are excluded deliberately: this
//                schema already nulls them via ON DELETE SET NULL when the
//                referenced row is deleted (0001's own comment — "history
//                survives deletes"), so they are not actually immutable,
//                and hashing a column the schema is designed to mutate
//                would make an ordinary delete indistinguishable from
//                tampering. The *_snapshot columns carry the same
//                information permanently instead, so this is a coverage
//                RELOCATION, not a coverage LOSS — the who/where of a row
//                is still fully tamper-evident via its snapshot.
//   NOT COVERED (unconditionally): the schema's own `distance_m` column
//                IS covered above — but only because InsertAccessLog reads
//                it as always-empty; no code path in this repository writes
//                a value there today. If a future change starts populating
//                it via anything other than InsertAccessLog, that write
//                will not be reflected in the hash unless this file is
//                updated too.
//
// WHAT'S COVERED vs NOT — admin_audit_log:
//   COVERED:     id, action, target_kind, target_id, allowed, detail,
//                created_at, and actor_user_id_snapshot.
//   NOT COVERED: the live actor_user_id column, for the same ON DELETE SET
//                NULL reason as above — there is no user-delete feature in
//                this codebase today (users are only ever disabled, never
//                deleted), so this is currently a dormant exclusion, kept
//                for symmetry and so a future delete-user feature does not
//                need to redesign this file.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strconv"

	"github.com/vul-os/lintel/gateway/internal/keys"
)

// queryRower is satisfied by both *sql.DB and *sql.Tx — the hash-chain
// reads run inside a transaction when they gate a write (InsertAccessLog,
// WriteAdminAudit, the backfill) and standalone when they only verify.
type queryRower interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// genesisHash seeds a fresh chain. Distinct per table (via the chain name
// mixed into the digest) so the two tables' chains can never be spliced
// into one another even if their field-maps ever happened to collide in
// canonical form.
func genesisHash(chain string) string {
	sum := sha256.Sum256([]byte("lintel-audit-hash-chain-genesis-v1:" + chain))
	return hex.EncodeToString(sum[:])
}

var (
	accessLogsGenesisHash    = genesisHash("access_logs")
	adminAuditLogGenesisHash = genesisHash("admin_audit_log")
)

// floatHashValue encodes a nullable float for hashing as its exact,
// shortest round-trip decimal STRING (strconv.FormatFloat with -1
// precision) rather than a JSON number. keys.Canonicalize (RFC 8785 JCS)
// deliberately only supports integral numbers (see its own doc comment);
// lat/long are frequently non-integer. This is a hash-only encoding choice
// — nothing outside this file parses these strings as JSON numbers, so
// there is no interop concern in sidestepping JCS's float restriction this
// way.
func floatHashValue(f *float64) any {
	if f == nil {
		return nil
	}
	return strconv.FormatFloat(*f, 'g', -1, 64)
}

// computeRowHash renders {chain, prev_hash, fields} as JCS canonical JSON
// (reusing keys.Canonicalize — see the package doc comment for why: a
// second canonicalizer would be one more place for the two to silently
// drift) and returns hex(SHA-256(canonical bytes)).
func computeRowHash(chain, prevHash string, fields map[string]any) (string, error) {
	canonical, err := keys.Canonicalize(map[string]any{
		"chain":     chain,
		"prev_hash": prevHash,
		"fields":    fields,
	})
	if err != nil {
		return "", fmt.Errorf("lintel: canonicalize %s row for hashing: %w", chain, err)
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

// ---------------------------------------------------------------------------
// access_logs
// ---------------------------------------------------------------------------

// accessLogHashFields is exactly the set of access_logs values the hash
// covers — see the package doc comment for the full list and what is
// deliberately excluded.
type accessLogHashFields struct {
	ID                                         string
	AccountSnap, LocationSnap, AccessPointSnap string
	UserSnap                                   string
	Command, Source                            string
	Lat, Long                                  *float64
	Success                                    bool
	Error                                      string
	TS, CreatedAt                              int64
	ReconcilesLogID                            string
}

func (f accessLogHashFields) canonicalMap() map[string]any {
	return map[string]any{
		"id":                f.ID,
		"account_snapshot":  f.AccountSnap,
		"location_snapshot": f.LocationSnap,
		"ap_snapshot":       f.AccessPointSnap,
		"user_snapshot":     f.UserSnap,
		"command":           f.Command,
		"source":            f.Source,
		"lat":               floatHashValue(f.Lat),
		"long":              floatHashValue(f.Long),
		"success":           f.Success,
		"error":             f.Error,
		"ts":                f.TS,
		"created_at":        f.CreatedAt,
		"reconciles_log_id": f.ReconcilesLogID,
	}
}

// lastAccessLogRowHash returns the row_hash of the last (highest rowid)
// ALREADY-hashed access_logs row, or the table's genesis hash when none
// exists yet — correct both for a brand-new empty table and, during
// backfill, for "no row has been hashed yet".
func lastAccessLogRowHash(ctx context.Context, q queryRower) (string, error) {
	var h string
	err := q.QueryRowContext(ctx,
		`SELECT row_hash FROM access_logs WHERE row_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`).Scan(&h)
	if err == sql.ErrNoRows {
		return accessLogsGenesisHash, nil
	}
	if err != nil {
		return "", err
	}
	return h, nil
}

// lastAccessLogRowHashBefore is lastAccessLogRowHash bounded to rows with a
// smaller rowid than beforeRowid — used by backfill to anchor on the true
// immediate predecessor of the first pending row rather than the table's
// overall last-hashed row (see backfillAccessLogHashChain's comment).
func lastAccessLogRowHashBefore(ctx context.Context, q queryRower, beforeRowid int64) (string, error) {
	var h string
	err := q.QueryRowContext(ctx,
		`SELECT row_hash FROM access_logs WHERE row_hash IS NOT NULL AND rowid < ? ORDER BY rowid DESC LIMIT 1`,
		beforeRowid).Scan(&h)
	if err == sql.ErrNoRows {
		return accessLogsGenesisHash, nil
	}
	if err != nil {
		return "", err
	}
	return h, nil
}

// ---------------------------------------------------------------------------
// admin_audit_log
// ---------------------------------------------------------------------------

type adminAuditHashFields struct {
	ID, ActorSnap, Action, TargetKind, TargetID, Detail string
	Allowed                                             bool
	CreatedAt                                           int64
}

func (f adminAuditHashFields) canonicalMap() map[string]any {
	return map[string]any{
		"id":             f.ID,
		"actor_snapshot": f.ActorSnap,
		"action":         f.Action,
		"target_kind":    f.TargetKind,
		"target_id":      f.TargetID,
		"allowed":        f.Allowed,
		"detail":         f.Detail,
		"created_at":     f.CreatedAt,
	}
}

func lastAdminAuditRowHash(ctx context.Context, q queryRower) (string, error) {
	var h string
	err := q.QueryRowContext(ctx,
		`SELECT row_hash FROM admin_audit_log WHERE row_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`).Scan(&h)
	if err == sql.ErrNoRows {
		return adminAuditLogGenesisHash, nil
	}
	if err != nil {
		return "", err
	}
	return h, nil
}

// lastAdminAuditRowHashBefore is lastAdminAuditRowHash's counterpart to
// lastAccessLogRowHashBefore.
func lastAdminAuditRowHashBefore(ctx context.Context, q queryRower, beforeRowid int64) (string, error) {
	var h string
	err := q.QueryRowContext(ctx,
		`SELECT row_hash FROM admin_audit_log WHERE row_hash IS NOT NULL AND rowid < ? ORDER BY rowid DESC LIMIT 1`,
		beforeRowid).Scan(&h)
	if err == sql.ErrNoRows {
		return adminAuditLogGenesisHash, nil
	}
	if err != nil {
		return "", err
	}
	return h, nil
}

// ---------------------------------------------------------------------------
// Backfill — runs once at every Open(), before the *Store is handed back to
// the caller (so no fresh INSERT can ever race it: main.go does not start
// the HTTP server until store.Open returns). A no-op after the first run on
// any given database (the WHERE row_hash IS NULL scan is empty).
// ---------------------------------------------------------------------------

// backfillHashChains fills prev_hash/row_hash/*_snapshot for every row
// written before migration 0007 introduced the chain.
//
// HONESTY NOTE: a backfilled row's *_snapshot columns are populated from
// whatever the LIVE pointer columns hold AT UPGRADE TIME, not necessarily
// what they held at the row's true original insert time. If a referenced
// location/account/access point/user was already deleted (and the pointer
// already SET NULL) before this upgrade ran, that earlier value is
// genuinely gone — the snapshot freezes "NULL", not the lost original id.
// The chain protects everything from the moment of upgrade forward with
// full fidelity; it makes no claim about the provenance of data recorded
// before it existed.
func (s *Store) backfillHashChains(ctx context.Context) error {
	if err := s.backfillAccessLogHashChain(ctx); err != nil {
		return fmt.Errorf("backfill access_logs hash chain: %w", err)
	}
	if err := s.backfillAdminAuditHashChain(ctx); err != nil {
		return fmt.Errorf("backfill admin_audit_log hash chain: %w", err)
	}
	return nil
}

type pendingAccessLogRow struct {
	rowid                                         int64
	id, ap, loc, acct, user, cmd, src, errS, recc string
	lat, long                                     sql.NullFloat64
	success                                       int
	ts, createdAt                                 int64
}

// backfillAccessLogHashChain runs entirely inside ONE transaction: either
// every legacy row gets a hash or none do, so a crash mid-backfill can
// never leave a partially-chained table for a later boot to reason about.
// Self-hosted gateway databases are small; batching was judged unnecessary.
func (s *Store) backfillAccessLogHashChain(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx,
		`SELECT rowid, id, coalesce(access_point_id,''), coalesce(location_id,''), coalesce(account_id,''),
		        coalesce(user_id,''), coalesce(command,''), coalesce(source,''), lat, long, success,
		        coalesce(error,''), ts, created_at, coalesce(reconciles_log_id,'')
		 FROM access_logs WHERE row_hash IS NULL ORDER BY rowid ASC`)
	if err != nil {
		return err
	}
	var pending []pendingAccessLogRow
	for rows.Next() {
		var p pendingAccessLogRow
		if err := rows.Scan(&p.rowid, &p.id, &p.ap, &p.loc, &p.acct, &p.user, &p.cmd, &p.src,
			&p.lat, &p.long, &p.success, &p.errS, &p.ts, &p.createdAt, &p.recc); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(pending) == 0 {
		return nil
	}

	// Anchor on the row immediately BEFORE the first pending row (by
	// rowid), not "whatever the last hashed row in the whole table is":
	// those coincide in the ordinary upgrade case (every existing row is
	// pending, in one contiguous block, and nothing hashed exists after
	// it), but would silently anchor onto the WRONG predecessor if a hole
	// of unhashed rows ever existed with already-hashed rows on both
	// sides of it — deliberately robust to that even though the
	// all-or-nothing single transaction below means it should never arise
	// in practice.
	prev, err := lastAccessLogRowHashBefore(ctx, tx, pending[0].rowid)
	if err != nil {
		return err
	}
	for _, p := range pending {
		f := accessLogHashFields{
			ID: p.id, AccountSnap: p.acct, LocationSnap: p.loc, AccessPointSnap: p.ap, UserSnap: p.user,
			Command: p.cmd, Source: p.src, Success: p.success != 0, Error: p.errS,
			TS: p.ts, CreatedAt: p.createdAt, ReconcilesLogID: p.recc,
		}
		if p.lat.Valid {
			v := p.lat.Float64
			f.Lat = &v
		}
		if p.long.Valid {
			v := p.long.Float64
			f.Long = &v
		}
		h, err := computeRowHash("access_logs", prev, f.canonicalMap())
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE access_logs SET prev_hash = ?, row_hash = ?,
			        account_id_snapshot = ?, location_id_snapshot = ?,
			        access_point_id_snapshot = ?, user_id_snapshot = ?
			 WHERE rowid = ?`,
			prev, h, p.acct, p.loc, p.ap, p.user, p.rowid); err != nil {
			return err
		}
		prev = h
	}
	return tx.Commit()
}

type pendingAdminAuditRow struct {
	rowid                                    int64
	id, actor, action, tk, tid, detail, errS string
	allowed                                  int
	createdAt                                int64
}

func (s *Store) backfillAdminAuditHashChain(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(ctx,
		`SELECT rowid, id, coalesce(actor_user_id,''), action, coalesce(target_kind,''),
		        coalesce(target_id,''), allowed, detail, created_at
		 FROM admin_audit_log WHERE row_hash IS NULL ORDER BY rowid ASC`)
	if err != nil {
		return err
	}
	var pending []pendingAdminAuditRow
	for rows.Next() {
		var p pendingAdminAuditRow
		if err := rows.Scan(&p.rowid, &p.id, &p.actor, &p.action, &p.tk, &p.tid, &p.allowed, &p.detail, &p.createdAt); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(pending) == 0 {
		return nil
	}

	prev, err := lastAdminAuditRowHashBefore(ctx, tx, pending[0].rowid)
	if err != nil {
		return err
	}
	for _, p := range pending {
		f := adminAuditHashFields{
			ID: p.id, ActorSnap: p.actor, Action: p.action, TargetKind: p.tk, TargetID: p.tid,
			Allowed: p.allowed != 0, Detail: p.detail, CreatedAt: p.createdAt,
		}
		h, err := computeRowHash("admin_audit_log", prev, f.canonicalMap())
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE admin_audit_log SET prev_hash = ?, row_hash = ?, actor_user_id_snapshot = ? WHERE rowid = ?`,
			prev, h, p.actor, p.rowid); err != nil {
			return err
		}
		prev = h
	}
	return tx.Commit()
}

// ---------------------------------------------------------------------------
// Verification — walks a chain in rowid order, recomputing every hash from
// the row's own stored (immutable) content, and reports the FIRST place it
// stops matching. Read-only; safe to run against a live database or a copy
// of a backup (see the CLI subcommand's own caveat about opening a backup
// read-write to apply migrations before verifying it).
// ---------------------------------------------------------------------------

// HashChainBreak names the first place a chain fails to verify.
type HashChainBreak struct {
	Index  int64 // 1-based position in rowid order
	RowID  string
	Reason string // "missing_hash" | "prev_hash_mismatch" | "row_hash_mismatch"
}

// VerifyHashChainResult is the outcome of walking one table's chain.
type VerifyHashChainResult struct {
	Table       string
	RowsChecked int64
	OK          bool
	Break       *HashChainBreak
}

// VerifyAccessLogHashChain walks every access_logs row in rowid order and
// recomputes its hash from its own stored content (excluding the live
// pointer columns — see the package doc comment). Returns as soon as it
// finds the first row that does not check out.
func (s *Store) VerifyAccessLogHashChain(ctx context.Context) (*VerifyHashChainResult, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT rowid, id, coalesce(account_id_snapshot,''), coalesce(location_id_snapshot,''),
		        coalesce(access_point_id_snapshot,''), coalesce(user_id_snapshot,''),
		        coalesce(command,''), coalesce(source,''), lat, long, success, coalesce(error,''),
		        ts, created_at, coalesce(reconciles_log_id,''), prev_hash, row_hash
		 FROM access_logs ORDER BY rowid ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	res := &VerifyHashChainResult{Table: "access_logs", OK: true}
	prev := accessLogsGenesisHash
	var idx int64
	for rows.Next() {
		idx++
		var (
			rowid                                             int64
			id, acctS, locS, apS, userS, cmd, src, errS, recc string
			lat, long                                         sql.NullFloat64
			success                                           int
			ts, createdAt                                     int64
			prevHash, rowHash                                 sql.NullString
		)
		if err := rows.Scan(&rowid, &id, &acctS, &locS, &apS, &userS, &cmd, &src, &lat, &long,
			&success, &errS, &ts, &createdAt, &recc, &prevHash, &rowHash); err != nil {
			return nil, err
		}
		res.RowsChecked = idx
		if !rowHash.Valid || rowHash.String == "" {
			res.OK = false
			res.Break = &HashChainBreak{Index: idx, RowID: id, Reason: "missing_hash"}
			return res, nil
		}
		if !prevHash.Valid || prevHash.String != prev {
			res.OK = false
			res.Break = &HashChainBreak{Index: idx, RowID: id, Reason: "prev_hash_mismatch"}
			return res, nil
		}
		f := accessLogHashFields{ID: id, AccountSnap: acctS, LocationSnap: locS, AccessPointSnap: apS,
			UserSnap: userS, Command: cmd, Source: src, Success: success != 0, Error: errS,
			TS: ts, CreatedAt: createdAt, ReconcilesLogID: recc}
		if lat.Valid {
			v := lat.Float64
			f.Lat = &v
		}
		if long.Valid {
			v := long.Float64
			f.Long = &v
		}
		want, err := computeRowHash("access_logs", prev, f.canonicalMap())
		if err != nil {
			return nil, err
		}
		if want != rowHash.String {
			res.OK = false
			res.Break = &HashChainBreak{Index: idx, RowID: id, Reason: "row_hash_mismatch"}
			return res, nil
		}
		prev = rowHash.String
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return res, nil
}

// VerifyAdminAuditHashChain is VerifyAccessLogHashChain's admin_audit_log
// twin.
func (s *Store) VerifyAdminAuditHashChain(ctx context.Context) (*VerifyHashChainResult, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT rowid, id, coalesce(actor_user_id_snapshot,''), action, coalesce(target_kind,''),
		        coalesce(target_id,''), allowed, detail, created_at, prev_hash, row_hash
		 FROM admin_audit_log ORDER BY rowid ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	res := &VerifyHashChainResult{Table: "admin_audit_log", OK: true}
	prev := adminAuditLogGenesisHash
	var idx int64
	for rows.Next() {
		idx++
		var (
			rowid                               int64
			id, actorS, action, tk, tid, detail string
			allowed                             int
			createdAt                           int64
			prevHash, rowHash                   sql.NullString
		)
		if err := rows.Scan(&rowid, &id, &actorS, &action, &tk, &tid, &allowed, &detail, &createdAt,
			&prevHash, &rowHash); err != nil {
			return nil, err
		}
		res.RowsChecked = idx
		if !rowHash.Valid || rowHash.String == "" {
			res.OK = false
			res.Break = &HashChainBreak{Index: idx, RowID: id, Reason: "missing_hash"}
			return res, nil
		}
		if !prevHash.Valid || prevHash.String != prev {
			res.OK = false
			res.Break = &HashChainBreak{Index: idx, RowID: id, Reason: "prev_hash_mismatch"}
			return res, nil
		}
		f := adminAuditHashFields{ID: id, ActorSnap: actorS, Action: action, TargetKind: tk, TargetID: tid,
			Allowed: allowed != 0, Detail: detail, CreatedAt: createdAt}
		want, err := computeRowHash("admin_audit_log", prev, f.canonicalMap())
		if err != nil {
			return nil, err
		}
		if want != rowHash.String {
			res.OK = false
			res.Break = &HashChainBreak{Index: idx, RowID: id, Reason: "row_hash_mismatch"}
			return res, nil
		}
		prev = rowHash.String
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return res, nil
}

// VerifyHashChains runs both chain verifications and returns both results
// (even when the first one is already broken — an operator wants the full
// picture, not just the first bad table). The admin HTTP endpoint
// (GET /v1/admin/audit/verify) and the `gateway verify-audit` CLI
// subcommand both call this.
func (s *Store) VerifyHashChains(ctx context.Context) ([]VerifyHashChainResult, error) {
	al, err := s.VerifyAccessLogHashChain(ctx)
	if err != nil {
		return nil, err
	}
	aa, err := s.VerifyAdminAuditHashChain(ctx)
	if err != nil {
		return nil, err
	}
	return []VerifyHashChainResult{*al, *aa}, nil
}
