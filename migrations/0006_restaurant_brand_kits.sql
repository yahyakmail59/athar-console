-- أربع هويات جاهزة لمحرك المطاعم — تُختار عند إنشاء مطعم من اللوحة، ثم
-- يعدّلها المطعم بحرّية من لوحته. القيم الفعلية (الألوان والخطوط وطبقة
-- الثيم) مصدرها الوحيد `athar-restaurant/worker/brandkits.js`؛ هذا الجدول
-- يحمل فقط الاسم المعروض والوصف لملء قائمة الاختيار في اللوحة.
INSERT OR IGNORE INTO brand_kits (id, product_id, code, name, is_template, created_at, updated_at) VALUES
  ('restaurant:adana_classic', 'restaurant', 'adana_classic',
   'الأصلي — أحمر وذهبي', 1, datetime('now'), datetime('now')),
  ('restaurant:luxury_navy', 'restaurant', 'luxury_navy',
   'الفاخر — كحلي وذهبي', 1, datetime('now'), datetime('now')),
  ('restaurant:vibrant_emerald', 'restaurant', 'vibrant_emerald',
   'الحيوي — زمردي', 1, datetime('now'), datetime('now')),
  ('restaurant:warm_amber', 'restaurant', 'warm_amber',
   'الدافئ — كهرماني', 1, datetime('now'), datetime('now'));
