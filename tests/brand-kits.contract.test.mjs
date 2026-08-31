/**
 * قائمة الهويات في اللوحة تطابق ما يفهمه المحرك.
 *
 * لماذا هذا الملف موجود: اللوحة تقرأ الهويات من جدولها `brand_kits`،
 * والمحرك يطبّقها من `worker/brandkits.js` عنده. قائمتان في مكانين —
 * ورمزٌ في اللوحة لا يعرفه المحرك **يسقط بصمت إلى الافتراضية**: يختار
 * المشغّل «الزيتون والنحاس» فيُنشأ المطعم أحمرَ داكنًا، ولا رسالة ولا
 * سجلّ. يفتح صاحب المطعم موقعه فيجد هوية لم يطلبها أحد.
 *
 * والفحص يقرأ الترحيلات — ما سيصير في القاعدة فعلًا — ويقارنه بملف
 * الهويات في المحرك. فأي هوية تُضاف في مكان دون الآخر تُسمّى بالاسم.
 *
 * ولا يقرأ القاعدة الحيّة عمدًا: اختبارٌ يحتاج شبكةً لا يُشغَّل، واختبارٌ
 * لا يُشغَّل لا يحرس شيئًا.
 *
 * التشغيل: node --test tests/brand-kits.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const ENGINE = new URL('../../athar-restaurant/worker/brandkits.js', import.meta.url);

/** رموز هويات المطاعم كما ستستقرّ في `brand_kits` بعد كل الترحيلات. */
function codesFromMigrations() {
  const dir = new URL('../migrations/', import.meta.url);
  const codes = new Set();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(new URL(file, dir), 'utf8');

    // بعبارةٍ عبارة، ولا تُقرأ إلا التي تمسّ `brand_kits`: ملفّ الترحيلات
    // يحمل جداول أخرى تُدرَج فيها كلمة `restaurant` نفسها — الباقات
    // والمنتجات — فمسحٌ عامّ يلتقطها ويُنذر على رموز لا وجود لها.
    for (const stmt of sql.split(';')) {
      if (!/brand_kits/i.test(stmt)) continue;

      if (/INSERT[\s\S]*INTO\s+brand_kits/i.test(stmt)) {
        for (const m of stmt.matchAll(/'restaurant:[a-z0-9_]+',\s*'restaurant',\s*'([a-z0-9_]+)'/g)) {
          codes.add(m[1]);
        }
        continue;
      }

      const rename = stmt.match(/UPDATE\s+brand_kits[\s\S]*?SET\s+code\s*=\s*'([a-z0-9_]+)'[\s\S]*?code\s*=\s*'([a-z0-9_]+)'/i);
      if (rename) {
        codes.add(rename[1]);
        codes.delete(rename[2]);
      }
    }
  }
  codes.delete('blank'); // «بلا هوية» خيارٌ في اللوحة لا هويةٌ في المحرك
  return codes;
}

test('كل رمز في اللوحة يعرفه المحرك', async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip('محرك المطاعم غير موجود بجوار اللوحة');
    return;
  }
  const { BRAND_KITS } = await import(ENGINE.href);
  const inConsole = codesFromMigrations();
  const unknown = [...inConsole].filter((code) => !BRAND_KITS[code]);

  assert.deepEqual(unknown, [],
    `رموز تعرضها اللوحة ولا يعرفها المحرك — تسقط بصمت إلى الافتراضية: ${unknown.join(', ')}`);
});

test('وكل هوية في المحرك معروضة في اللوحة', async (t) => {
  if (!existsSync(ENGINE)) {
    t.skip('محرك المطاعم غير موجود بجوار اللوحة');
    return;
  }
  const { BRAND_KIT_ORDER } = await import(ENGINE.href);
  const inConsole = codesFromMigrations();
  const hidden = BRAND_KIT_ORDER.filter((code) => !inConsole.has(code));

  assert.deepEqual(hidden, [],
    `هويات مبنيّة في المحرك ولا تظهر في قائمة اللوحة: ${hidden.join(', ')}`);
});

test('والاسم القديم لا يبقى معروضًا بعد إعادة التسمية', () => {
  const inConsole = codesFromMigrations();
  assert.ok(!inConsole.has('adana_classic'),
    'الاسم القديم ما زال في القائمة — فيظهر خياران لهوية واحدة');
  assert.ok(inConsole.has('adana_b12'), 'الاسم الجديد لم يصل القائمة');
});
