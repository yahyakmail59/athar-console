-- العملاء المحتملون من نموذج التواصل في موقع أثر.
--
-- جدول مستقل لا حقول مضافة إلى `customers`: الرسالة نصّ العميل وقت أن كتبه،
-- وله قيمة بذاته بعد أن يصير العميل زبونًا أو ينصرف. ودمجه في `notes` يفقد
-- التاريخ ويكبر بلا حدّ.
--
-- `source_id` فريد: هو معرّف الرسالة في قاعدة الموقع، فيجعل السحب المكرّر
-- بلا أثر (INSERT OR IGNORE). وهذا هو الحارس الحقيقي ضد الازدواج — لا
-- الإقرار، فالإقرار قد يسقط بعد الإدراج.
CREATE TABLE IF NOT EXISTS lead_messages (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL UNIQUE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  business_type TEXT NOT NULL DEFAULT '',
  service_label TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL,
  is_read       INTEGER NOT NULL DEFAULT 0,
  received_at   TEXT NOT NULL,
  imported_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_messages_customer ON lead_messages (customer_id);
CREATE INDEX IF NOT EXISTS idx_lead_messages_unread ON lead_messages (is_read, received_at DESC);
