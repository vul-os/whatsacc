-- 20260515000000_invoices_admin_write.sql
--
-- Fix: change-plan and wallet-topup verify flows write an invoice inside the
-- *user-scoped* transaction (they must — the accounts / account_subscriptions
-- policies require admin context), but the previous invoices_write policy
-- only permitted INSERT from the anonymous (server) context. The result was
-- that every successful Paystack redirect 500'd at createInvoice and no
-- invoices were ever issued from the user-facing flow.
--
-- Expand invoices_write so account admins can also write invoices for their
-- own account_id. The route handlers are the only writers in practice and
-- they validate the underlying payment with Paystack first; this matches the
-- pattern already used by invoices_select.

DROP POLICY IF EXISTS invoices_write ON invoices;

CREATE POLICY invoices_write ON invoices
    FOR ALL
    USING (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    )
    WITH CHECK (
        app.is_account_admin(account_id)
        OR app.current_user_id() IS NULL
        OR app.is_platform_admin()
    );
