-- بنك هويات المطاعم، الإصدار الثاني.
--
-- ثلاثة تغييرات، ولكلٍّ سبب:
--
-- 1) `adana_classic` صار `adana_b12`. قُورن ثمانية عشر رمزًا بين مشروعَي
--    أضنة وB12 فتطابقت كلّها — الأحمر والذهبيّ والأرضية والسطح والخطوط
--    الأربعة. فهما تصميم واحد، واسمٌ يذكرهما معًا أصدق من هويتين
--    متطابقتين تُربكان من يختار. والاسم القديم يُحلّ إلى الجديد في
--    `brandkits.js`، فمطعمٌ أُنشئ به لا يسقط إلى الافتراضية بصمت.
--
-- 2) هويتان فاتحتان تُضافان لأول مرة: المحرك كان داكنًا في بنيته حتى
--    اليوم، فبنكٌ داكن كلّه كان يُغلق سوق الكافيهات والمخابز.
--
-- 3) الأسماء تحمل المرجع صراحةً بطلب المشغّل.
--
-- والقيم هنا للعرض في القائمة وحدها؛ القيم العاملة في `brandkits.js`
-- داخل المحرك. وحارسٌ في `tests/brand-kits.contract.test.mjs` يمنع
-- تفرّقهما.

UPDATE brand_kits
   SET code = 'adana_b12',
       name = 'شبيه أضنة و B12 — أحمر وذهبي',
       updated_at = datetime('now')
 WHERE product_id = 'restaurant' AND code = 'adana_classic';

UPDATE brand_kits SET name = 'الحيوي — زمردي', updated_at = datetime('now')
 WHERE product_id = 'restaurant' AND code = 'vibrant_emerald';

UPDATE brand_kits SET name = 'الدافئ — كهرماني', updated_at = datetime('now')
 WHERE product_id = 'restaurant' AND code = 'warm_amber';

INSERT OR IGNORE INTO brand_kits (id, product_id, code, name, is_template, created_at, updated_at)
VALUES
  ('restaurant:fries_station', 'restaurant', 'fries_station',
   'شبيه Fries Station — أحمر وكهرماني، فاتح', 1, datetime('now'), datetime('now')),
  ('restaurant:olive_copper', 'restaurant', 'olive_copper',
   'الزيتون والنحاس — فاتح', 1, datetime('now'), datetime('now'));
