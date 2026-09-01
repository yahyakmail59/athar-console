/**
 * قائمة الهويات في اللوحة تطابق ما يفهمه المحرك.
 *
 * لماذا هذا الملف موجود: اللوحة تقرأ الهويات من جدولها `brand_kits`،
 * والمحرك يطبّقها من `worker/brandkits.js` عنده. قائمتان في مكانين —
 * ورمزٌ في اللوحة لا يعرفه المحرك **يسقط بصمت إلى الافتراضية**: يختار
 * المشغّل «الزيتون والنحاس» فيُنشأ المطعم أحمرَ داكنًا، ولا رسالة ولا
 * سجلّ. يفتح صاحب المطعم موقعه فيجد هوية لم يطلبها أحد.
 *
 * **والمقروء هنا المعرّف لا العمود `code`.** اللوحة ترسل `brand_kit_id`
 * كاملًا في `brand_kit_code` (انظر `src/index.ts`)، والمحرك يقصّ ما قبل
 * النقطتين: `str(body.brand_kit_code, 80).split(':').pop()`. فصفٌّ
 * معرّفه `restaurant:luxury_navy` وعمودُه `adana_navy` يُنشئ «الفاخر»
 * ويعرض «أضنة» — ولا شيء يُخطئ. ولذلك يُقاس المعرّف، ويُفحَص أن العمود
 * يطابقه حتى لا يفترقا مستقبلًا.
 *
 * والفحص يقرأ الترحيلات — ما سيصير في القاعدة فعلًا — لا القاعدة الحيّة:
 * اختبارٌ يحتاج شبكةً لا يُشغَّل، واختبارٌ لا يُشغَّل لا يحرس شيئًا.
 *
 * التشغيل: node --test tests/brand-kits.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const ENGINE = new URL('../../athar-restaurant/worker/brandkits.js', import.meta.url);

/**
 * ما ستعرضه القائمة بعد كل الترحيلات — بمعرّفاته كما يصل المحرك.
 *
 * يعيد `{ offered, mismatched }`: الأولى مجموعةُ لواحق المعرّفات، والثانية
 * صفوفٌ عمودُ `code` فيها يخالف لاحقة معرّفها.
 */
function offeredFromMigrations() {
  const dir = new URL('../migrations/', import.meta.url);
  const offered = new Set();
  const mismatched = [];

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(new URL(file, dir), 'utf8');

    // بعبارةٍ عبارة، ولا تُقرأ إلا التي تمسّ `brand_kits`: ملفّ الترحيلات
    // يحمل جداول أخرى تُدرَج فيها كلمة `restaurant` نفسها — الباقات
    // والمنتجات — فمسحٌ عامّ يلتقطها ويُنذر على رموز لا وجود لها.
    for (const stmt of sql.split(';')) {
      if (!/brand_kits/i.test(stmt)) continue;

      if (/INSERT[\s\S]*INTO\s+brand_kits/i.test(stmt)) {
        for (const m of stmt.matchAll(/'restaurant:([a-z0-9_]+)',\s*'restaurant',\s*'([a-z0-9_]+)'/g)) {
          const [, id, code] = m;
          offered.add(id);
          if (id !== code) mismatched.push(`${file}: المعرّف ${id} وعمودُه ${code}`);
        }
        continue;
      }

      const dropped = stmt.match(/DELETE\s+FROM\s+brand_kits[\s\S]*?id\s*=\s*'restaurant:([a-z0-9_]+)'/i);
      if (dropped) offered.delete(dropped[1]);
    }
  }

  offered.delete('blank'); // «بلا هوية» خيارٌ في اللوحة لا هويةٌ في المحرك
  return { offered, mismatched };
}

test('كل هوية معروضة يعرفها المحرك باسمها لا بكنيتها', async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip('محرك المطاعم غير موجود بجوار اللوحة');
    return;
  }
  const { BRAND_KITS } = await import(ENGINE.href);
  const { offered } = offeredFromMigrations();

  // لا يكفي أن تُحلّ الكنية: `resolveBrandKit('luxury_navy')` تعطي
  // النبيذيّ، فتُنشأ هوية غير المعروضة بلا خطأ. المعروض يجب أن يكون
  // اسمًا قائمًا في البنك.
  const unknown = [...offered].filter((code) => !BRAND_KITS[code]);

  assert.deepEqual(unknown, [],
    `معرّفات تعرضها اللوحة وليست أسماءً قائمة في المحرك: ${unknown.join(', ')}`);
});

test('وكل هوية في المحرك معروضة في اللوحة', async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip('محرك المطاعم غير موجود بجوار اللوحة');
    return;
  }
  const { BRAND_KIT_ORDER } = await import(ENGINE.href);
  const { offered } = offeredFromMigrations();
  const hidden = BRAND_KIT_ORDER.filter((code) => !offered.has(code));

  assert.deepEqual(hidden, [],
    `هويات مبنيّة في المحرك ولا تظهر في قائمة اللوحة: ${hidden.join(', ')}`);
});

test('ولاحقة المعرّف هي عمود الرمز نفسه', () => {
  const { mismatched } = offeredFromMigrations();
  assert.deepEqual(mismatched, [],
    `المحرك يقرأ لاحقة المعرّف والمشغّل يقرأ الاسم — فيفترق ما يُعرض عمّا يُنشأ:\n${mismatched.join('\n')}`);
});

test('والأسماء المتقاعدة لا تبقى معروضة', () => {
  const { offered } = offeredFromMigrations();
  for (const retired of ['adana_classic', 'adana_b12', 'luxury_navy']) {
    assert.ok(!offered.has(retired),
      `${retired} ما زال في القائمة — واسمٌ متقاعد يُعرض يُنشئ هويةً باسمٍ آخر`);
  }
  for (const wanted of ['b12_red', 'adana_navy', 'luxury_burgundy']) {
    assert.ok(offered.has(wanted), `${wanted} لم يصل القائمة`);
  }
});
