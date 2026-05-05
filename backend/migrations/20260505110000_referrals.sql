-- 20260505110000_referrals.sql
-- Referral program: per-user slug, attribution, ongoing earnings ledger,
-- KYC profile (required before payout), and payout requests.

-- ---------------------------------------------------------------------------
-- users: slug + referrer pointer
-- ---------------------------------------------------------------------------
ALTER TABLE users
    ADD COLUMN referral_slug text NULL,
    ADD COLUMN referral_slug_updated_at timestamptz NULL,
    ADD COLUMN referred_by_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN referral_attributed_at timestamptz NULL;

ALTER TABLE users
    ADD CONSTRAINT users_referral_slug_format CHECK (
        referral_slug IS NULL
        OR (
            length(referral_slug) BETWEEN 3 AND 30
            AND referral_slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'
            AND referral_slug !~ '--'
        )
    );

CREATE UNIQUE INDEX users_referral_slug_idx
    ON users (referral_slug)
    WHERE referral_slug IS NOT NULL;
CREATE INDEX users_referred_by_user_id_idx ON users (referred_by_user_id);

-- ---------------------------------------------------------------------------
-- attribution: one row per referee, locks who they belong to
-- ---------------------------------------------------------------------------
CREATE TABLE referral_attributions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    via_slug text NOT NULL,
    landed_at timestamptz NULL,
    attributed_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    UNIQUE (referee_user_id),
    CHECK (referrer_user_id <> referee_user_id)
);
COMMENT ON TABLE referral_attributions IS 'Locks each referee to exactly one referrer for life.';
CREATE INDEX referral_attributions_referrer_idx
    ON referral_attributions (referrer_user_id);

-- ---------------------------------------------------------------------------
-- earnings ledger: one row per crediting event
-- ---------------------------------------------------------------------------
CREATE TABLE referral_earnings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_payment_intent_id uuid NULL REFERENCES payment_intents(id) ON DELETE SET NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('wallet_topup','subscription','adjustment')),
    amount_zar_cents bigint NOT NULL CHECK (amount_zar_cents > 0),
    rate_bps int NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
    note text NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE referral_earnings IS 'Append-only ledger of referral credits.';
CREATE INDEX referral_earnings_referrer_created_idx
    ON referral_earnings (referrer_user_id, created_at DESC);
CREATE UNIQUE INDEX referral_earnings_per_intent_idx
    ON referral_earnings (source_payment_intent_id)
    WHERE source_payment_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- KYC profile: required before a payout can be requested
-- ---------------------------------------------------------------------------
CREATE TABLE kyc_profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    full_name text NULL,
    contact_email citext NULL,
    cellphone text NULL,
    id_kind text NULL CHECK (id_kind IS NULL OR id_kind IN ('za_id','passport')),
    id_number text NULL,
    bank_name text NULL,
    bank_branch_code text NULL,
    bank_account_number text NULL,
    bank_account_holder text NULL,
    bank_account_type text NULL CHECK (
        bank_account_type IS NULL OR bank_account_type IN ('cheque','savings','transmission')
    ),
    verified_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE kyc_profiles IS 'KYC details captured before payout. One per user.';

-- ---------------------------------------------------------------------------
-- payout requests
-- ---------------------------------------------------------------------------
CREATE TABLE payout_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_zar_cents bigint NOT NULL CHECK (amount_zar_cents > 0),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','paid','rejected','cancelled')),
    -- KYC values frozen at request time so historical records stay accurate.
    kyc_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    paystack_transfer_code text NULL,
    notes text NULL,
    requested_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    processed_at timestamptz NULL,
    processed_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE payout_requests IS 'User-initiated payout against earned referral balance.';
CREATE INDEX payout_requests_user_status_idx ON payout_requests (user_id, status);
CREATE INDEX payout_requests_status_idx ON payout_requests (status);

-- ---------------------------------------------------------------------------
-- trigger: when a payment intent flips to succeeded, write a referral earning
-- if the payer's user has a referrer. Idempotent via the unique-per-intent
-- index, so reruns are safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.payment_intents_attribute_referral()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    referrer uuid;
    rate_bps_val int := 1000;  -- 10%
    payer uuid;
BEGIN
    IF NEW.status <> 'succeeded' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN
        RETURN NEW;
    END IF;
    IF NEW.purpose <> 'wallet_topup' THEN
        RETURN NEW;
    END IF;

    payer := NEW.initiated_by;
    IF payer IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT referred_by_user_id INTO referrer FROM users WHERE id = payer;
    IF referrer IS NULL OR referrer = payer THEN
        RETURN NEW;
    END IF;

    INSERT INTO referral_earnings
        (referrer_user_id, referee_user_id, source_payment_intent_id,
         source_kind, amount_zar_cents, rate_bps)
    VALUES
        (referrer, payer, NEW.id, 'wallet_topup',
         GREATEST(1, (NEW.amount_cents * rate_bps_val) / 10000),
         rate_bps_val)
    ON CONFLICT (source_payment_intent_id) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_intents_attribute_referral_trg ON payment_intents;
CREATE TRIGGER payment_intents_attribute_referral_trg
AFTER INSERT OR UPDATE ON payment_intents
FOR EACH ROW EXECUTE FUNCTION app.payment_intents_attribute_referral();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

-- referral_attributions: visible to either side of the relationship + admin.
-- Writes only by the trigger / app via anon (current_user_id IS NULL).
ALTER TABLE referral_attributions ENABLE ROW LEVEL SECURITY;
CREATE POLICY referral_attributions_select ON referral_attributions
    FOR SELECT
    USING (
        referrer_user_id = app.current_user_id()
        OR referee_user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY referral_attributions_write ON referral_attributions
    FOR INSERT
    WITH CHECK (app.current_user_id() IS NULL OR app.is_platform_admin());

-- referral_earnings: a referrer reads their own. Writes only via system path.
ALTER TABLE referral_earnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY referral_earnings_select ON referral_earnings
    FOR SELECT
    USING (
        referrer_user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY referral_earnings_write ON referral_earnings
    FOR INSERT
    WITH CHECK (app.current_user_id() IS NULL OR app.is_platform_admin());

-- kyc_profiles: each user manages their own.
ALTER TABLE kyc_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY kyc_profiles_self ON kyc_profiles
    FOR ALL
    USING (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );

-- payout_requests: user reads/creates their own; user can cancel pending;
-- admin owns approve/pay/reject.
ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY payout_requests_select ON payout_requests
    FOR SELECT
    USING (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY payout_requests_insert ON payout_requests
    FOR INSERT
    WITH CHECK (
        user_id = app.current_user_id()
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
CREATE POLICY payout_requests_cancel ON payout_requests
    FOR UPDATE
    USING (user_id = app.current_user_id() AND status = 'pending')
    WITH CHECK (user_id = app.current_user_id() AND status IN ('pending','cancelled'));
CREATE POLICY payout_requests_admin ON payout_requests
    FOR UPDATE
    USING (app.is_platform_admin() OR app.current_user_id() IS NULL)
    WITH CHECK (app.is_platform_admin() OR app.current_user_id() IS NULL);
