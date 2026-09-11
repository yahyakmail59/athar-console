/**
 * عقد أرقام الجوّال: الحالات مكتوبة مرّةً واحدة، والنسختان تُقابَلان بها.
 *
 * لماذا هذا الملف موجود: اللوحة كانت تبني رابط واتساب بـ
 * `phone.replace(/\D/g,'')` ولا شيء غيره، وثلاثةٌ من أربعة أشكالٍ في
 * بيانات الإنتاج تُنتج رابطًا معطوبًا — وأكثرها شيوعًا (`0597862389`)
 * أعطلها. ولا يشتكي أحد: الزرّ يُضغط فيفتح واتساب على «رقم غير صالح»،
 * فيُظنّ العطل في واتساب لا في اللوحة.
 *
 * والنسختان تُفحصان معًا — نسخة الـWorker ونسخة المتصفّح. ولو فُحصت
 * واحدةٌ لبقي نصف الروابط معطوبًا وكل الفحوص خضراء.
 *
 * والحالات في `fixtures/palestinian-phones.json` لا هنا، لأن أداة
 * المبيعات في مستودعٍ آخر تقرأ الملف نفسه.
 *
 * التشغيل: node --import ./tests/resolve-ts.mjs --test tests/phones.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = await import('../src/lib.ts');
const browser = await import('../public/phone.js');

const IMPLEMENTATIONS = [['المحرّك', worker], ['المتصفّح', browser]];

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/palestinian-phones.json', import.meta.url), 'utf8'),
);

for (const testCase of fixture.cases) {
  test(`${testCase.why} — ${JSON.stringify(testCase.input)}`, () => {
    for (const [where, impl] of IMPLEMENTATIONS) {
      const read = impl.readPhone(testCase.input);
      assert.equal(read.number, testCase.number, `الرقم — ${where}`);
      assert.equal(read.mobile, testCase.mobile, `أهو جوّال — ${where}`);
      assert.equal(read.kind, testCase.kind, `النوع — ${where}`);
      assert.equal(read.count, testCase.count, `العدد — ${where}`);
      /* `all` يُفحص حيث ذُكر: حقلٌ فيه ثلاثة أرقام يجب أن يعرضها كلّها،
         فمن لا واتساب على رقمه الأول قد يكون على الثاني. */
      if (testCase.all) {
        assert.deepEqual(read.all, testCase.all, `كل الأرقام — ${where}`);
      }
    }
  });
}

test('الرابط يُبنى من الرقم المُصحَّح لا من الخام', () => {
  for (const [where, impl] of IMPLEMENTATIONS) {
    assert.equal(impl.whatsappUrl('0597862389'), 'https://wa.me/970597862389', where);
  }
});

test('ولا يُبنى رابطٌ لرقم أرضيّ', () => {
  for (const [where, impl] of IMPLEMENTATIONS) {
    assert.equal(impl.whatsappUrl('08-2848823'), '', where);
  }
});

test('والنصّ يُرمَّز في الرابط', () => {
  for (const [where, impl] of IMPLEMENTATIONS) {
    const url = impl.whatsappUrl('0597862389', 'أهلًا بك');
    assert.ok(url.includes('?text=%D8%A3%D9%87%D9%84'), `${where}: ${url}`);
  }
});

test('ولا يُسرَّب النصّ إلى رابطٍ فارغ', () => {
  for (const [where, impl] of IMPLEMENTATIONS) {
    assert.equal(impl.whatsappUrl('', 'أهلًا'), '', where);
  }
});

test('والعرض للعين يفصل المقدّمة عن الرقم', () => {
  assert.equal(browser.displayPhone('0592500015'), '+970 59 250 0015');
  /* وما لا يصلح يُعرض كما كُتب: إعادةُ صياغةٍ لرقمٍ لم يُفهَم تخفي العطل. */
  assert.equal(browser.displayPhone('08-2848823'), '08-2848823');
});
