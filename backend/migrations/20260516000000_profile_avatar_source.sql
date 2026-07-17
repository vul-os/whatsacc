-- 20260516000000_profile_avatar_source.sql
--
-- Track the source of a profile avatar so Google sign-in can refresh the
-- picture without overwriting a user-set avatar.
--
--   'google'  — last set from the Google `picture` claim on sign-in.
--               Will be refreshed on every subsequent Google sign-in.
--   'user'    — last set by the account holder via PATCH /auth/me/profile.
--               Sign-in MUST NOT overwrite this.
--   NULL      — no avatar set, or set before this migration; treated as
--               'google' for refresh purposes (so the next sign-in picks
--               up Google's current picture).
--
-- avatar_cdn_url is a forward-compatibility hook. Phase 2 will populate it
-- with a BunnyCDN-cached version of avatar_url; phase 1 leaves it NULL and
-- the frontend falls back to avatar_url. Adding the column now lets phase 2
-- ship without another schema migration.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS avatar_source text NULL
        CHECK (avatar_source IS NULL OR avatar_source IN ('google', 'user')),
    ADD COLUMN IF NOT EXISTS avatar_cdn_url text NULL;

-- Backfill: existing rows with an avatar_url were all written by the Google
-- sign-up path (only existing writer to this column). Mark them so refresh
-- works on next sign-in.
UPDATE profiles
   SET avatar_source = 'google'
 WHERE avatar_url IS NOT NULL
   AND avatar_source IS NULL;
