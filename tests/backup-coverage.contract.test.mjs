/**
 * كل قاعدة D1 يربطها أيّ محرك تُنسخ ليلًا.
 *
 * ✦ لماذا: ثلاث قواعد (سجلّات المرضى، وخط المبيعات، ومحتوى athar.date)
 * بقيت خارج النسخ أشهرًا، لأن إضافة محرك جديد لا تذكّر أحدًا بـ`backup.ts`.
 * هذا الفحص يقرأ إعداد كل محرك مجاور ويطالب بقاعدته هنا.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const { backupTargets } = await import('../src/backup.ts');

const ENGINES = [
  '../pharma-gaza/wrangler.jsonc',
  '../rowad-gaza-school/worker/wrangler.jsonc',
  '../athar-restaurant/worker/wrangler.jsonc',
  '../athar-clinic/worker/wrangler.jsonc',
  '../athar-crm/worker/wrangler.jsonc',
  '../athar-media/worker/wrangler.jsonc',
];

const databaseNames = (path) =>
  [...readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').matchAll(/"database_name"\s*:\s*"([^"]+)"/g)]
    .map((match) => match[1]);

// بيئةٌ فيها كلّ ربطٍ مسمّى في إعداد اللوحة، كما يراه الـWorker المنشور.
const consoleEnv = () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const env = {};
  for (const match of text.matchAll(/"binding"\s*:\s*"([^"]+)"\s*,\s*"database_name"\s*:\s*"([^"]+)"/g)) {
    env[match[1]] = { name: match[2] };
  }
  return env;
};

test('كل قاعدة مربوطة في اللوحة تُنسخ', () => {
  const env = consoleEnv();
  const bound = Object.values(env).map((db) => db.name).sort();
  const backedUp = backupTargets(env).map((target) => target.name).sort();
  assert.deepEqual(backedUp, bound);
});

test('وكل قاعدة يستعملها محرك مجاور مربوطةٌ في اللوحة للنسخ', () => {
  const present = ENGINES.filter((path) => existsSync(new URL(`../${path}`, import.meta.url)));
  if (!present.length) return; // المستودعات المجاورة غير منسوخة هنا
  const env = consoleEnv();
  const backedUp = new Set(backupTargets(env).map((target) => target.name));
  const missing = present.flatMap(databaseNames).filter((name) => !backedUp.has(name));
  assert.deepEqual([...new Set(missing)], [], 'قواعد لا تُنسخ ليلًا');
});
