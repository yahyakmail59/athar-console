/**
 * التجارب المعروضة للزوار.
 *
 * ما يُنشر هنا يراه كل زائر بلا حساب. فالسؤال في كل فحص: **ما الذي لا يجوز
 * أن يظهر؟** — تجربة مؤرشفة، أو مستأجر إنتاج لعميل حقيقي، أو رابط مكسور.
 *
 * التشغيل: node --test tests/showcase.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { eligibleDemos, syncShowcase } = await import('../src/showcase.ts');

function fakeD1(sqlite) {
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
  });
  return { prepare: (sql) => wrap(sql) };
}

function seeded(tenants) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, product_id TEXT, display_name TEXT,
      short_name TEXT, environment TEXT, status TEXT, public_url TEXT, created_at TEXT);
  `);
  db.prepare('INSERT INTO products VALUES (?, ?)').run('restaurant', 'المطاعم');
  db.prepare('INSERT INTO products VALUES (?, ?)').run('school', 'المدارس');
  for (const [i, t] of tenants.entries()) {
    db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      t.id ?? `t${i}`, t.product_id ?? 'restaurant', t.display_name ?? 'تجربة',
      t.short_name ?? '', t.environment ?? 'demo', t.status ?? 'active',
      t.public_url ?? 'https://demo.athar.date/', t.created_at ?? '2026-01-01',
    );
  }
  return db;
}

test('التجربة النشطة تُعرض باسمها ورابطها', async () => {
  const db = seeded([{ display_name: 'مطعم التجربة', public_url: 'https://adana.athar.date/' }]);
  const items = await eligibleDemos(fakeD1(db));

  assert.equal(items.length, 1);
  assert.equal(items[0].title_ar, 'مطعم التجربة');
  assert.equal(items[0].url, 'https://adana.athar.date/');
  assert.match(items[0].summary_ar, /المطاعم/, 'الملخّص يجب أن يذكر المنتج');
});

test('مستأجر الإنتاج لا يُعرض — عميل حقيقي لا تجربة', async () => {
  const db = seeded([{ environment: 'production', display_name: 'مطعم عميل' }]);
  assert.deepEqual(await eligibleDemos(fakeD1(db)), [],
    'نشر عميل يدفع على أنه تجربة عامة خرق للخصوصية');
});

test('التجربة المؤرشفة أو الموقوفة تختفي من الموقع', async () => {
  for (const status of ['archived', 'suspended', 'draft']) {
    const db = seeded([{ status }]);
    assert.deepEqual(await eligibleDemos(fakeD1(db)), [], `الحالة ${status} ما زالت معروضة`);
  }
});

test('رابط فارغ أو غير https لا يُعرض — بطاقة تُحبط من ينقرها', async () => {
  for (const url of ['', 'http://demo.athar.date/', 'javascript:alert(1)']) {
    const db = seeded([{ public_url: url }]);
    assert.deepEqual(await eligibleDemos(fakeD1(db)), [], `الرابط «${url}» ما زال يُعرض`);
  }
});

test('الدفع استبدال كامل: تُرسل القائمة الحالية بأكملها', async () => {
  const db = seeded([
    { id: 'a', display_name: 'مطعم', product_id: 'restaurant' },
    { id: 'b', display_name: 'مدرسة', product_id: 'school' },
    { id: 'c', display_name: 'مؤرشف', status: 'archived' },
  ]);
  let sentItems = null;
  const result = await syncShowcase({ DB: fakeD1(db) }, async (items) => {
    sentItems = items;
    return { stored: items.length };
  });

  assert.equal(result.sent, 2);
  assert.equal(result.stored, 2);
  assert.deepEqual(sentItems.map((i) => i.id).sort(), ['a', 'b'],
    'المؤرشف يجب ألا يُرسل — والإرسال استبدال، فغيابه يحذفه من الموقع');
});

test('غياب التجارب يُرسل قائمة فارغة لا يمتنع عن الإرسال', async () => {
  const db = seeded([]);
  let called = false;
  await syncShowcase({ DB: fakeD1(db) }, async (items) => {
    called = true;
    assert.deepEqual(items, []);
    return { stored: 0 };
  });
  assert.ok(called, 'الامتناع عن الإرسال يترك تجارب قديمة معلنة إلى الأبد');
});
