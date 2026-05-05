-- 20260505080000_geo_currency.sql
-- Currencies, countries, FX rates, and country binding for accounts/users.
-- All native pricing is stored in ZAR; currencies provide display conversion
-- via fx_rates (currency -> ZAR).

CREATE TABLE currencies (
    code text PRIMARY KEY CHECK (length(code) = 3 AND code = upper(code)),
    name text NOT NULL,
    symbol text NOT NULL,
    decimals smallint NOT NULL DEFAULT 2 CHECK (decimals >= 0 AND decimals <= 4),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE currencies IS 'Supported display currencies. Native ledger is ZAR.';

CREATE TABLE fx_rates (
    currency_code text PRIMARY KEY REFERENCES currencies(code) ON DELETE CASCADE,
    -- 1 unit of currency = `rate_to_zar` ZAR. Display = zar / rate_to_zar.
    rate_to_zar numeric(18,8) NOT NULL CHECK (rate_to_zar > 0),
    source text NOT NULL DEFAULT 'seed',
    fetched_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE fx_rates IS 'Latest FX rate per currency relative to ZAR. Refreshed by cron.';

CREATE TABLE countries (
    code text PRIMARY KEY CHECK (length(code) = 2 AND code = upper(code)),
    name text NOT NULL,
    flag_emoji text NOT NULL,
    currency_code text NOT NULL REFERENCES currencies(code),
    -- WhatsApp business-initiated conversation cost in ZAR.
    msg_cost_zar numeric(10,4) NOT NULL DEFAULT 0,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
COMMENT ON TABLE countries IS 'Supported countries with WhatsApp conversation cost in ZAR.';
CREATE INDEX countries_currency_code_idx ON countries (currency_code);

INSERT INTO currencies (code, name, symbol, decimals) VALUES
    ('ZAR', 'South African Rand',  'R',     2),
    ('USD', 'US Dollar',           '$',     2),
    ('EUR', 'Euro',                '€',     2),
    ('GBP', 'British Pound',       '£',     2),
    ('CAD', 'Canadian Dollar',     'C$',    2),
    ('AUD', 'Australian Dollar',   'A$',    2),
    ('BRL', 'Brazilian Real',      'R$',    2),
    ('MXN', 'Mexican Peso',        'Mex$',  2),
    ('INR', 'Indian Rupee',        '₹',     0),
    ('IDR', 'Indonesian Rupiah',   'Rp',    0),
    ('PHP', 'Philippine Peso',     '₱',     0),
    ('NGN', 'Nigerian Naira',      '₦',     0),
    ('KES', 'Kenyan Shilling',     'KSh',   2),
    ('AED', 'UAE Dirham',          'د.إ',   2);

INSERT INTO fx_rates (currency_code, rate_to_zar, source) VALUES
    ('ZAR', 1.0,     'seed'),
    ('USD', 18.5,    'seed'),
    ('EUR', 20.0,    'seed'),
    ('GBP', 24.0,    'seed'),
    ('CAD', 13.5,    'seed'),
    ('AUD', 12.0,    'seed'),
    ('BRL', 3.2,     'seed'),
    ('MXN', 1.0,     'seed'),
    ('INR', 0.22,    'seed'),
    ('IDR', 0.0012,  'seed'),
    ('PHP', 0.32,    'seed'),
    ('NGN', 0.012,   'seed'),
    ('KES', 0.14,    'seed'),
    ('AED', 5.0,     'seed');

INSERT INTO countries (code, name, flag_emoji, currency_code, msg_cost_zar) VALUES
    ('ZA', 'South Africa',   '🇿🇦', 'ZAR', 0.148),
    ('NG', 'Nigeria',        '🇳🇬', 'NGN', 0.122),
    ('KE', 'Kenya',          '🇰🇪', 'KES', 0.407),
    ('US', 'United States',  '🇺🇸', 'USD', 0.463),
    ('CA', 'Canada',         '🇨🇦', 'CAD', 0.463),
    ('BR', 'Brazil',         '🇧🇷', 'BRL', 0.093),
    ('MX', 'Mexico',         '🇲🇽', 'MXN', 0.113),
    ('GB', 'United Kingdom', '🇬🇧', 'GBP', 0.407),
    ('DE', 'Germany',        '🇩🇪', 'EUR', 0.407),
    ('FR', 'France',         '🇫🇷', 'EUR', 0.407),
    ('AE', 'UAE',            '🇦🇪', 'AED', 0.352),
    ('IN', 'India',          '🇮🇳', 'INR', 0.065),
    ('ID', 'Indonesia',      '🇮🇩', 'IDR', 0.191),
    ('PH', 'Philippines',    '🇵🇭', 'PHP', 0.178),
    ('AU', 'Australia',      '🇦🇺', 'AUD', 0.507);

-- Bind accounts and profiles to a country. Default to ZA (made in Durban).
ALTER TABLE accounts
    ADD COLUMN country_code text NOT NULL DEFAULT 'ZA' REFERENCES countries(code);
CREATE INDEX accounts_country_code_idx ON accounts (country_code);

ALTER TABLE profiles
    ADD COLUMN country_code text NULL REFERENCES countries(code);

-- Reference tables are world-readable; writes restricted to platform admin.
ALTER TABLE currencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY currencies_read ON currencies FOR SELECT USING (true);
CREATE POLICY currencies_insert ON currencies FOR INSERT WITH CHECK (app.is_platform_admin());
CREATE POLICY currencies_update ON currencies FOR UPDATE USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY currencies_delete ON currencies FOR DELETE USING (app.is_platform_admin());

ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY fx_rates_read ON fx_rates FOR SELECT USING (true);
CREATE POLICY fx_rates_insert ON fx_rates FOR INSERT WITH CHECK (app.is_platform_admin());
CREATE POLICY fx_rates_update ON fx_rates FOR UPDATE USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY fx_rates_delete ON fx_rates FOR DELETE USING (app.is_platform_admin());

ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
CREATE POLICY countries_read ON countries FOR SELECT USING (true);
CREATE POLICY countries_insert ON countries FOR INSERT WITH CHECK (app.is_platform_admin());
CREATE POLICY countries_update ON countries FOR UPDATE USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY countries_delete ON countries FOR DELETE USING (app.is_platform_admin());
