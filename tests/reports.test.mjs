/**
 * تقارير الإيراد والتجديدات.
 *
 * أرقام المال تُقرأ ويُبنى عليها قرار، ورقم خاطئ هنا لا يُسقط شيئًا بل
 * يُضلّل بصمت. فالفحوص تسأل: **ما الذي يجعل الرقم كذبًا يبدو صحيحًا؟**
 *
 * التشغيل: node --test tests/reports.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { revenueReport } = await import('../src/reports.ts');

const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

function fakeD1(sqlite) {
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => ({ meta: { changes: 0 } }),
  });
  return { prepare: (sql) => wrap(sql) };
}

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, name_ar TEXT);
    CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT, phone TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, customer_id TEXT, product_id TEXT,
      display_name TEXT, status TEXT);
    CREATE TABLE subscriptions (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT,
      price_minor INTEGER, currency TEXT, billing_cycle TEXT, current_period_end TEXT,
      auto_suspend INTEGER DEFAULT 0);
    CREATE TABLE subscription_payments (id TEXT PRIMARY KEY, subscription_id TEXT,
      customer_id TEXT, amount_minor INTEGER, currency TEXT, paid_at TEXT);
  `);
  db.prepare('INSERT INTO products VALUES (?, ?)').run('restaurant', 'المطاعم');
  db.prepare('INSERT INTO products VALUES (?, ?)').run('school', 'المدارس');
  db.prepare('INSERT INTO customers VALUES (?, ?, ?)').run('c1', 'عميل أول', '0599111222');
  return db;
}

const addTenant = (db, id, over = {}) => {
  db.prepare('INSERT INTO tenants VALUES (?, ?, ?, ?, ?)').run(
    id, 'c1', over.product_id ?? 'restaurant', over.display_name ?? `مستأجر ${id}`,
    over.tenantStatus ?? 'active');
  db.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    `s-${id}`, id, over.status ?? 'active', over.price_minor ?? 5000,
    over.currency ?? 'USD', over.cycle ?? 'monthly',
    over.period_end ?? iso(NOW + 10 * DAY), over.auto_suspend ?? 0);
};

test('الإيراد المتكرر: السنوي يُقسَم على اثني عشر لا يُحسب كاملًا', async () => {
  const db = seeded();
  addTenant(db, 't1', { price_minor: 6000, cycle: 'monthly' });
  addTenant(db, 't2', { price_minor: 120000, cycle: 'yearly' });

  const report = await revenueReport(fakeD1(db), NOW);
  const usd = report.mrr.find((m) => m.currency === 'USD');
  assert.equal(usd.amount_minor, 6000 + 10000,
    'السنوي المحسوب كاملًا يجعل الإيراد يقفز ثم ينهار فلا يُقرأ منه اتجاه');
});

test('العملات لا تُجمع في رقم واحد', async () => {
  const db = seeded();
  addTenant(db, 't1', { price_minor: 5000, currency: 'USD' });
  addTenant(db, 't2', { price_minor: 18000, currency: 'ILS' });

  const report = await revenueReport(fakeD1(db), NOW);
  assert.equal(report.mrr.length, 2, 'العملتان يجب أن تبقيا منفصلتين');
  const map = Object.fromEntries(report.mrr.map((m) => [m.currency, m.amount_minor]));
  assert.equal(map.USD, 5000);
  assert.equal(map.ILS, 18000);
});

test('المستأجر المؤرشف أو الموقوف لا يُحسب إيرادًا متكررًا', async () => {
  const db = seeded();
  addTenant(db, 't1', { price_minor: 5000 });
  addTenant(db, 't2', { price_minor: 9900, tenantStatus: 'archived' });
  addTenant(db, 't3', { price_minor: 7700, status: 'suspended' });

  const report = await revenueReport(fakeD1(db), NOW);
  assert.equal(report.mrr[0].amount_minor, 5000,
    'حساب الموقوف إيرادًا يجعل الرقم يعد مالًا لن يصل');
});

test('التجديدات القادمة تقع داخل النافذة فقط، مرتّبة بالأقرب', async () => {
  const db = seeded();
  addTenant(db, 'soon', { period_end: iso(NOW + 3 * DAY) });
  addTenant(db, 'later', { period_end: iso(NOW + 20 * DAY) });
  addTenant(db, 'far', { period_end: iso(NOW + 90 * DAY) });
  addTenant(db, 'past', { period_end: iso(NOW - 5 * DAY) });

  const report = await revenueReport(fakeD1(db), NOW, 30);
  assert.deepEqual(report.upcoming_renewals.map((r) => r.tenant_id), ['soon', 'later']);
  assert.equal(report.upcoming_renewals[0].days_left, 3);
});

test('المتأخرون: من فات موعده فقط، بعدد أيام التأخير موجبًا', async () => {
  const db = seeded();
  addTenant(db, 'late', { status: 'grace', period_end: iso(NOW - 2 * DAY) });
  // عميل منتظم: إدراجه في قائمة المتأخرين يُفقد القائمة معناها كلها،
  // فتصير قائمة كل العملاء ويُطالَب من دفع.
  addTenant(db, 'fine', { status: 'active', period_end: iso(NOW + 12 * DAY) });

  const report = await revenueReport(fakeD1(db), NOW);
  assert.deepEqual(report.overdue.map((r) => r.tenant_id), ['late'],
    'المتأخرون يجب أن يقتصروا على past_due وgrace وsuspended');
  assert.equal(report.overdue[0].days_late, 2, 'التأخير يجب أن يُقرأ موجبًا لا سالبًا');
  assert.equal(report.overdue[0].phone, '0599111222', 'الرقم لازم: التقرير يُنتهي بمكالمة');
});

test('المحصَّل يُجمَّع بالشهر ولا يشمل ما قبل السنة', async () => {
  const db = seeded();
  addTenant(db, 't1');
  const pay = (id, amount, at, currency = 'USD') =>
    db.prepare('INSERT INTO subscription_payments VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 's-t1', 'c1', amount, currency, at);
  pay('p1', 5000, '2026-08-05T00:00:00.000Z');
  pay('p2', 5000, '2026-08-25T00:00:00.000Z');
  pay('p3', 5000, '2026-09-02T00:00:00.000Z');
  pay('p-old', 99000, '2024-01-01T00:00:00.000Z');
  // عملة ثانية في الشهر نفسه: بلا هذا يمرّ دمج العملات دون أن يُكشف.
  pay('p4', 18000, '2026-08-14T00:00:00.000Z', 'ILS');

  const report = await revenueReport(fakeD1(db), NOW);
  const august = report.collected_by_month.find((m) => m.month === '2026-08');
  const augustByCurrency = Object.fromEntries(august.totals.map((t) => [t.currency, t.amount_minor]));
  assert.equal(augustByCurrency.USD, 10000, 'دفعتا أغسطس بالدولار يجب أن تُجمعا');
  assert.equal(augustByCurrency.ILS, 18000, 'الشيكل يجب أن يبقى منفصلًا داخل الشهر نفسه');
  assert.equal(august.totals.length, 2, 'دمج العملتين يعطي رقمًا يبدو صحيحًا وليس كذلك');
  assert.ok(!report.collected_by_month.some((m) => m.month === '2024-01'),
    'ما قبل السنة يجب ألا يدخل تقرير الاثني عشر شهرًا');
  assert.equal(report.collected_total.find((t) => t.currency === 'USD').amount_minor, 15000);
});

test('التوزيع على المنتجات يفصل المطاعم عن المدارس', async () => {
  const db = seeded();
  addTenant(db, 't1', { product_id: 'restaurant', price_minor: 5000 });
  addTenant(db, 't2', { product_id: 'restaurant', price_minor: 3000 });
  addTenant(db, 't3', { product_id: 'school', price_minor: 12000 });

  const report = await revenueReport(fakeD1(db), NOW);
  const map = Object.fromEntries(report.by_product.map((r) => [r.product_id, r]));
  assert.equal(map.restaurant.active, 2);
  assert.equal(map.restaurant.mrr_minor, 8000);
  assert.equal(map.school.mrr_minor, 12000);
});
