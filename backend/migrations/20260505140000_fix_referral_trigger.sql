-- 20260505140000_fix_referral_trigger.sql
-- The referral attribution trigger writes referral_earnings with
-- ON CONFLICT (source_payment_intent_id), but that column has a partial
-- unique index (WHERE source_payment_intent_id IS NOT NULL). Postgres
-- requires the predicate be repeated on ON CONFLICT for inference; without
-- it Postgres raises 42P10 ("there is no unique or exclusion constraint
-- matching the ON CONFLICT specification") and the trigger aborts the
-- caller's UPDATE, blocking the wallet credit.

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
    ON CONFLICT (source_payment_intent_id)
        WHERE source_payment_intent_id IS NOT NULL
        DO NOTHING;

    RETURN NEW;
END;
$$;
