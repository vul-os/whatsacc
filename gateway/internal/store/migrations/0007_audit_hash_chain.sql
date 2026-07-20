-- 0007_audit_hash_chain.sql
-- Stage 7: tamper-evident hash chain for the two append-only audit tables
-- (access_logs, admin_audit_log). Security-assessment finding: "append-only"
-- was a convention two call sites followed, nothing in the schema enforced
-- it, and there was already a live UPDATE in the shipped binary
-- (store.UpdateAccessLogError, removed by this same change — see
-- internal/store/openpath.go's RecordDispatchOutcome, which replaces it
-- with an insert-only follow-up row, the same pattern 0006 established for
-- late cmd.ack reconciliation).
--
-- DESIGN — see internal/store/audithash.go for the Go-side implementation,
-- this is the honest summary:
--
--   Each row gets prev_hash + row_hash. row_hash = SHA-256(JCS-canonical
--   envelope of {chain, prev_hash, fields}), chained to the PREVIOUS row in
--   the same table (rowid order), starting from a fixed per-table genesis
--   constant. Walking the chain and recomputing each row_hash (GET
--   /v1/admin/audit/verify, or `gateway verify-audit` from the CLI) turns
--   "was this tampered with?" into a checkable question.
--
--   WHAT'S NOT COVERED, ON PURPOSE: access_logs.access_point_id/location_id
--   /account_id/user_id (and admin_audit_log.actor_user_id) are LIVE
--   pointer columns this schema already nulls via ON DELETE SET NULL when
--   the referenced access point/location/account/user is deleted (see
--   0001's own comment: "denormalised... so history survives deletes").
--   Hashing those live columns would turn an ordinary location delete into
--   a false tamper alarm — worse than no alarm, because an operator who
--   gets burned by false positives stops trusting the tool. Instead each
--   row also carries a permanent, insert-time SNAPSHOT of those same ids
--   (*_snapshot columns below, plain TEXT, no FK, never touched again) and
--   THOSE are what the hash covers — full forensic value (who/where is
--   still tamper-evident), without false alarms on a legitimate delete.
--
--   HONESTY, STATED PLAINLY: a hash chain does not stop an attacker who
--   edits the SQLite file directly AND recomputes every hash after their
--   edit — that attacker can rewrite history undetectably, same as before
--   this migration. What it does is turn SILENT tampering into DETECTABLE
--   tampering for anyone who edits a row without also redoing that work,
--   and it makes "was this tampered with?" a checkable question instead of
--   an unknowable one. It is a detection control, not a prevention control.
--
--   The two triggers below are DEFENSE IN DEPTH against the RUNNING
--   APPLICATION, not against a raw-file attacker (who can just DROP the
--   trigger, or edit bytes directly — SQLite triggers are not an
--   authorization mechanism against someone with filesystem access to
--   lintel.db). They exist so a future application bug can't reintroduce a
--   silent UPDATE/DELETE against these tables without a loud SQLite error.
--   Each trigger allows exactly two kinds of UPDATE:
--     (a) one-time hash backfill of a pre-chain row (row_hash NULL -> set,
--         nothing else changes) — see Store.backfillHashChains, run once at
--         every Open() before the server can serve a request;
--     (b) SQLite's own ON DELETE SET NULL foreign-key action nulling a live
--         pointer column when its target is deleted elsewhere (never the
--         *_snapshot columns, never anything the hash covers).
--   DELETE is never allowed at all — nothing in this codebase legitimately
--   deletes a row from either table.
--
--   PRE-EXISTING ROWS: backfilled once at upgrade time from whatever the
--   live pointer columns hold AT THAT MOMENT, not necessarily what they
--   held at the row's true original insert time (if a referenced location
--   was already deleted years before this upgrade, that earlier value is
--   genuinely gone — this can't be recovered). The chain protects
--   everything from the moment of upgrade forward with full fidelity; it
--   makes no claim about data recorded before it existed.

ALTER TABLE access_logs ADD COLUMN account_id_snapshot TEXT;
ALTER TABLE access_logs ADD COLUMN location_id_snapshot TEXT;
ALTER TABLE access_logs ADD COLUMN access_point_id_snapshot TEXT;
ALTER TABLE access_logs ADD COLUMN user_id_snapshot TEXT;
ALTER TABLE access_logs ADD COLUMN prev_hash TEXT;
ALTER TABLE access_logs ADD COLUMN row_hash TEXT;
CREATE UNIQUE INDEX access_logs_row_hash_idx ON access_logs (row_hash) WHERE row_hash IS NOT NULL;

ALTER TABLE admin_audit_log ADD COLUMN actor_user_id_snapshot TEXT;
ALTER TABLE admin_audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE admin_audit_log ADD COLUMN row_hash TEXT;
CREATE UNIQUE INDEX admin_audit_log_row_hash_idx ON admin_audit_log (row_hash) WHERE row_hash IS NOT NULL;

CREATE TRIGGER access_logs_immutable
BEFORE UPDATE ON access_logs
WHEN NOT (
    (
        -- (a) hash backfill of a pre-chain row: only the hash/snapshot
        -- columns move from NULL to a value; every content column is
        -- byte-for-byte unchanged.
        old.prev_hash IS NULL AND old.row_hash IS NULL
        AND new.row_hash IS NOT NULL AND new.prev_hash IS NOT NULL
        AND new.account_id_snapshot IS NOT NULL AND new.location_id_snapshot IS NOT NULL
        AND new.access_point_id_snapshot IS NOT NULL AND new.user_id_snapshot IS NOT NULL
        AND new.id IS old.id AND new.access_point_id IS old.access_point_id
        AND new.location_id IS old.location_id AND new.account_id IS old.account_id
        AND new.user_id IS old.user_id AND new.command IS old.command AND new.source IS old.source
        AND new.lat IS old.lat AND new.long IS old.long AND new.distance_m IS old.distance_m
        AND new.success IS old.success AND new.error IS old.error AND new.ts IS old.ts
        AND new.created_at IS old.created_at AND new.reconciles_log_id IS old.reconciles_log_id
    )
    OR
    (
        -- (b) ON DELETE SET NULL cascade from a deleted access_point/
        -- location/account/user: only the LIVE pointer columns may move
        -- from non-NULL to NULL. Hashes, snapshots and every other content
        -- column are untouched.
        new.prev_hash IS old.prev_hash AND new.row_hash IS old.row_hash
        AND new.account_id_snapshot IS old.account_id_snapshot
        AND new.location_id_snapshot IS old.location_id_snapshot
        AND new.access_point_id_snapshot IS old.access_point_id_snapshot
        AND new.user_id_snapshot IS old.user_id_snapshot
        AND new.id IS old.id AND new.command IS old.command AND new.source IS old.source
        AND new.lat IS old.lat AND new.long IS old.long AND new.distance_m IS old.distance_m
        AND new.success IS old.success AND new.error IS old.error AND new.ts IS old.ts
        AND new.created_at IS old.created_at AND new.reconciles_log_id IS old.reconciles_log_id
        AND (new.access_point_id IS old.access_point_id OR (old.access_point_id IS NOT NULL AND new.access_point_id IS NULL))
        AND (new.location_id IS old.location_id OR (old.location_id IS NOT NULL AND new.location_id IS NULL))
        AND (new.account_id IS old.account_id OR (old.account_id IS NOT NULL AND new.account_id IS NULL))
        AND (new.user_id IS old.user_id OR (old.user_id IS NOT NULL AND new.user_id IS NULL))
    )
)
BEGIN
    SELECT RAISE(ABORT, 'access_logs is append-only: only hash backfill and FK SET NULL cascades may update a row');
END;

CREATE TRIGGER access_logs_no_delete
BEFORE DELETE ON access_logs
BEGIN
    SELECT RAISE(ABORT, 'access_logs is append-only: rows may never be deleted');
END;

CREATE TRIGGER admin_audit_log_immutable
BEFORE UPDATE ON admin_audit_log
WHEN NOT (
    (
        old.prev_hash IS NULL AND old.row_hash IS NULL
        AND new.row_hash IS NOT NULL AND new.prev_hash IS NOT NULL
        AND new.actor_user_id_snapshot IS NOT NULL
        AND new.id IS old.id AND new.actor_user_id IS old.actor_user_id AND new.action IS old.action
        AND new.target_kind IS old.target_kind AND new.target_id IS old.target_id
        AND new.allowed IS old.allowed AND new.detail IS old.detail AND new.created_at IS old.created_at
    )
    OR
    (
        new.prev_hash IS old.prev_hash AND new.row_hash IS old.row_hash
        AND new.actor_user_id_snapshot IS old.actor_user_id_snapshot
        AND new.id IS old.id AND new.action IS old.action AND new.target_kind IS old.target_kind
        AND new.target_id IS old.target_id AND new.allowed IS old.allowed AND new.detail IS old.detail
        AND new.created_at IS old.created_at
        AND (new.actor_user_id IS old.actor_user_id OR (old.actor_user_id IS NOT NULL AND new.actor_user_id IS NULL))
    )
)
BEGIN
    SELECT RAISE(ABORT, 'admin_audit_log is append-only: only hash backfill and FK SET NULL cascades may update a row');
END;

CREATE TRIGGER admin_audit_log_no_delete
BEFORE DELETE ON admin_audit_log
BEGIN
    SELECT RAISE(ABORT, 'admin_audit_log is append-only: rows may never be deleted');
END;
