-- توسيع الإجراءات المسموحة في provisioning_jobs.
--
-- القيد الأصلي لم يعرف `restore` ولا `reset_owner_pin`، فكانت الاستعادة من
-- الأرشيف تفشل بخطأ 500 عند إدراج المهمة، وكانت إعادة تعيين الرقم السري
-- تُسجَّل باسم `change_plan` فيصبح سجل المهام مضلّلًا.
--
-- SQLite لا يعدّل CHECK، فالطريقة الوحيدة إعادة بناء الجدول ونقل الصفوف.

PRAGMA foreign_keys = OFF;

CREATE TABLE provisioning_jobs_v2 (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  action             TEXT NOT NULL
                     CHECK (action IN ('create', 'seed', 'promote', 'change_plan', 'suspend',
                                       'resume', 'archive', 'restore', 'purge', 'health_check',
                                       'reset_owner_pin')),
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

INSERT INTO provisioning_jobs_v2
  (id, tenant_id, action, status, idempotency_key, request_json, result_json, attempts,
   max_attempts, last_error_code, last_error_message, started_at, finished_at, created_at, updated_at)
SELECT
  id, tenant_id, action, status, idempotency_key, request_json, result_json, attempts,
  max_attempts, last_error_code, last_error_message, started_at, finished_at, created_at, updated_at
FROM provisioning_jobs;

DROP TABLE provisioning_jobs;

ALTER TABLE provisioning_jobs_v2 RENAME TO provisioning_jobs;

CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_tenant
  ON provisioning_jobs (tenant_id, created_at);

PRAGMA foreign_keys = ON;
