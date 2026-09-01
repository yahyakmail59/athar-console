/**
 * الرابط الذي تسلّمه اللوحة يفتح لوحةً تعمل، والبيانات الثلاثة تُعرض كلّها.
 *
 * لماذا هذا الملف موجود: صفحة لوحة المطعم تطلب أصولها بمسارات نسبية
 * (`./app.js`). من `/admin/` يحلّها المتصفح إلى `/admin/app.js` فتُخدَم،
 * ومن `/admin` — بلا شرطة — إلى `/app.js` ولا وجود لها على نطاق المطعم.
 *
 * والعطل الناتج **صامت تمامًا**: الصفحة تُرسَم كاملة، والحقول تُملأ، ثم
 * لا يفعل زرّ الدخول شيئًا — لأن الشيفرة التي تُنصت إليه لم تُحمَّل. لا
 * رسالة خطأ، ولا 404 يراه المستخدم. فيظنّ أن كلمة مروره خاطئة.
 *
 * والمحرك يحوّل `/admin` إلى `/admin/` الآن، لكن الرابط يجب أن يصل صحيحًا
 * من أوّله: تحويلٌ زائد على كل فتحة، ورابطٌ يُنسخ إلى واتساب فيُقصّ عند
 * الشرطة، وسجلٌّ يزدحم بـ301.
 *
 * التشغيل: node --test tests/admin-entry.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/** جسم دالة بالاسم، من أول `{` إلى سطر `}` في عمودها. */
function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `الدالة ${name} غير موجودة`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `لم تُقرأ حدود ${name}`);
  return source.slice(start, end);
}

test('رابط لوحة المطعم ينتهي بشرطة قبل الوسم', () => {
  const body = functionBody('adminEntryUrl');
  const template = /\/admin(\/?)#r=/.exec(body);

  assert.ok(template, 'لم يُعثر على بناء الرابط في `adminEntryUrl`');
  assert.equal(template[1], '/',
    'الرابط `/admin#r=` يفتح صفحةً بلا شيفرتها: زرّ الدخول لا يستجيب ولا رسالة تظهر');
});

test('واسم المستخدم يُعرض ولو كان الافتراضيّ', () => {
  const body = functionBody('showProvisionedCredentials');

  assert.ok(!/userRow\.hidden\s*=\s*[^;]*['"]owner['"]/.test(body),
    'الاسم يُخفى حين يكون `owner` — والمشغّل يملأ حقلًا لا يراه بالتخمين');
  assert.ok(/userRow\.hidden\s*=\s*false/.test(body),
    'صفّ اسم المستخدم يجب أن يظهر دائمًا');
});

test('والثلاثة كلّها تُكتب في الشاشة', () => {
  const body = functionBody('showProvisionedCredentials');

  for (const [what, id] of [
    ['رمز الدخول', 'credential-pharmacy'],
    ['اسم المستخدم', 'credential-user'],
    ['كلمة المرور', 'credential-pin'],
  ]) {
    assert.ok(new RegExp(`byId\\('${id}'\\)\\.textContent`).test(body),
      `${what} لا يُكتب في الشاشة — والمشغّل لا يملك مصدرًا آخر له`);
  }
});
