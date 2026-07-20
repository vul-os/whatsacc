package store

import (
	"context"
	"strings"
	"testing"
)

// TestInsertAccessLogChainsHashes proves the basic chain-linking invariant:
// each row's prev_hash equals the previous row's row_hash, the first row
// chains off the table's genesis constant, and VerifyAccessLogHashChain
// agrees the whole thing checks out. This is a brand-new capability — none
// of this existed before migration 0007 — so there is no meaningful "before"
// state beyond "this type/method did not exist yet".
func TestInsertAccessLogChainsHashes(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	ap, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}

	var ids []string
	for i := 0; i < 3; i++ {
		id, err := s.InsertAccessLog(ctx, AccessLog{
			AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
			Command: "open", Source: "web", Success: true,
		})
		if err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
		ids = append(ids, id)
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT id, coalesce(prev_hash,''), coalesce(row_hash,'') FROM access_logs ORDER BY rowid ASC`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type link struct{ id, prev, hash string }
	var links []link
	for rows.Next() {
		var l link
		if err := rows.Scan(&l.id, &l.prev, &l.hash); err != nil {
			t.Fatal(err)
		}
		links = append(links, l)
	}
	if len(links) != 3 {
		t.Fatalf("want 3 rows, got %d", len(links))
	}
	if links[0].prev != accessLogsGenesisHash {
		t.Errorf("first row must chain off genesis: got %q", links[0].prev)
	}
	for i := 1; i < len(links); i++ {
		if links[i].prev != links[i-1].hash {
			t.Errorf("row %d prev_hash %q != row %d row_hash %q", i, links[i].prev, i-1, links[i-1].hash)
		}
		if links[i].hash == links[i-1].hash {
			t.Errorf("row %d and %d hashed identically — chain not actually varying", i-1, i)
		}
	}

	res, err := s.VerifyAccessLogHashChain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.RowsChecked != 3 || res.Break != nil {
		t.Errorf("verify: %+v", res)
	}
}

// dropAccessLogsTrigger simulates the ACTUAL threat model the hash chain
// defends against: an attacker with direct access to the SQLite file, who
// is not going through this application's SQL layer at all and can DROP a
// trigger just as easily as editing a row. The trigger is defense in depth
// against the running application (see migration 0007's doc comment); it
// is not, and was never claimed to be, a defense against this attacker —
// only the hash chain is.
func dropAccessLogsTrigger(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.db.Exec(`DROP TRIGGER access_logs_immutable`); err != nil {
		t.Fatalf("drop trigger (test setup): %v", err)
	}
}

// TestAccessLogsTriggerBlocksDirectMutation proves the append-only trigger
// itself works: with the trigger in place (the normal, shipped state), an
// ordinary UPDATE against a hashed content column is rejected by SQLite,
// not silently applied. Before migration 0007 there was no trigger at all
// — this exact statement (the old store.UpdateAccessLogError's shape)
// would have succeeded silently. That is the concrete "fails before this
// change" case for the trigger half of fix 1.
func TestAccessLogsTriggerBlocksDirectMutation(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	ap, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	logID, err := s.InsertAccessLog(ctx, AccessLog{
		AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
		Command: "open", Source: "web", Success: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	// This is EXACTLY the statement the old UpdateAccessLogError used to
	// run (`UPDATE access_logs SET error = ? WHERE id = ?`).
	if _, err := s.db.Exec(`UPDATE access_logs SET error = ? WHERE id = ?`, "tampered", logID); err == nil {
		t.Fatal("direct mutation of a hashed column must be rejected by access_logs_immutable, got no error")
	} else if !strings.Contains(err.Error(), "append-only") {
		t.Errorf("expected an append-only trigger abort, got: %v", err)
	}

	if _, err := s.db.Exec(`DELETE FROM access_logs WHERE id = ?`, logID); err == nil {
		t.Fatal("DELETE against access_logs must be rejected by access_logs_no_delete, got no error")
	}
}

// TestHashChainDetectsTamper is the fix's core promise, made concrete: an
// attacker who bypasses the application entirely (dropAccessLogsTrigger)
// and edits a row's content directly is caught by VerifyAccessLogHashChain,
// which reports the FIRST broken row (index + id), not just "something,
// somewhere is wrong".
func TestHashChainDetectsTamper(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	ap, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}

	var ids []string
	for i := 0; i < 4; i++ {
		id, err := s.InsertAccessLog(ctx, AccessLog{
			AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
			Command: "open", Source: "web", Success: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if res, err := s.VerifyAccessLogHashChain(ctx); err != nil || !res.OK {
		t.Fatalf("chain must verify clean before tampering: %v %+v", err, res)
	}

	// Tamper with the THIRD row's error field (an attacker rewriting a
	// denial reason, say) without recomputing anything downstream —
	// exactly the "silent tampering" the finding described.
	dropAccessLogsTrigger(t, s)
	if _, err := s.db.Exec(`UPDATE access_logs SET error = ? WHERE id = ?`, "forged", ids[2]); err != nil {
		t.Fatalf("tamper (test setup): %v", err)
	}

	res, err := s.VerifyAccessLogHashChain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK {
		t.Fatal("tampered row was not detected")
	}
	if res.Break == nil || res.Break.RowID != ids[2] || res.Break.Index != 3 {
		t.Errorf("break should name row 3 (id %s), got %+v", ids[2], res.Break)
	}
	if res.Break.Reason != "row_hash_mismatch" {
		t.Errorf("break reason: got %q", res.Break.Reason)
	}
}

// TestHashChainTamperRecomputingDownstreamIsUndetected is the honesty test:
// it proves, on purpose, the LIMIT stated in this fix's own doc comments —
// an attacker who edits a row AND recomputes every hash after it (walking
// the chain forward exactly the way VerifyAccessLogHashChain itself does)
// produces a chain that verifies clean. This is not a bug: it is exactly
// what "detection, not prevention" means, demonstrated rather than merely
// asserted in a comment.
func TestHashChainTamperRecomputingDownstreamIsUndetected(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	ap, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for i := 0; i < 3; i++ {
		id, err := s.InsertAccessLog(ctx, AccessLog{
			AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
			Command: "open", Source: "web", Success: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}

	dropAccessLogsTrigger(t, s)
	// The store's single SQLite connection (MaxOpenConns(1)) means an open
	// *sql.Rows cursor holds the only connection — read everything into
	// memory FIRST, then issue the UPDATEs, or the Exec calls below would
	// deadlock waiting for a connection the still-open rows never releases.
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, coalesce(account_id_snapshot,''), coalesce(location_id_snapshot,''),
		        coalesce(access_point_id_snapshot,''), coalesce(user_id_snapshot,''),
		        coalesce(command,''), coalesce(source,''), success, coalesce(error,''), ts, created_at,
		        coalesce(reconciles_log_id,'')
		 FROM access_logs ORDER BY rowid ASC`)
	if err != nil {
		t.Fatal(err)
	}
	var all []accessLogHashFields
	for rows.Next() {
		var f accessLogHashFields
		var success int
		if err := rows.Scan(&f.ID, &f.AccountSnap, &f.LocationSnap, &f.AccessPointSnap, &f.UserSnap,
			&f.Command, &f.Source, &success, &f.Error, &f.TS, &f.CreatedAt, &f.ReconcilesLogID); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		f.Success = success != 0
		all = append(all, f)
	}
	rows.Close()

	prev := accessLogsGenesisHash
	for i, f := range all {
		if i == 1 {
			f.Error = "forged-and-rehashed" // the tamper
		}
		h, err := computeRowHash("access_logs", prev, f.canonicalMap())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.db.Exec(`UPDATE access_logs SET error = ?, prev_hash = ?, row_hash = ? WHERE id = ?`,
			f.Error, prev, h, f.ID); err != nil {
			t.Fatal(err)
		}
		prev = h
	}

	res, err := s.VerifyAccessLogHashChain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Fatalf("a fully re-hashed tamper is EXPECTED to verify clean (that is the documented limit) — got %+v", res)
	}
}

