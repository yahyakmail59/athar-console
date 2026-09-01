-- فصلُ أضنة عن B12 — بالقياس لا بالرأي.
--
-- كان في القائمة خيارٌ واحد لمطعمين: «شبيه أضنة و B12». وسببُه أن ملفَّي
-- CSS عندهما متطابقان في ثمانية عشر رمزًا. والقياس الأعمق قال غير ذلك:
--
--   شعار B12         أحمرُ وأبيضُ على أسود — ولا ذهبَ فيه إطلاقًا.
--   شعار أضنة        ذهبٌ خطُّه عربيٌّ على كحليّ.
--   دليلُ علامة أضنة  يكتب صراحةً: كحليّ #0B1D2D · ذهبيّ #D4AF37 ·
--                    سطحٌ #12293D · ورقٌ كرافتيّ #E3CDA4.
--   وثائقُ مشروعها    «موقع أضنة بهوية فاخرة، على باك-إند B12 الكامل».
--
-- فالتطابق كان في الشيفرة المنسوخة لا في العلامتين.
--
-- **والمعرّف هو ما يصل المحرك، لا العمود `code`.** اللوحة ترسل
-- `brand_kit_id` كاملًا، والمحرك يقصّ ما قبل النقطتين
-- (`split(':').pop()`). فصفٌّ معرّفه `restaurant:luxury_navy` يُنشئ
-- «الفاخر» مهما كُتب في عموده. ولذلك تُدرَج صفوفٌ جديدة بمعرّفات صحيحة
-- ولا يُعاد تسمية القديمة.
--
-- والترتيب مقصود: إدراجٌ، ثم تحويلُ من يشير إلى القديم، ثم حذف. فالمفتاح
-- الأجنبيّ `ON DELETE SET NULL` — حذفٌ قبل التحويل يمحو اختيارَ المستأجر
-- بصمت.

INSERT OR IGNORE INTO brand_kits (id, product_id, code, name, is_template, created_at, updated_at)
VALUES
  ('restaurant:b12_red', 'restaurant', 'b12_red',
   'شبيه B12 — أحمر وفضّي على أسود', 1, datetime('now'), datetime('now')),
  ('restaurant:adana_navy', 'restaurant', 'adana_navy',
   'شبيه أضنة — ذهبيّ على كحليّ', 1, datetime('now'), datetime('now')),
  ('restaurant:luxury_burgundy', 'restaurant', 'luxury_burgundy',
   'الفاخر — نبيذيّ وشمبانيا', 1, datetime('now'), datetime('now'));

-- المستأجر الذي اختار «الفاخر — كحلي وذهبي» موقعُه كحليٌّ ذهبيّ اليوم:
-- تلك قيمُ الهوية التي كُتبت في `settings` عند إنشائه. وهي بعينها هوية
-- أضنة. فتحويله إليها يجعل سجلَّه أصدقَ لا أكذب — ولا يتبدّل شكل موقعه،
-- لأن الهوية تُطبَّق مرّة عند الإنشاء ثم تصير ملك المطعم.
UPDATE tenants
   SET brand_kit_id = 'restaurant:adana_navy',
       updated_at = datetime('now')
 WHERE brand_kit_id = 'restaurant:luxury_navy';

UPDATE tenants
   SET brand_kit_id = 'restaurant:b12_red',
       updated_at = datetime('now')
 WHERE brand_kit_id = 'restaurant:adana_classic';

DELETE FROM brand_kits WHERE id = 'restaurant:adana_classic';
DELETE FROM brand_kits WHERE id = 'restaurant:luxury_navy';
