/**
 * رابط لوحة الإدارة يُبنى ولا يُكتب بيد — ولا تمرّ فيه كلمة مرور.
 *
 * لماذا هذا الملف موجود: نافذة بيانات الدخول كانت تعرض المعرّف والاسم
 * والكلمة، وتربط بالموقع العام وحده. فبُني رابط لوحة المطعم يدويًّا هكذا:
 *
 *     https://demo.athar.date/admin?restaurant_id=…&username=demo&password=…
 *
 * وهو خطأ مضاعف: **لا يعمل** — لوحة المطعم تقرأ معرّفه من جزء العنوان
 * `#r={slug}` ولا تقبل اسمًا ولا كلمة مرور من الرابط أبدًا، فتُفتح الصفحة
 * بخانات فارغة بلا رسالة — **ويُسرّب** كلمةَ المرور في معامل استعلام
 * يُرسَل إلى الخادم ويدخل سجلات الوسطاء ويبقى في سجل التصفّح ويُنسخ مع
 * الرابط إن شاركه أحد.
 *
 * التشغيل: node --test tests/admin-link.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/** تُستخرج الدالة من الملف المنشور نفسه وتُشغَّل — لا نسخة منها. */
function loadAdminEntryUrl() {
  const start = app.indexOf('function adminEntryUrl(');
  assert.ok(start > 0, 'الدالة مفقودة من الملف المنشور');
  const end = app.indexOf('\n}', start);
  assert.ok(end > start, 'لم تُعرف نهاية الدالة');
  // eslint-disable-next-line no-new-func
  return new Function(`${app.slice(start, end + 2)}; return adminEntryUrl;`)();
}

test('يبني رابط لوحة المطعم بجزء العنوان', () => {
  const adminEntryUrl = loadAdminEntryUrl();
  assert.equal(
    adminEntryUrl('https://demo.athar.date/', 'restaurant'),
    'https://demo.athar.date/admin#r=demo',
  );
  assert.equal(
    adminEntryUrl('https://adana-resurant.athar.date/', 'restaurant'),
    'https://adana-resurant.athar.date/admin#r=adana-resurant',
  );
});

test('ولا يُنتج رابطًا لمحرك لوحته هي رابطه العام', () => {
  const adminEntryUrl = loadAdminEntryUrl();
  // المدارس والصيدليات والعيادات: الرابط العام هو شاشة الدخول نفسها،
  // فرابط ثانٍ إلى `/admin` يقود إلى صفحة لا وجود لها.
  for (const product of ['school', 'pharmacy', 'clinic']) {
    assert.equal(adminEntryUrl('https://pharmacy.athar.date/?pharmacy=X', product), '');
  }
  assert.equal(adminEntryUrl('', 'restaurant'), '');
  assert.equal(adminEntryUrl('ليس رابطًا', 'restaurant'), '');
});

test('ولا تمرّ كلمة مرور ولا اسم مستخدم في أي عنوان', () => {
  const adminEntryUrl = loadAdminEntryUrl();
  const url = adminEntryUrl('https://demo.athar.date/', 'restaurant');
  assert.ok(!/password|username|pass=|user=/i.test(url),
    `الرابط يحمل بيانات دخول: ${url}`);

  // ولا في الشيفرة التي تبنيه: لو أُضيفت يومًا لعادت الثغرة نفسها.
  const fn = app.slice(app.indexOf('function adminEntryUrl('), app.indexOf('function showProvisionedCredentials'));
  assert.ok(!/password|username/i.test(fn), 'بناء الرابط يذكر بيانات دخول');
});

test('والزرّ موجود في النافذة ومخفيّ حتى يُبنى له رابط', () => {
  assert.ok(html.includes('id="credential-admin-link"'), 'الزرّ مفقود من النافذة');
  const anchor = html.match(/<a id="credential-admin-link"[^>]*>/)[0];
  assert.ok(/\shidden\b/.test(anchor), 'الزرّ يظهر افتراضيًّا — فيقود إلى # لمنتج بلا لوحة منفصلة');
  assert.ok(/rel="noopener"/.test(anchor), 'رابط بنافذة جديدة بلا noopener');
});
