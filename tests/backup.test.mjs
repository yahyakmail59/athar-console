/**
 * النسخة الاحتياطية تُقاس باستعادتها لا بإنتاجها.
 *
 * ملف يُكتب ولا يُستعاد ليس نسخة احتياطية بل وهمُ واحدة، وهذا أسوأ من غيابها
 * لأنه يمنع السؤال. فكل فحص هنا يبني قاعدة، ينسخها، ثم **يُشغّل الناتج على
 * قاعدة فارغة** ويقارن الصفوف.
 *
 * التشغيل: node --test tests/backup.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { dumpDatabase, runBackup } = await import('../src/backup.ts');

/** غلاف D1 فوق node:sqlite — نفس ما تستعمله اختبارات المحرك. */
function fakeD1(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind: () => this.prepare(sql),
        all: async () => ({ results: stmt.all() }),
        first: async () => stmt.get() ?? null,
        run: async () => ({ success: true }),
      };
    },
  };
}

function fakeBucket() {
  const store = new Map();
  return {
    store,
    put: async (key, body, meta) => { store.set(key, { body, meta }); },
    list: async ({ prefix }) => ({
      objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
    }),
    delete: async (key) => { store.delete(key); },
  };
}

const seeded = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE restaurants (id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT, active INTEGER);
    CREATE UNIQUE INDEX idx_restaurants_name ON restaurants (name);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
  `);
  db.exec(`INSERT INTO restaurants VALUES ('ATH_1', 'مطعم أضنة', 'full', 1);`);
  // نصّ فيه علامة اقتباس مفردة — أكثر ما يكسر توليد SQL بيدٍ.
  db.exec(`INSERT INTO restaurants VALUES ('ATH_2', 'Joe''s Diner', 'menu', 0);`);
  db.exec(`INSERT INTO notes VALUES (1, NULL);`);
  return db;
};

test('the dump restores into an empty database with identical rows', async () => {
  const source = seeded();
  const sql = await dumpDatabase(fakeD1(source));

  const restored = new DatabaseSync(':memory:');
  restored.exec(sql);

  const before = source.prepare('SELECT * FROM restaurants ORDER BY id').all();
  const after = restored.prepare('SELECT * FROM restaurants ORDER BY id').all();
  assert.deepEqual(after, before, 'الصفوف المستعادة تخالف الأصل');

  // الاقتباس المفرد أشيع ما يفسد الملف، والفراغ يجب أن يبقى NULL لا ''.
  assert.equal(after.find((r) => r.id === 'ATH_2').name, "Joe's Diner");
  assert.equal(restored.prepare('SELECT body FROM notes WHERE id = 1').get().body, null);

  // والفهارس تُستعاد أيضًا، وإلا عاد المخطط ناقصًا قيدَ تفرّدٍ يحرس البيانات.
  const index = restored.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_restaurants_name'",
  ).get();
  assert.ok(index, 'الفهرس الفريد لم يُستعد');
});

test('a jsonless empty table survives the round trip', async () => {
  const source = new DatabaseSync(':memory:');
  source.exec('CREATE TABLE empty_one (id TEXT PRIMARY KEY);');
  const sql = await dumpDatabase(fakeD1(source));
  const restored = new DatabaseSync(':memory:');
  restored.exec(sql);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM empty_one').get().n, 0);
});

test('each database lands under its own prefix and old copies are pruned', async () => {
  const bucket = fakeBucket();
  const target = [{ name: 'restaurant-db', db: fakeD1(seeded()) }];

  const first = await runBackup(target, bucket);
  assert.equal(first[0].ok, true, first[0].error);
  assert.ok(first[0].key.startsWith('d1/restaurant-db/'), first[0].key);
  assert.ok(first[0].bytes > 0);

  // 31 نسخة ثم تشغيل: يجب أن تبقى 30.
  for (let i = 0; i < 40; i += 1) bucket.store.set(`d1/restaurant-db/2020-01-${String(i).padStart(2, '0')}.sql`, {});
  const again = await runBackup(target, bucket);
  assert.ok(again[0].pruned > 0, 'لم يُحذف شيء رغم تجاوز الحد');
  const remaining = [...bucket.store.keys()].filter((k) => k.startsWith('d1/restaurant-db/'));
  assert.equal(remaining.length, 30, `بقي ${remaining.length} نسخة لا 30`);
});

test('one failing database does not stop the others', async () => {
  const bucket = fakeBucket();
  const broken = { prepare: () => { throw new Error('D1 down'); } };
  const results = await runBackup([
    { name: 'broken-db', db: broken },
    { name: 'good-db', db: fakeD1(seeded()) },
  ], bucket);

  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /D1 down/);
  assert.equal(results[1].ok, true, 'القاعدة السليمة سقطت بسقوط الأخرى');
});
