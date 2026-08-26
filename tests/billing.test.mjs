/**
 * دورة الاشتراك: مهلة ثم إيقاف.
 *
 * هذه الشيفرة توقف خدمة عميل يدفع. الخطأ فيها ليس عطلًا تقنيًا بل مكالمة
 * غاضبة، فكل فحص هنا يسأل: **من تُوقف ومن لا تُوقف؟** — والثانية أهم.
 *
 * التشغيل: node --test tests/billing.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { runBillingCycle, pendingNotices, GRACE_DAYS } = await import('../src/billing.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T02:10:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function fakeD1(sqlite) {
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => sqlite.prepare(sql).run(...params),
    __sql: sql,
    __params: params,
  });
  return {
    prepare: (sql) => wrap(sql),
    // `batch` معاملة واحدة كما في D1: فشل عبارة يُلغي الدفعة كلها.
    batch: async (statements) => {
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => sqlite.prepare(s.__sql).run(...s.__params));
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/** قاعدة فيها عميل واحد باشتراك يُضبط لكل حالة. */
function seeded({ status = 'active', autoSuspend = 1, periodEnd, graceEndsAt = null, tenantStatus = 'active' }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT, contact_name TEXT, phone TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, customer_id TEXT, product_id TEXT,
      external_tenant_id TEXT, display_name TEXT, status TEXT, updated_at TEXT);
    CREATE TABLE subscriptions (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT,
      current_period_end TEXT, grace_ends_at TEXT, auto_suspend INTEGER, updated_at TEXT);
    CREATE TABLE billing_notices (id TEXT PRIMARY KEY, tenant_id TEXT, subscription_id TEXT,
      kind TEXT, period_end TEXT, grace_ends_at TEXT, message TEXT,
      delivered_at TEXT, created_at TEXT);
    CREATE UNIQUE INDEX idx_once ON billing_notices (subscription_id, kind, period_end);
  `);
  db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?)')
    .run('cus1', 'مطعم أضنة', 'يحيى', '970599123456');
  db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ten1', 'cus1', 'restaurant', 'ATH_X', 'مطعم أضنة', tenantStatus, iso(NOW));
  db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('sub1', 'ten1', status, periodEnd, graceEndsAt, autoSuspend, iso(NOW));
  return db;
}

/** بيئة بلا محوّل: الإيقاف يقع في اللوحة وحدها. */
const envFor = (db) => ({ DB: fakeD1(db), ATHAR_ADAPTER_SECRET: 'x' });

const sub = (db) => db.prepare('SELECT * FROM subscriptions WHERE id = ?').get('sub1');
const ten = (db) => db.prepare('SELECT * FROM tenants WHERE id = ?').get('ten1');
const notices = (db) => db.prepare('SELECT * FROM billing_notices ORDER BY created_at').all();

/* ==================== فتح المهلة ==================== */

test('an expired subscription enters a three-day grace, not suspension', async () => {
  const db = seeded({ periodEnd: iso(NOW - DAY) });
  const out = await runBillingCycle(envFor(db), NOW);

  assert.equal(out.graceStarted, 1);
  assert.equal(out.suspended, 0, 'أُوقف العميل فورًا بلا مهلة');

  const row = sub(db);
  assert.equal(row.status, 'past_due');
  // الخدمة تبقى عاملة خلال المهلة — هذا هو الغرض منها.
  assert.equal(ten(db).status, 'active', 'أُوقف المستأجر أثناء المهلة');

  const expected = NOW + GRACE_DAYS * DAY;
  assert.equal(Date.parse(row.grace_ends_at), expected, 'المهلة ليست ثلاثة أيام');
});

test('the grace notice names the deadline and is stored verbatim', async () => {
  const db = seeded({ periodEnd: iso(NOW - DAY) });
  await runBillingCycle(envFor(db), NOW);
  const [notice] = notices(db);
  assert.equal(notice.kind, 'grace_started');
  assert.match(notice.message, /يحيى/, 'الإشعار لا يخاطب العميل باسمه');
  assert.match(notice.message, new RegExp(String(GRACE_DAYS)), 'الإشعار لا يذكر مدة المهلة');
  assert.equal(notice.delivered_at, null, 'الإشعار وُسم مُبلَّغًا بلا إرسال');
});

test('running twice in one day does not notify twice', async () => {
  const db = seeded({ periodEnd: iso(NOW - DAY) });
  await runBillingCycle(envFor(db), NOW);
  await runBillingCycle(envFor(db), NOW + 60_000);
  assert.equal(notices(db).length, 1, 'العميل نُبّه مرتين للحدث نفسه');
});

/* ==================== الإيقاف ==================== */

test('service stops only after the grace has passed', async () => {
  // قبل انقضائها بساعة: لا شيء يحدث.
  const early = seeded({
    status: 'past_due', periodEnd: iso(NOW - 4 * DAY), graceEndsAt: iso(NOW + 60 * 60 * 1000),
  });
  const before = await runBillingCycle(envFor(early), NOW);
  assert.equal(before.suspended, 0, 'أُوقف العميل قبل انتهاء مهلته');
  assert.equal(ten(early).status, 'active');

  // وبعد انقضائها: يُوقف.
  const late = seeded({
    status: 'past_due', periodEnd: iso(NOW - 5 * DAY), graceEndsAt: iso(NOW - 60 * 1000),
  });
  const after = await runBillingCycle(envFor(late), NOW);
  assert.equal(after.suspended, 1, 'لم يُوقف رغم انقضاء المهلة');
  assert.equal(sub(late).status, 'suspended');
  assert.equal(ten(late).status, 'suspended');
  assert.equal(notices(late).at(-1).kind, 'suspended');
});

/* ==================== من لا يُوقف ==================== */

test('a subscription without auto_suspend is never touched', async () => {
  // العلم موجود لأن الإيقاف قرار تجاري: عميل يمرّ بظرف، أو حوالة تأخرت.
  const db = seeded({ autoSuspend: 0, periodEnd: iso(NOW - 10 * DAY) });
  const out = await runBillingCycle(envFor(db), NOW);
  assert.equal(out.graceStarted, 0);
  assert.equal(out.suspended, 0);
  assert.equal(sub(db).status, 'active', 'أُوقف اشتراك لم يُطلب إيقافه آليًا');
  assert.equal(notices(db).length, 0);
});

test('a subscription still inside its period is untouched', async () => {
  const db = seeded({ periodEnd: iso(NOW + 10 * DAY) });
  const out = await runBillingCycle(envFor(db), NOW);
  assert.equal(out.graceStarted, 0, 'نُبّه عميل لم تنتهِ فترته');
  assert.equal(sub(db).status, 'active');
});

test('an already archived tenant is left alone', async () => {
  const db = seeded({ periodEnd: iso(NOW - DAY), tenantStatus: 'archived' });
  const out = await runBillingCycle(envFor(db), NOW);
  assert.equal(out.graceStarted, 0, 'نُبّه عميل مؤرشف');
  assert.equal(notices(db).length, 0);
});

test('a subscription with no period end is untouched', async () => {
  // اشتراك مفتوح بلا نهاية محددة — لا يُقاس عليه انتهاء.
  const db = seeded({ periodEnd: null });
  const out = await runBillingCycle(envFor(db), NOW);
  assert.equal(out.graceStarted, 0, 'اشتراك بلا نهاية عومل كمنتهٍ');
});

/* ==================== الإشعار يصل ==================== */

test('a pending notice carries a ready WhatsApp message', async () => {
  const db = seeded({ periodEnd: iso(NOW - DAY) });
  const env = envFor(db);
  await runBillingCycle(env, NOW);

  const pending = await pendingNotices(env);
  assert.equal(pending.length, 1);
  assert.ok(pending[0].whatsapp_url.startsWith('https://wa.me/970599123456'),
    `رابط واتساب غير مبنيّ: ${pending[0].whatsapp_url}`);
  // نصّ الرسالة هو نفسه المحفوظ، لا صياغة تُبنى وقت العرض.
  assert.ok(decodeURIComponent(pending[0].whatsapp_url).includes(pending[0].message));
});

test('a customer with no phone still yields a notice, without a link', async () => {
  const db = seeded({ periodEnd: iso(NOW - DAY) });
  db.prepare("UPDATE customers SET phone = '' WHERE id = 'cus1'").run();
  const env = envFor(db);
  await runBillingCycle(env, NOW);
  const pending = await pendingNotices(env);
  // غياب الرقم لا يجوز أن يُسقط الإشعار: صاحب اللوحة يحتاج أن يعرف.
  assert.equal(pending.length, 1, 'ضاع الإشعار لغياب رقم الهاتف');
  assert.equal(pending[0].whatsapp_url, '');
});

/* ==================== الفشل لا يوقف البقية ==================== */

test('one failing tenant does not stop the rest', async () => {
  const db = seeded({ periodEnd: iso(NOW - DAY) });
  db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?)')
    .run('cus2', 'مقهى', 'سامي', '970599000000');
  db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('ten2', 'cus2', 'restaurant', 'ATH_Y', 'مقهى', 'active', iso(NOW));
  db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('sub2', 'ten2', 'active', iso(NOW - DAY), null, 1, iso(NOW));

  const env = envFor(db);
  const realBatch = env.DB.batch;
  let calls = 0;
  env.DB.batch = async (statements) => {
    calls += 1;
    if (calls === 1) throw new Error('D1 down');
    return realBatch(statements);
  };

  const out = await runBillingCycle(env, NOW);
  assert.equal(out.graceStarted, 1, 'سقوط عميل أوقف معالجة الآخر');
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].error, /D1 down/);
});
