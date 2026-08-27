/**
 * سحب العملاء المحتملين من موقع أثر.
 *
 * الخطأ هنا لا يُسقط الخدمة، بل يُضيّع عميلًا — وهو أسوأ لأنه صامت: لا أحد
 * يشتكي من رسالة لم تصل. فكل فحص يسأل: **ما الذي لا يجوز أن يضيع؟**
 *
 * التشغيل: node --test tests/leads.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const { syncLeads, unreadLeadCount } = await import('../src/leads.ts');

const NOW = Date.parse('2026-09-01T10:00:00.000Z');

function fakeD1(sqlite) {
  const wrap = (sql, params = []) => ({
    bind: (...args) => wrap(sql, args),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...params);
      return { meta: { changes: Number(info.changes) } };
    },
  });
  return { prepare: (sql) => wrap(sql) };
}

function seeded() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'customer',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE lead_messages (id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE,
      customer_id TEXT, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', business_type TEXT NOT NULL DEFAULT '',
      service_label TEXT NOT NULL DEFAULT '', message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL, imported_at TEXT NOT NULL);
  `);
  return db;
}

const lead = (over = {}) => ({
  id: 'msg-1', name: 'أحمد سالم', email: '', phone: '0599123456',
  business_type: 'مطعم', service_label: 'موقع وطلبات', message: 'أريد نظام طلبات',
  created_at: NOW - 3600e3, ...over,
});

/** قناة تسجّل ما طُلب منها، ليُفحص متى يقع الإقرار ومتى لا يقع. */
function channelOf(leads, { failAck = false } = {}) {
  const acked = [];
  return {
    acked,
    fetchLeads: async () => leads,
    acknowledge: async (ids) => {
      if (failAck) throw new Error('الشبكة سقطت');
      acked.push(...ids);
    },
  };
}

test('العميل الجديد يصير صفًّا بحالة «محتمل» ورسالته محفوظة', async () => {
  const db = seeded();
  const channel = channelOf([lead()]);
  const result = await syncLeads({ DB: fakeD1(db) }, channel, NOW);

  assert.equal(result.imported, 1);
  assert.equal(result.customersCreated, 1);
  const customer = db.prepare('SELECT * FROM customers').get();
  assert.equal(customer.status, 'lead', 'العميل الجديد يجب أن يبدأ «محتملًا» لا زبونًا');
  assert.equal(customer.phone, '0599123456');
  assert.equal(db.prepare('SELECT message FROM lead_messages').get().message, 'أريد نظام طلبات');
  assert.deepEqual(channel.acked, ['msg-1'], 'يجب الإقرار بما وصل');
});

test('السحب المكرّر لا يُنشئ عميلًا ثانيًا ولا رسالة ثانية', async () => {
  const db = seeded();
  const env = { DB: fakeD1(db) };
  await syncLeads(env, channelOf([lead()]), NOW);
  // الإقرار سقط في المرة الأولى، فالموقع يعيد الرسالة نفسها.
  const second = await syncLeads(env, channelOf([lead()]), NOW + 60e3);

  assert.equal(second.imported, 0, 'القيد الفريد يجب أن يبتلع المكرّر');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_messages').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1,
    'رسالة مكرّرة لا تصنع عميلًا ثانيًا');
});

test('الرسالة الثانية من الرقم نفسه تُربط بالعميل القائم لا تُكرّره', async () => {
  const db = seeded();
  const env = { DB: fakeD1(db) };
  await syncLeads(env, channelOf([lead()]), NOW);
  // الرقم نفسه بصياغة أخرى: مسافات وصفر دولي.
  const result = await syncLeads(env, channelOf([
    lead({ id: 'msg-2', phone: '+970 599 123 456', message: 'متابعة' }),
  ]), NOW + 86400e3);

  assert.equal(result.linkedToExisting, 1, 'الرقم نفسه بصياغة أخرى يجب أن يُطابَق');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
  const ids = db.prepare('SELECT DISTINCT customer_id FROM lead_messages').all();
  assert.equal(ids.length, 1, 'الرسالتان يجب أن تشيرا إلى العميل نفسه');
});

test('من لا بريد له ولا رقم مطابق لا يُدمج مع من لا بريد له أيضًا', async () => {
  const db = seeded();
  const env = { DB: fakeD1(db) };
  await syncLeads(env, channelOf([lead({ id: 'a', phone: '0591111111', email: '' })]), NOW);
  await syncLeads(env, channelOf([lead({ id: 'b', name: 'سارة', phone: '0592222222', email: '' })]), NOW);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2,
    'الفراغ لا يطابق الفراغ: وإلا صار كل من لا بريد له عميلًا واحدًا');
});

test('فشل الإقرار لا يمنع الحفظ — الرسالة تصل وتُسحب ثانيةً بلا ضرر', async () => {
  const db = seeded();
  const env = { DB: fakeD1(db) };
  await assert.rejects(() => syncLeads(env, channelOf([lead()], { failAck: true }), NOW));

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lead_messages').get().n, 1,
    'ما أُدرج قبل سقوط الإقرار يجب أن يبقى');
  const again = await syncLeads(env, channelOf([lead()]), NOW + 60e3);
  assert.equal(again.imported, 0, 'السحب التالي لا يجوز أن يُكرّر');
});

test('رسالة بلا اسم يُقَرّ بها ولا تُدرج — وإلا سُحبت إلى الأبد', async () => {
  const db = seeded();
  const channel = channelOf([lead({ id: 'msg-x', name: '   ' })]);
  const result = await syncLeads({ DB: fakeD1(db) }, channel, NOW);

  assert.equal(result.imported, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
  assert.deepEqual(channel.acked, ['msg-x'], 'بلا إقرار تعود في كل دورة إلى الأبد');
});

test('العدّاد يحسب غير المقروء فقط', async () => {
  const db = seeded();
  const env = { DB: fakeD1(db) };
  await syncLeads(env, channelOf([lead({ id: 'm1' }), lead({ id: 'm2', phone: '0597777777' })]), NOW);
  assert.equal(await unreadLeadCount(fakeD1(db)), 2);

  db.prepare('UPDATE lead_messages SET is_read = 1 WHERE source_id = ?').run('m1');
  assert.equal(await unreadLeadCount(fakeD1(db)), 1);
});
