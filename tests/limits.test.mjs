/**
 * مراقبة حدود المنصة.
 *
 * التحذير الذي لا يظهر حين يجب أعمى، والذي يظهر دائمًا ضجيج يُهمَل. فكل
 * فحص هنا يسأل: **متى يجب أن يصرخ، ومتى يجب أن يصمت؟**
 *
 * التشغيل: node --test tests/limits.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { d1Usage, r2Usage, limitWarnings, limitsReport } = await import('../src/limits.ts');

const MB = 1024 * 1024;
const NOW = Date.parse('2026-09-15T02:10:00.000Z');

/** قاعدة وهمية تعيد حجمًا محدَّدًا في `meta.size_after` كما يفعل D1. */
const fakeDb = (sizeBytes) => ({
  prepare: () => ({
    all: async () => ({ results: [{ 1: 1 }], meta: { size_after: sizeBytes } }),
  }),
});

/** سطل وهمي يرقّم الصفحات كما يفعل R2. */
function fakeBucket(objects) {
  return {
    list: async ({ limit = 1000, cursor } = {}) => {
      const start = cursor ? Number(cursor) : 0;
      const page = objects.slice(start, start + limit);
      const next = start + limit;
      return {
        objects: page,
        truncated: next < objects.length,
        cursor: next < objects.length ? String(next) : undefined,
      };
    },
  };
}

const backup = (dbName, stamp, size) => ({ key: `d1/${dbName}/${stamp}.sql`, size });

test('حجم القاعدة يُقرأ من meta.size_after ونسبته تُحسب على الحد', async () => {
  const usage = await d1Usage([{ name: 'athar-console', db: fakeDb(50 * MB) }]);
  assert.equal(usage[0].size_bytes, 50 * MB);
  assert.equal(usage[0].used_percent, 10, '50 من 500 ميجابايت = 10%');
});

test('قاعدة صغيرة لا تُنتج تحذيرًا — التحذير الدائم يُهمَل', async () => {
  const usage = await d1Usage([{ name: 'athar-console', db: fakeDb(1 * MB) }]);
  const warnings = limitWarnings(usage, { objects: 1, size_bytes: 10, by_prefix: [{ prefix: 'd1/athar-console', objects: 1, size_bytes: 10 }] }, ['d1/athar-console']);
  assert.deepEqual(warnings, []);
});

test('تجاوز النصف ينبّه، وتجاوز أربعة أخماس يصير حرجًا', async () => {
  const half = await d1Usage([{ name: 'x', db: fakeDb(260 * MB) }]);
  const nearFull = await d1Usage([{ name: 'x', db: fakeDb(420 * MB) }]);
  const r2 = { objects: 1, size_bytes: 1, by_prefix: [{ prefix: 'd1/x', objects: 1, size_bytes: 1 }] };

  assert.equal(limitWarnings(half, r2, ['d1/x'])[0].level, 'warn');
  assert.equal(limitWarnings(nearFull, r2, ['d1/x'])[0].level, 'critical');
});

test('قاعدة بلا نسخة احتياطية تحذير حرج — الفشل الليلي صامت', async () => {
  const usage = await d1Usage([
    { name: 'athar-console', db: fakeDb(1 * MB) },
    { name: 'school-db', db: fakeDb(1 * MB) },
  ]);
  const r2 = await r2Usage(fakeBucket([backup('athar-console', 's1', 100)]));
  const warnings = limitWarnings(usage, r2, ['d1/athar-console', 'd1/school-db']);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].resource, 'R2/d1/school-db');
  assert.equal(warnings[0].level, 'critical');
});

test('التجميع بالمجلد كاملًا لا بالجزء الأول', async () => {
  const r2 = await r2Usage(fakeBucket([
    backup('athar-console', 's1', 100),
    backup('athar-console', 's2', 150),
    backup('school-db', 's1', 400),
  ]));

  assert.equal(r2.objects, 3);
  assert.equal(r2.size_bytes, 650);
  const map = Object.fromEntries(r2.by_prefix.map((p) => [p.prefix, p]));
  assert.equal(map['d1/athar-console'].objects, 2,
    'الاكتفاء بالجزء الأول يجعل القواعد كلها بادئة d1 فيمرّ فحص النسخ الناقصة دائمًا');
  assert.equal(map['d1/school-db'].size_bytes, 400);
});

test('السطل متعدد الصفحات يُقرأ كاملًا', async () => {
  const many = Array.from({ length: 2300 }, (_, i) => backup('athar-console', `s${i}`, 10));
  const r2 = await r2Usage(fakeBucket(many));
  assert.equal(r2.objects, 2300, 'التوقف عند الصفحة الأولى يُخفي معظم السطل');
  assert.equal(r2.size_bytes, 23000);
});

test('غياب السطل تحذير حرج لا صمت', async () => {
  const report = await limitsReport([{ name: 'athar-console', db: fakeDb(1 * MB) }], undefined, NOW);
  assert.equal(report.r2, null);
  assert.equal(report.warnings[0].level, 'critical');
  assert.match(report.warnings[0].message, /لا نسخ احتياطي/);
});

test('التقرير الكامل يبني بادئات النسخ من أسماء القواعد', async () => {
  const report = await limitsReport(
    [{ name: 'athar-console', db: fakeDb(2 * MB) }],
    fakeBucket([backup('athar-console', 's1', 500)]),
    NOW,
  );
  assert.deepEqual(report.warnings, [], 'قاعدة صغيرة لها نسخة يجب ألا تُحذّر');
  assert.equal(report.d1[0].name, 'athar-console');
  assert.equal(report.r2.objects, 1);
});
