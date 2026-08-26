-- سجل الإشعارات المالية.
--
-- لماذا جدول لا عمود في `subscriptions`: الإشعار حدث له وقت، والاشتراك حالة.
-- عمود `notified_at` واحد يُكتب فوقه في الدورة التالية، فيضيع أثر ما أُرسل
-- ومتى — وهو أول ما يُسأل عنه عند خلاف مع عميل («لم يصلني تنبيه»).
--
-- `kind`:
--   grace_started — انتهت الفترة ودخل العميل مهلة السماح
--   suspended     — انقضت المهلة فأُوقفت الخدمة
CREATE TABLE IF NOT EXISTS billing_notices (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('grace_started', 'suspended')),
  period_end      TEXT,
  grace_ends_at   TEXT,
  -- الرسالة تُبنى وقت الإشعار وتُحفظ كما هي: تغيير الصياغة لاحقًا يجب ألا
  -- يغيّر ما يقول السجل إنه أُرسل.
  message         TEXT NOT NULL DEFAULT '',
  -- متى أبلغ صاحب اللوحة العميل فعلًا. يبقى فارغًا حتى يضغط «أُبلغ».
  delivered_at    TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_billing_notices_tenant ON billing_notices (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_notices_pending ON billing_notices (delivered_at, created_at);

-- إشعار واحد لكل حدث لكل دورة: تشغيل الوظيفة مرتين في اليوم نفسه لا يضاعف
-- السجل ولا يرسل تنبيهًا ثانيًا لعميل واحد.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_notices_once
  ON billing_notices (subscription_id, kind, period_end);
