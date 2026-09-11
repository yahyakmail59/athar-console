/**
 * عقد الأسعار: ما تقوله الهجرات هو ما يُقال للعميل.
 *
 * لماذا هذا الملف موجود: أسعار المطاعم كانت 1000/3000 في بذرة الهجرة،
 * و4000/6000 في الإنتاج، وصاحب المنصّة يقول 2000/4000 حين يُسأل. ثلاثة
 * أرقام لشيءٍ واحد — لأن الشاشة تعدّل الإنتاج ولا أثر لتعديلها في
 * المستودع. فقاعدةٌ تُبنى من الهجرات (فحصٌ، أو استعادة بعد كارثة) تعود
 * بسعرٍ قديم، ولا يُكتشف ذلك إلا في فاتورة.
 *
 * فيُبنى هنا مخطّطٌ كاملٌ من الهجرات وتُقرأ منه الأسعار.
 *
 * التشغيل: node --import ./tests/resolve-ts.mjs --test tests/pricing.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const migrationsDir = new URL('../migrations/', import.meta.url);

function builtFromMigrations() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
  return sqlite;
}

const db = builtFromMigrations();
const planOf = (id) => db.prepare(
  'SELECT id, default_price_minor AS price, currency, is_active FROM plans WHERE id = ?',
).get(id);

test('الأساسية للمطاعم عشرون دولارًا', () => {
  const plan = planOf('restaurant:menu');
  assert.equal(plan.price, 2000, 'القيمة بالسنت: 2000 = 20.00$');
  assert.equal(plan.currency, 'USD');
});

test('والكاملة أربعون', () => {
  assert.equal(planOf('restaurant:full').price, 4000);
});

test('والكاملة أغلى من الأساسية', () => {
  /* ليس تحصيل حاصل: `resolveDemoPlan` يختار الأغلى حين لا تُطلب باقة
     باسمها. فلو انعكس الترتيب لأنشأت التجارب على الباقة الناقصة، ولَما
     رأى العميل ما تبيعه له. */
  assert.ok(planOf('restaurant:full').price > planOf('restaurant:menu').price);
});

test('ولا سعر بالدولار الكامل بدل السنت في أيّ باقة', () => {
  /* الخطأ الذي يكلّف مئة ضعف: كتابة «20» بدل «2000». حارسٌ على كل
     الباقات لا على المطاعم وحدها. */
  const plans = db.prepare('SELECT id, default_price_minor AS price FROM plans WHERE is_active = 1').all();
  assert.ok(plans.length > 0, 'لا باقات في المخطّط');
  for (const plan of plans) {
    assert.ok(plan.price >= 100,
      `${plan.id} سعرها ${plan.price} — أقلّ من دولار، والأرجح أنها كُتبت بالدولار لا بالسنت`);
  }
});
