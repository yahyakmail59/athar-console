/**
 * كل حاوية تُرسم فيها بطاقة عميل، لها مستمع نقرات.
 *
 * لماذا هذا الملف موجود: أزرار بطاقة العميل مفوَّضة — تحمل `data-action`
 * ويلتقطها مستمعٌ على الحاوية، لا على الزرّ. فحاويةٌ تُرسم فيها البطاقات
 * بلا مستمع تعني **كل أزرارها ميتة**.
 *
 * وقد وقع: صفحة «العملاء المحتملون» ترسم `clientCard` في
 * `leads-container`، والمستمع مربوط بثلاث حاويات غيرها. فكان المشغّل
 * يضغط «بيانات دخول جديدة» أو «إيقاف» أو «فحص الصحة» فلا يحدث شيء **ولا
 * تظهر رسالة** — والعطل الصامت أسوأ من العطل الصاخب: يبدو النظام معطوبًا
 * كلّه لا زرًّا واحدًا، ويُبحث عن السبب في الخادم وهو في سطر ربط.
 *
 * والفحص يقرأ `app.js` المنشور نفسه: أي حاوية تُذكر مع `clientCard` يجب
 * أن تُذكر مع `handleClientAction`.
 *
 * التشغيل: node --test tests/card-actions.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/** الحاويات التي تُرسم فيها بطاقة عميل، مأخوذة من الشيفرة لا مكتوبة هنا. */
function containersRenderingCards() {
  // بجسم الدالة لا بنافذة محارف: نافذةٌ حول اسم الحاوية تلتقط دوالَّ
  // مجاورة، فأنذرت على حاوية الباقات وهي لا ترسم بطاقة عميل.
  const found = new Set();
  const heads = [...app.matchAll(/^function ([a-zA-Z]+)\(/gm)];
  for (const [i, head] of heads.entries()) {
    const start = head.index;
    const end = i + 1 < heads.length ? heads[i + 1].index : app.length;
    const body = app.slice(start, end);
    if (!body.includes('clientCard(')) continue;
    for (const c of body.matchAll(/byId\('([a-z-]+container[a-z-]*)'\)/g)) found.add(c[1]);
  }
  return [...found];
}

test('كل حاوية تُرسم فيها بطاقة عميل مربوطة بمستمع النقرات', () => {
  const containers = containersRenderingCards();
  assert.ok(containers.length >= 2, `لم تُعرف الحاويات: ${containers.join(', ')}`);

  const unbound = containers.filter(
    (id) => !app.includes(`byId('${id}').addEventListener('click', handleClientAction)`),
  );
  assert.deepEqual(unbound, [],
    `حاويات تُرسم فيها بطاقات وأزرارها ميتة: ${unbound.join(', ')}`);
});

test('وحاوية العملاء المحتملين منها', () => {
  // نصٌّ صريح على الحالة التي وقعت فعلًا، كي لا يُخفيها تعميمٌ في الفحص
  // السابق لو تغيّر شكل الشيفرة.
  assert.ok(html.includes('id="leads-container"'), 'الحاوية مفقودة من الصفحة');
  assert.ok(
    app.includes("byId('leads-container').addEventListener('click', handleClientAction)"),
    'أزرار بطاقات العملاء المحتملين بلا مستمع',
  );
});

test('وأزرار البطاقة مفوَّضة لا مربوطة بالعنصر', () => {
  // لو رُبطت مباشرةً لما احتاجت مستمع الحاوية — والفحص أعلاه يصير بلا
  // معنى. هذا يُثبّت الافتراض الذي بُني عليه.
  const fn = app.slice(app.indexOf('function button('), app.indexOf('function emptyState('));
  assert.ok(/dataset: \{ action, id \}/.test(fn), 'الزرّ لم يعد يحمل `data-action`');
  assert.ok(!/onClick/.test(fn), 'الزرّ صار يُربط مباشرةً — راجع منطق الفحص');
});
