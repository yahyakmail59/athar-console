-- Athar Control Plane v2.
-- This migration adds the canonical SaaS model and imports any legacy v1 rows.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name_ar     TEXT NOT NULL,
  name_en     TEXT NOT NULL DEFAULT '',
  adapter_url TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'maintenance', 'disabled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id                  TEXT PRIMARY KEY,
  product_id          TEXT NOT NULL,
  code                TEXT NOT NULL,
  name_ar             TEXT NOT NULL,
  name_en             TEXT NOT NULL DEFAULT '',
  description_ar      TEXT NOT NULL DEFAULT '',
  description_en      TEXT NOT NULL DEFAULT '',
  default_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (default_price_minor >= 0),
  currency            TEXT NOT NULL DEFAULT 'USD',
  billing_cycle       TEXT NOT NULL DEFAULT 'monthly'
                      CHECK (billing_cycle IN ('monthly', 'yearly', 'custom')),
  features_json       TEXT NOT NULL DEFAULT '{}',
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (product_id, code),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS customers (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'customer'
               CHECK (status IN ('lead', 'customer', 'inactive')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_kits (
  id                    TEXT PRIMARY KEY,
  product_id            TEXT NOT NULL,
  code                  TEXT NOT NULL,
  name                  TEXT NOT NULL,
  tokens_json           TEXT NOT NULL DEFAULT '{}',
  content_defaults_json TEXT NOT NULL DEFAULT '{}',
  assets_prefix         TEXT NOT NULL DEFAULT '',
  is_template           INTEGER NOT NULL DEFAULT 1 CHECK (is_template IN (0, 1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (product_id, code),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS tenants (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL,
  product_id          TEXT NOT NULL,
  external_tenant_id  TEXT NOT NULL DEFAULT '',
  legacy_client_id    TEXT UNIQUE,
  slug                TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  environment         TEXT NOT NULL CHECK (environment IN ('demo', 'production')),
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'provisioning', 'active', 'suspended', 'archived', 'failed', 'purging')),
  plan_id             TEXT NOT NULL,
  brand_kit_id        TEXT,
  public_url          TEXT NOT NULL DEFAULT '',
  admin_url           TEXT NOT NULL DEFAULT '',
  trial_expires_at    TEXT,
  last_health_status  TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (last_health_status IN ('unknown', 'healthy', 'degraded', 'unreachable')),
  last_health_at      TEXT,
  archived_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (product_id, slug),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (brand_kit_id) REFERENCES brand_kits(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL UNIQUE,
  plan_id              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('trialing', 'active', 'past_due', 'grace', 'suspended', 'cancelled')),
  price_minor          INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency             TEXT NOT NULL DEFAULT 'USD',
  billing_cycle        TEXT NOT NULL DEFAULT 'monthly'
                       CHECK (billing_cycle IN ('monthly', 'yearly', 'custom')),
  starts_at            TEXT NOT NULL,
  current_period_start TEXT,
  current_period_end   TEXT,
  grace_ends_at        TEXT,
  auto_suspend         INTEGER NOT NULL DEFAULT 0 CHECK (auto_suspend IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  legacy_payment_id TEXT UNIQUE,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  paid_at         TEXT NOT NULL,
  method          TEXT NOT NULL DEFAULT 'cash'
                  CHECK (method IN ('cash', 'wallet', 'bank_transfer', 'gateway', 'other')),
  reference       TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL DEFAULT 'platform-owner',
  created_at      TEXT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS domains (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  hostname          TEXT NOT NULL UNIQUE,
  type              TEXT NOT NULL CHECK (type IN ('workers_dev', 'platform_subdomain', 'custom')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'failed', 'disabled')),
  verification_json TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  action             TEXT NOT NULL
                     CHECK (action IN ('create', 'seed', 'promote', 'change_plan', 'suspend', 'resume', 'archive', 'purge', 'health_check')),
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  idempotency_key    TEXT NOT NULL UNIQUE,
  request_json       TEXT NOT NULL DEFAULT '{}',
  result_json        TEXT NOT NULL DEFAULT '{}',
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  last_error_code    TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  started_at         TEXT,
  finished_at        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('admin', 'system', 'adapter')),
  actor_id    TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json  TEXT NOT NULL DEFAULT '{}',
  ip_hash     TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plans_product_active ON plans(product_id, is_active);
CREATE INDEX IF NOT EXISTS idx_customers_status_name ON customers(status, display_name);
CREATE INDEX IF NOT EXISTS idx_tenants_product_status ON tenants(product_id, status);
CREATE INDEX IF NOT EXISTS idx_tenants_customer ON tenants(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tenants_environment ON tenants(environment, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_end ON subscriptions(status, current_period_end);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_sub ON subscription_payments(subscription_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_status ON provisioning_jobs(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- Stable product IDs are the same as product codes to simplify adapter contracts.
INSERT OR IGNORE INTO products (id, code, name_ar, name_en, status, created_at, updated_at) VALUES
  ('restaurant', 'restaurant', 'المطاعم والكافيهات', 'Restaurants & Cafes', 'active', datetime('now'), datetime('now')),
  ('school', 'school', 'المدارس', 'Schools', 'active', datetime('now'), datetime('now')),
  ('pharmacy', 'pharmacy', 'الصيدليات', 'Pharmacies', 'active', datetime('now'), datetime('now')),
  ('clinic', 'clinic', 'عيادات الأسنان', 'Dental Clinics', 'active', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO plans
  (id, product_id, code, name_ar, name_en, description_ar, default_price_minor, currency, billing_cycle, features_json, is_active, created_at, updated_at)
VALUES
  ('restaurant:menu', 'restaurant', 'menu', 'الأساسية', 'Basic', 'موقع ومنيو وطلب عبر واتساب', 1000, 'USD', 'monthly', '{"site":true,"menu":true,"whatsapp":true}', 1, datetime('now'), datetime('now')),
  ('restaurant:full', 'restaurant', 'full', 'الكاملة', 'Full', 'الطلبات والحجوزات والكاشير والعملاء والتقارير', 3000, 'USD', 'monthly', '{"site":true,"menu":true,"whatsapp":true,"orders":true,"reservations":true,"cashier":true,"crm":true,"reports":true}', 1, datetime('now'), datetime('now')),
  ('school:basic', 'school', 'basic', 'الأساسية', 'Basic', 'الطلاب والمعلمون والجدول والحضور والدرجات', 2500, 'USD', 'monthly', '{"students":true,"teachers":true,"timetable":true,"attendance":true,"grades":true}', 1, datetime('now'), datetime('now')),
  ('school:full', 'school', 'full', 'الكاملة', 'Full', 'الإدارة الكاملة مع المالية وأولياء الأمور', 4500, 'USD', 'monthly', '{"students":true,"teachers":true,"timetable":true,"attendance":true,"grades":true,"finance":true,"guardians":true}', 1, datetime('now'), datetime('now')),
  ('pharmacy:standard', 'pharmacy', 'standard', 'إدارة الصيدلية', 'Standard', 'باقة واحدة شاملة', 4000, 'USD', 'monthly', '{"all":true}', 1, datetime('now'), datetime('now')),
  ('clinic:standard', 'clinic', 'standard', 'إدارة العيادة', 'Standard', 'باقة واحدة شاملة', 4000, 'USD', 'monthly', '{"all":true}', 1, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO brand_kits
  (id, product_id, code, name, is_template, created_at, updated_at)
VALUES
  ('restaurant:blank', 'restaurant', 'blank', 'هوية مطعم فارغة', 1, datetime('now'), datetime('now')),
  ('school:default', 'school', 'default', 'هوية مدرسة افتراضية', 1, datetime('now'), datetime('now')),
  ('pharmacy:default', 'pharmacy', 'default', 'هوية صيدلية افتراضية', 1, datetime('now'), datetime('now')),
  ('clinic:default', 'clinic', 'default', 'هوية عيادة افتراضية', 1, datetime('now'), datetime('now'));

-- Import v1 clients without changing or deleting the legacy tables.
INSERT OR IGNORE INTO customers
  (id, display_name, phone, notes, status, created_at, updated_at)
SELECT
  'legacy-customer:' || id,
  name,
  COALESCE(contact, ''),
  COALESCE(notes, ''),
  CASE WHEN active = 1 THEN 'customer' ELSE 'inactive' END,
  created_at,
  datetime('now')
FROM clients;

INSERT OR IGNORE INTO tenants
  (id, customer_id, product_id, external_tenant_id, legacy_client_id, slug, display_name,
   environment, status, plan_id, public_url, created_at, updated_at)
SELECT
  id,
  'legacy-customer:' || id,
  product,
  slug,
  id,
  slug,
  name,
  'production',
  CASE WHEN active = 1 THEN 'active' ELSE 'suspended' END,
  CASE
    WHEN product = 'restaurant' AND plan IN ('menu', 'full') THEN 'restaurant:' || plan
    WHEN product = 'school' AND plan IN ('basic', 'full') THEN 'school:' || plan
    WHEN product = 'pharmacy' THEN 'pharmacy:standard'
    WHEN product = 'clinic' THEN 'clinic:standard'
    WHEN product = 'restaurant' THEN 'restaurant:menu'
    WHEN product = 'school' THEN 'school:basic'
    ELSE product || ':standard'
  END,
  '',
  created_at,
  datetime('now')
FROM clients
WHERE product IN ('restaurant', 'school', 'pharmacy', 'clinic');

INSERT OR IGNORE INTO subscriptions
  (id, tenant_id, plan_id, status, price_minor, currency, billing_cycle, starts_at,
   current_period_start, current_period_end, created_at, updated_at)
SELECT
  'subscription:' || id,
  id,
  CASE
    WHEN product = 'restaurant' AND plan IN ('menu', 'full') THEN 'restaurant:' || plan
    WHEN product = 'school' AND plan IN ('basic', 'full') THEN 'school:' || plan
    WHEN product = 'pharmacy' THEN 'pharmacy:standard'
    WHEN product = 'clinic' THEN 'clinic:standard'
    WHEN product = 'restaurant' THEN 'restaurant:menu'
    WHEN product = 'school' THEN 'school:basic'
    ELSE product || ':standard'
  END,
  CASE
    WHEN active = 0 THEN 'suspended'
    WHEN paid_until <> '' AND paid_until < date('now') THEN 'past_due'
    ELSE 'active'
  END,
  CAST(ROUND(price_usd * 100) AS INTEGER),
  'USD',
  'monthly',
  created_at,
  created_at,
  NULLIF(paid_until, ''),
  created_at,
  datetime('now')
FROM clients
WHERE product IN ('restaurant', 'school', 'pharmacy', 'clinic');

INSERT OR IGNORE INTO subscription_payments
  (id, subscription_id, customer_id, legacy_payment_id, amount_minor, currency,
   paid_at, method, created_by, created_at)
SELECT
  'legacy-payment:' || payments.id,
  'subscription:' || payments.client_id,
  'legacy-customer:' || payments.client_id,
  payments.id,
  CAST(ROUND(payments.amount_usd * 100) AS INTEGER),
  'USD',
  payments.paid_on,
  CASE WHEN payments.method IN ('cash', 'wallet', 'bank_transfer', 'gateway', 'other')
       THEN payments.method ELSE 'other' END,
  'legacy-import',
  payments.paid_on
FROM payments
JOIN tenants ON tenants.id = payments.client_id
WHERE payments.amount_usd > 0;
