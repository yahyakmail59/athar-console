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
import { readFileSync as readSql, readdirSync } from 'node:fs';

/**
 * حارس على الفجوة التي كسرت هذا الملف: الاختبار يبني جدوله بيده،
 * فكل عمود يُضاف في ترحيل يبقى غائبًا عنه حتى ينكسر — وقد انكسر.
 * يُقرأ هنا ما تُضيفه الترحيلات ويُقارَن بما يبنيه الاختبار.
 */
function migrationColumns() {
  const dir = new URL('../migrations/', import.meta.url);
  const names = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readSql(new URL(file, dir), 'utf8');
    for (const m of sql.matchAll(/ALTER TABLE tenants\s+ADD COLUMN\s+([a-z_]+)/gi)) {
      names.add(m[1]);
    }
  }
  return names;
}

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

/**
 * نصّ جدول المستأجرين، في مكان واحد.
 *
 * كان مكتوبًا داخل `seeded` وحدها، فحين أضافت الترحيلات خمسة أعمدة بقي
 * الجدول ناقصًا وسقطت ستّة فحوص دفعةً بـ`no such column`. وإخراجه ثابتًا
 * يجعل الحارس أدناه يقرأ **ما يُبنى فعلًا** لا نسخةً منه.
 */
const TENANTS_TABLE = `CREATE TABLE tenants (id TEXT PRIMARY KEY, product_id TEXT, display_name TEXT,
  short_name TEXT, environment TEXT, status TEXT, public_url TEXT, created_at TEXT,
  is_showcase INTEGER NOT NULL DEFAULT 0, demo_username TEXT NOT NULL DEFAULT '',
  demo_password TEXT NOT NULL DEFAULT '', demo_hint TEXT NOT NULL DEFAULT '',
  demo_image TEXT NOT NULL DEFAULT '');`;

function seeded(tenants) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name_ar TEXT NOT NULL);
    ${TENANTS_TABLE}
  `);
  db.prepare('INSERT INTO products VALUES (?, ?)').run('restaurant', 'المطاعم');
  db.prepare('INSERT INTO products VALUES (?, ?)').run('school', 'المدارس');
  for (const [i, t] of tenants.entries()) {
    // بالأعمدة صراحةً لا بالترتيب: عمودٌ يُضاف في ترحيل يكسر الإدراج
    // بالترتيب بلا أن يمسّ الاختبار سطرًا واحدًا.
    db.prepare(`INSERT INTO tenants
      (id, product_id, display_name, short_name, environment, status, public_url,
       created_at, is_showcase, demo_username, demo_password, demo_hint, demo_image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.id ?? `t${i}`, t.product_id ?? 'restaurant', t.display_name ?? 'تجربة',
      t.short_name ?? '', t.environment ?? 'demo', t.status ?? 'active',
      t.public_url ?? 'https://demo.athar.date/', t.created_at ?? '2026-01-01',
      t.is_showcase ?? 1,
      t.demo_username ?? '', t.demo_password ?? '', t.demo_hint ?? '', t.demo_image ?? '',
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

test('كل عمود تُضيفه الترحيلات موجود في جدول الاختبار', () => {
  // هذا الملف انكسر مرّة بهذا بالضبط: أُضيفت خمسة أعمدة في ترحيل،
  // والاختبار يبني جدوله بيده فبقيت غائبة — وستّة فحوص سقطت دفعةً.
  // الحارس يجعل النقص يظهر هنا لا في فحصٍ لا علاقة له بالسبب.
  const probe = new DatabaseSync(':memory:');
  probe.exec(TENANTS_TABLE);
  const built = new Set(probe.prepare('PRAGMA table_info(tenants)').all().map((r) => r.name));
  const missing = [...migrationColumns()].filter((c) => !built.has(c));
  assert.deepEqual(missing, [],
    `أعمدة في الترحيلات وغائبة عن جدول الاختبار: ${missing.join(", ")}`);
});
