/**
 * عقد المخطّط: كل عمود يستعمله الكود موجود في الهجرات فعلًا.
 *
 * لماذا هذا الملف موجود: `src/reports.ts` و`src/showcase.ts` كانا يسألان عن
 * `products.name`، والعمود اسمه `name_ar`. النتيجة أن شاشة التقارير كلها
 * تردّ 500، وأن دفع التجارب إلى `athar.date` يفشل — بصمت، شهورًا.
 *
 * ولم يكشفه فحص واحد، لأن اختبارات التقارير وعرض التجارب **تبني جدول
 * `products` بيدها** بعمود `name`: أي أنها تشهد للاستعلام المعطوب لا
 * للمخطّط. فحصٌ يبني بيئته من ذاكرة كاتبه يثبت أن الكود متّسق مع نفسه، لا
 * أنه صحيح.
 *
 * هذا الفحص يقرأ الهجرات — مصدر الحقيقة الوحيد — ويقابل بها كل إشارة إلى
 * عمود في الشيفرة. رخيص، ويمسك صنفًا كاملًا من الأعطال لا حالةً واحدة.
 *
 * التشغيل: node --test tests/schema.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const migrationsDir = new URL('../migrations/', import.meta.url);
const srcDir = new URL('../src/', import.meta.url);

/** أعمدة كل جدول كما تُنشئها الهجرات، مع ما يُضاف بـ`ALTER TABLE`. */
function schemaFromMigrations() {
  const tables = new Map();
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(new URL(file, migrationsDir), 'utf8')
      .replace(/--[^\n]*/g, '');

    for (const match of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
      const [, table, body] = match;
      const columns = tables.get(table) ?? new Set();
      for (const line of body.split('\n')) {
        const name = line.trim().match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/i);
        if (name) columns.add(name[1]);
      }
      tables.set(table, columns);
    }

    for (const match of sql.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi)) {
      const columns = tables.get(match[1]) ?? new Set();
      columns.add(match[2]);
      tables.set(match[1], columns);
    }
  }
  return tables;
}

/** اللقب المستعمل في الاستعلامات لكل جدول: `FROM products p` و`JOIN … pl`. */
const ALIASES = {
  t: 'tenants', p: 'products', pl: 'plans', s: 'subscriptions',
  c: 'customers', n: 'billing_notices',
};

test('كل عمود يسأل عنه الكود موجود في الهجرات', () => {
  const tables = schemaFromMigrations();
  assert.ok(tables.has('products'), 'لم تُقرأ الهجرات — تغيّر شكلها؟');
  assert.ok(tables.get('products').has('name_ar'), 'قراءة الهجرات ناقصة');

  const problems = [];
  for (const file of readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, srcDir), 'utf8');
    // داخل نصوص SQL وحدها: `map((t) => t.name)` في جافاسكربت ليس عمودًا،
    // والبحث في الملف كلّه يجعل الحارس ينذر كذبًا فيُهمَل — ونذيرٌ كاذب
    // أسوأ من لا نذير: يُدرَّب القارئ على تجاهله.
    for (const sql of source.matchAll(/`([^`]*FROM[^`]*)`/gis)) {
      for (const match of sql[1].matchAll(/([a-z]{1,2}).([a-z_]{2,})/g)) {
        const [whole, alias, column] = match;
        const table = ALIASES[alias];
        if (!table || !tables.has(table)) continue;
        if (!tables.get(table).has(column)) {
          problems.push(`${file}: ${whole} — لا عمود ${column} في ${table}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(problems)], [],
    'أعمدة يسأل عنها الكود ولا وجود لها:\n' + [...new Set(problems)].join('\n'));
});

test('اختبارات المخطّط اليدوي تطابق الهجرات', () => {
  // اختبارٌ يبني `products(name)` بيده يشهد لاستعلام معطوب. فإن بنى جدولًا
  // اسمه اسم جدول حقيقي، فليبنِه بأعمدته الحقيقية.
  const tables = schemaFromMigrations();
  const testsDir = new URL('./', import.meta.url);
  const problems = [];

  for (const file of readdirSync(testsDir).filter((name) => name.endsWith('.mjs'))) {
    if (file === 'schema.contract.test.mjs') continue;
    const source = readFileSync(new URL(file, testsDir), 'utf8');
    for (const match of source.matchAll(/CREATE TABLE\s+(\w+)\s*\(([^;]*?)\)\s*;/g)) {
      const [, table, body] = match;
      if (!tables.has(table)) continue;
      for (const part of body.split(',')) {
        const name = part.trim().match(/^(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)/i);
        if (name && !tables.get(table).has(name[1])) {
          problems.push(`${file}: ${table}.${name[1]} لا وجود له في الهجرات`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(problems)], [],
    'جداول وهمية تخالف المخطّط الحقيقي:\n' + [...new Set(problems)].join('\n'));
});
