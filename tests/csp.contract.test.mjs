/**
 * عقد سياسة المحتوى: لا شيء مضمّن، لأن السياسة تمنعه بصمت.
 *
 * `_headers` يعلن `style-src 'self'` و`script-src 'self'` بلا
 * `'unsafe-inline'` — وهو الصواب. لكن أثره أن **كل سمة `style` مضمّنة
 * تُلغى بلا رسالة**: تبقى في الوسم، ولا تُطبَّق، ولا يظهر خطأ في وحدة
 * التحكم يدلّ عليها.
 *
 * وقد كلّف هذا فعلًا: خمس حشوات في رؤوس اللوحات لم تُطبَّق يومًا، ورسمُ
 * المحصَّل ظهر أعمدةً متساوية الطول لأن `transform` كُتب سمةً. والضبط عبر
 * `element.style` من الشيفرة مسموح — ليس سمةً — فهو الطريق الوحيد.
 *
 * التشغيل: node --test tests/csp.contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const publicDir = new URL('../public/', import.meta.url);
const read = (name) => readFileSync(new URL(name, publicDir), 'utf8');

test('السياسة تمنع المضمّن — فلا يُكتب مضمّن', () => {
  const headers = read('_headers');
  const policy = headers.match(/Content-Security-Policy:\s*([^\n]+)/)?.[1] ?? '';
  assert.ok(policy, 'لا سياسة محتوى في _headers');

  // لو أُضيف `'unsafe-inline'` يومًا فليكن قرارًا مكتوبًا لا انزلاقًا.
  assert.ok(!policy.includes("'unsafe-inline'"),
    'السياسة سمحت بالمضمّن — إن كان مقصودًا فاشرح لماذا هنا');

  const html = read('index.html');
  const attrs = [...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(attrs, [],
    'سمات style مضمّنة لا تُطبَّق أبدًا مع هذه السياسة:\n' + attrs.join('\n'));

  // ومعالجات الأحداث المضمّنة يمنعها `script-src` كذلك.
  const handlers = [...html.matchAll(/\son(?:click|change|input|submit|load)="/g)];
  assert.equal(handlers.length, 0, 'معالجات أحداث مضمّنة لا تعمل مع هذه السياسة');
});

test('الشيفرة لا تكتب سمة style على عنصر', () => {
  // `element(..., { attrs: { style } })` يكتب سمة، فتُلغى. والمسموح
  // `node.style.prop = …` لأنه ليس سمةً.
  const app = read('app.js');
  const written = [...app.matchAll(/attrs:\s*\{[^}]*\bstyle\b/g)].map((m) => m[0].slice(0, 60));
  assert.deepEqual(written, [],
    'كتابة سمة style من الشيفرة — استعمل element.style بدلها:\n' + written.join('\n'));

  const setAttr = [...app.matchAll(/setAttribute\(\s*['"]style['"]/g)];
  assert.equal(setAttr.length, 0, 'setAttribute("style") تُلغى بالسياسة');
});