// TestReconciledRowIsNotAFalsePositive covers the other required case: a
// LEGITIMATE append-only follow-up row (ReconcileLateAck's late cmd.ack
// pattern) must chain in cleanly and must NOT be flagged by verification.
func TestReconciledRowIsNotAFalsePositive(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	ap, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	origID, err := s.InsertAccessLog(ctx, AccessLog{
		AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
		Command: "open", Source: "web", Success: true, Error: "undelivered",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReconcileLateAck(ctx, origID, "opened", "", now()); err != nil {
		t.Fatal(err)
	}
	// RecordDispatchOutcome exercises the OTHER append-only-follow-up path
	// (the synchronous dispatch-outcome tagging that replaced
	// UpdateAccessLogError).
	origID2, err := s.InsertAccessLog(ctx, AccessLog{
		AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
		Command: "open", Source: "web", Success: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordDispatchOutcome(ctx, origID2, "undelivered"); err != nil {
		t.Fatal(err)
	}

	res, err := s.VerifyAccessLogHashChain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.RowsChecked != 4 {
		t.Errorf("legitimate follow-up rows must not be false positives: %+v", res)
	}
}

// TestLocationDeleteCascadeDoesNotBreakChain is the trigger's trickiest
// case, exercised for real rather than just argued about in a comment:
// deleting a location cascades (via this schema's OWN, pre-existing
// ON DELETE SET NULL / CASCADE foreign keys) into UPDATEs against
// access_logs.location_id/access_point_id — a real, reachable path
// (DeleteLocation, used by DELETE /v1/locations/:id) that must keep
// working, and must not turn an ordinary delete into a false tamper
// alarm.
func TestLocationDeleteCascadeDoesNotBreakChain(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	u, err := s.CreateUser(ctx, "cascade@x.com", "h", "C", "")
	if err != nil {
		t.Fatal(err)
	}
	acct, loc, err := s.CreateAccountWithOwner(ctx, u.ID, "Cascade House", "ZA")
	if err != nil {
		t.Fatal(err)
	}
	ap, err := s.CreateAccessPoint(ctx, acct.ID, loc.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	logID, err := s.InsertAccessLog(ctx, AccessLog{
		AccessPointID: ap.ID, LocationID: loc.ID, AccountID: acct.ID,
		Command: "open", Source: "web", Success: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.DeleteLocation(ctx, acct.ID, loc.ID); err != nil {
		t.Fatalf("DeleteLocation must still work with the immutability trigger in place: %v", err)
	}

	// The live pointer columns were nulled by the cascade (this is the
	// pre-existing, documented behaviour — "history survives deletes").
	var apCol, locCol, apSnap, locSnap string
	if err := s.db.QueryRowContext(ctx,
		`SELECT coalesce(access_point_id,''), coalesce(location_id,''),
		        coalesce(access_point_id_snapshot,''), coalesce(location_id_snapshot,'')
		 FROM access_logs WHERE id = ?`, logID).Scan(&apCol, &locCol, &apSnap, &locSnap); err != nil {
		t.Fatal(err)
	}
	if apCol != "" || locCol != "" {
		t.Errorf("expected the cascade to null the live pointers: ap=%q loc=%q", apCol, locCol)
	}
	if apSnap != ap.ID || locSnap != loc.ID {
		t.Errorf("snapshot columns must survive the cascade untouched: ap_snap=%q (want %s) loc_snap=%q (want %s)",
			apSnap, ap.ID, locSnap, loc.ID)
	}

	res, err := s.VerifyAccessLogHashChain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK {
		t.Errorf("an ordinary, legitimate location delete must not break the hash chain: %+v", res)
	}
}

// TestBackfillHashesLegacyRows proves the migration path: a row that
// predates the hash chain (simulated here by clearing its hash/prev_hash/
// snapshot columns, which is exactly the state every pre-0007 row was in)
// gets a valid hash the next time backfillHashChains runs (i.e. the next
// Open()), and the whole table verifies clean afterwards — an existing
// install upgrading past this migration must not break.
func TestBackfillHashesLegacyRows(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	ap, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for i := 0; i < 3; i++ {
		id, err := s.InsertAccessLog(ctx, AccessLog{
			AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
			Command: "open", Source: "web", Success: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}

	// Roll the MIDDLE row back to "pre-migration" shape, with hashed rows
	// on both sides left untouched. In production, backfill only ever
	// meets a contiguous prefix of un-hashed rows (every row predates
	// migration 0007 uniformly), never a hole like this — but this is the
	// harder case, and it must still self-heal correctly: recomputing
	// row 2's hash from its (unchanged) content and its TRUE predecessor
	// (row 1's hash) reproduces the exact hash row 2 always had, which is
	// exactly what row 3's already-stored prev_hash expects. This is what
	// lastAccessLogRowHashBefore's rowid-bounded anchor exists for — the
	// naive "whatever the last-hashed row in the whole table is" anchor
	// (row 3, chronologically AFTER the gap) gets this wrong.
	dropAccessLogsTrigger(t, s)
	if _, err := s.db.Exec(
		`UPDATE access_logs SET prev_hash = NULL, row_hash = NULL,
		        account_id_snapshot = NULL, location_id_snapshot = NULL,
		        access_point_id_snapshot = NULL, user_id_snapshot = NULL
		 WHERE id = ?`, ids[1]); err != nil {
		t.Fatal(err)
	}

	if err := s.backfillHashChains(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	res, err := s.VerifyAccessLogHashChain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.RowsChecked != 3 {
		t.Errorf("post-backfill chain must verify clean: %+v", res)
	}

	// Re-running backfill (e.g. a second Open()) must be a no-op, not an
	// error and not a chain break.
	if err := s.backfillHashChains(ctx); err != nil {
		t.Fatalf("idempotent re-backfill: %v", err)
	}
	if res, err := s.VerifyAccessLogHashChain(ctx); err != nil || !res.OK {
		t.Errorf("chain after idempotent re-backfill: %v %+v", err, res)
	}
}

// TestAdminAuditHashChain covers the admin_audit_log twin: chaining,
// tamper detection, and the append-only trigger, in one pass (the
// per-field mechanics are identical to access_logs and already covered in
// detail above).
func TestAdminAuditHashChain(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	u, err := s.CreateUser(ctx, "aa@x.com", "h", "A", "")
	if err != nil {
		t.Fatal(err)
	}

	var ids []string
	for i := 0; i < 3; i++ {
		if err := s.WriteAdminAudit(ctx, u.ID, "test_action", "thing", "t1", true, map[string]any{"i": i}); err != nil {
			t.Fatal(err)
		}
	}
	rows, _ := s.db.QueryContext(ctx, `SELECT id FROM admin_audit_log ORDER BY rowid ASC`)
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) != 3 {
		t.Fatalf("want 3 rows, got %d", len(ids))
	}

	res, err := s.VerifyAdminAuditHashChain(ctx)
	if err != nil || !res.OK || res.RowsChecked != 3 {
		t.Fatalf("clean verify: %v %+v", err, res)
	}

	// Trigger blocks a direct mutation.
	if _, err := s.db.Exec(`UPDATE admin_audit_log SET action = ? WHERE id = ?`, "renamed", ids[0]); err == nil {
		t.Fatal("admin_audit_log_immutable should have blocked this update")
	}
	if _, err := s.db.Exec(`DELETE FROM admin_audit_log WHERE id = ?`, ids[0]); err == nil {
		t.Fatal("admin_audit_log_no_delete should have blocked this delete")
	}

	// Bypass the trigger (simulated raw-file attacker) and confirm
	// detection.
	if _, err := s.db.Exec(`DROP TRIGGER admin_audit_log_immutable`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE admin_audit_log SET action = ? WHERE id = ?`, "forged", ids[1]); err != nil {
		t.Fatal(err)
	}
	res, err = s.VerifyAdminAuditHashChain(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.OK {
		t.Fatal("tampered admin_audit_log row was not detected")
	}
	if res.Break == nil || res.Break.RowID != ids[1] {
		t.Errorf("break should name row 2 (id %s): %+v", ids[1], res.Break)
	}
}

// VerifyHashChains (the combined admin-endpoint/CLI entry point) reports
// both tables even when the FIRST one is already broken.
func TestVerifyHashChainsReportsBothTables(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	acctA, _, locA, _ := twoTenants(t, s)
	ap, err := s.CreateAccessPoint(ctx, acctA.ID, locA.ID, "Gate", "gate")
	if err != nil {
		t.Fatal(err)
	}
	logID, err := s.InsertAccessLog(ctx, AccessLog{
		AccessPointID: ap.ID, LocationID: locA.ID, AccountID: acctA.ID,
		Command: "open", Source: "web", Success: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	dropAccessLogsTrigger(t, s)
	if _, err := s.db.Exec(`UPDATE access_logs SET error = 'x' WHERE id = ?`, logID); err != nil {
		t.Fatal(err)
	}

	results, err := s.VerifyHashChains(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("want 2 results, got %d", len(results))
	}
	if results[0].Table != "access_logs" || results[0].OK {
		t.Errorf("access_logs result: %+v", results[0])
	}
	if results[1].Table != "admin_audit_log" || !results[1].OK {
		t.Errorf("admin_audit_log result: %+v", results[1])
	}
}
