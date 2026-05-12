-- 20260512010000_backfill_location_members.sql
-- Keep per-location membership in step with account membership so users can
-- see the locations and access points attached to accounts they joined.

INSERT INTO location_members (location_id, user_id, role)
SELECT l.id, am.user_id, am.role
FROM locations l
JOIN account_members am ON am.account_id = l.account_id
WHERE am.status = 'active'
ON CONFLICT (location_id, user_id)
DO UPDATE SET role = excluded.role, updated_at = now();
