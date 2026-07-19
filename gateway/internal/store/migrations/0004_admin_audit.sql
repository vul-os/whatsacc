-- 0004_admin_audit.sql
-- Stage 4: admin-action trail (backend/migrations 20260505020000_admin.sql
-- admin_audit_log). Append-only; read via /v1/admin/audit/actions.

CREATE TABLE admin_audit_log (
    id            TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    target_kind   TEXT,
    target_id     TEXT,
    allowed       INTEGER NOT NULL,
    detail        TEXT NOT NULL DEFAULT '{}', -- json
    created_at    INTEGER NOT NULL
);
CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
