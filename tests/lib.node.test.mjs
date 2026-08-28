import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpError,
  assertDate,
  assertMinorAmount,
  assertSlug,
  normalizeSlug,
  optionalText,
  requiredText,
} from '../.test-build/src/lib.js';
import { createHash, createHmac } from 'node:crypto';
import { signedAdapterHeaders } from '../.test-build/src/adapter.js';

test('tenant slug is normalized and validated', () => {
  assert.equal(normalizeSlug('  Al-Amal-01  '), 'al-amal-01');
  assert.equal(assertSlug('al-amal-01'), 'al-amal-01');
  for (const slug of ['-bad', 'bad-', 'اسم-عربي', 'a'.repeat(41), 'two words']) {
    assert.throws(() => assertSlug(slug), HttpError);
  }
});

test('text inputs are required and bounded', () => {
  assert.equal(requiredText(' أثر ', 'الاسم', 10), 'أثر');
  assert.throws(() => requiredText('', 'الاسم', 10), HttpError);
  assert.throws(() => optionalText('1234', 'حقل', 3), HttpError);
});

test('money is accepted only as safe integer minor units', () => {
  assert.equal(assertMinorAmount(1250), 1250);
  assert.equal(assertMinorAmount(0, true), 0);
  assert.throws(() => assertMinorAmount(12.5), HttpError);
  assert.throws(() => assertMinorAmount(0), HttpError);
});

test('ISO dates must represent real calendar dates', () => {
  assert.equal(assertDate('2026-08-19', 'التاريخ'), '2026-08-19');
  assert.equal(assertDate('', 'التاريخ'), null);
  assert.throws(() => assertDate('2026-02-30', 'التاريخ'), HttpError);
});

test('product adapter signature matches the documented canonical request', async () => {
  const secret = 'local-test-secret';
  const method = 'POST';
  const path = '/internal/v1/tenants';
  const requestId = '11111111-1111-4111-8111-111111111111';
  const timestamp = '1787160000';
  const body = JSON.stringify({ request_id: requestId, tenant_id: 'tenant-1' });
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n${requestId}\n${method}\n${path}\n${bodyHash}`)
    .digest('hex');
  const headers = await signedAdapterHeaders(secret, method, path, requestId, body, timestamp);
  assert.equal(headers.get('X-Athar-Signature'), expected);
  assert.equal(headers.get('X-Athar-Request-Id'), requestId);
});

test('DELETE adapter calls sign an empty body like GET does', async () => {
  const secret = 'local-test-secret';
  const path = '/internal/v1/tenants/tenant-1';
  const requestId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '1787160000';
  const emptyHash = createHash('sha256').update('').digest('hex');
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}\n${requestId}\nDELETE\n${path}\n${emptyHash}`)
    .digest('hex');
  const headers = await signedAdapterHeaders(secret, 'DELETE', path, requestId, '', timestamp);
  assert.equal(headers.get('X-Athar-Signature'), expected);
});

// كل إجراء يكتبه الكود في provisioning_jobs يجب أن يقبله قيد CHECK في المخطط.
// أغفلت النسخة الأولى `restore` فصارت الاستعادة من الأرشيف تفشل بخطأ 500،
// وهو خطأ لا تكشفه مراجعة الكود لأن الطرفين صحيحان كلٌّ على حدة.
test('every provisioning action used in code is allowed by the schema CHECK', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const migrations = readdirSync('migrations').sort()
    .map((file) => readFileSync(`migrations/${file}`, 'utf8')).join('\n');
  const blocks = [...migrations.matchAll(/action\s+TEXT NOT NULL\s*\n?\s*CHECK \(action IN \(([^)]*)\)/g)];
  assert.ok(blocks.length, 'no provisioning action CHECK found in migrations');
  const allowed = new Set(
    [...blocks.at(-1)[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]),
  );

  const source = readFileSync('src/index.ts', 'utf8');
  const used = new Set(
    [...source.matchAll(/INSERT INTO provisioning_jobs[\s\S]{0,400}?VALUES \(\?, \?, '([a-z_]+)'/g)]
      .map((match) => match[1]),
  );
  // الإجراءات التي تُمرَّر كمتغير `action` من مسار دورة الحياة.
  for (const action of ['suspend', 'resume', 'archive', 'restore']) used.add(action);

  for (const action of used) {
    assert.ok(allowed.has(action), `provisioning action '${action}' is used but not allowed by the schema`);
  }
});

// كل مسار محوّل تناديه اللوحة يجب أن يوجد في كل محرك مربوط.
// المدرسة كانت تسمّيه reset-admin-password واللوحة تنادي reset-owner-pin،
// فكان الزر يعيد "Adapter route not found" لعملاء المدارس وحدهم.
test('every adapter path the console calls exists in every engine', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const source = readFileSync('src/index.ts', 'utf8');
  const paths = [...source.matchAll(/path: `\/internal\/v1\/tenants\/\$\{[^}]+\}\/([a-z-]+)`/g)]
    .map((match) => match[1]);
  assert.ok(paths.length >= 3, 'no adapter paths found in the console source');

  // قائمة المحركات تُشتق من `PRODUCT_ADAPTERS` لا تُكتب هنا. القائمة اليدوية
  // كانت تصمت عن منتج جديد: يُربط بمحرك وينسى أحدهم إضافته هنا، فيمر الفحص
  // وهو لا يفحص شيئًا.
  const adapterSource = readFileSync('src/adapter.ts', 'utf8');
  const wired = [...adapterSource.matchAll(/^ {2}([a-z_]+): \{ binding:/gm)].map((match) => match[1]);
  assert.ok(wired.length >= 2, 'no wired products found in PRODUCT_ADAPTERS');

  const engines = {
    pharmacy: '../pharma-gaza/worker/worker.js',
    school: '../rowad-gaza-school/worker/worker.js',
    restaurant: '../athar-restaurant/worker/adapter.js',
    clinic: '../athar-clinic/worker/adapter.js',
  };
  for (const product of wired) {
    assert.ok(
      engines[product],
      `'${product}' is wired in PRODUCT_ADAPTERS but this test does not know where its engine lives`,
    );
    if (!existsSync(engines[product])) continue;
    const engine = readFileSync(engines[product], 'utf8');
    for (const path of paths) {
      assert.ok(
        engine.includes(path),
        `the console calls '${path}' but the ${product} engine does not route it`,
      );
    }
  }
});

// المحوّل يرفض أي طلب بجسم لا يحمل request_id مطابقًا للترويسة. نسيانه يعيد
// 400 يظهر للمشغّل كأن المحرك لا يستجيب، بينما اللوحة هي المخطئة.
test('every adapter call with a body carries a matching request_id', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('src/index.ts', 'utf8');
  const calls = [...source.matchAll(/callProductAdapter<[^>]*>\(\s*env,[\s\S]{0,1200}?\}\);/g)]
    .map((match) => match[0]);
  assert.ok(calls.length >= 4, `expected several adapter calls, found ${calls.length}`);

  for (const call of calls) {
    const body = call.match(/body:\s*([^,\r\n]+)/)?.[1]?.trim();
    if (!body) continue;
    // الجسم إما كائن مكتوب في مكانه أو اسم متغيّر؛ في الحالة الثانية نفتش
    // تعريفه، وإلا حسبنا استدعاءً سليمًا خاطئًا.
    // الأجسام المكتوبة في مكانها فقط: الجسم القادم من متغيّر قد يُقرأ من مهمة
    // محفوظة، ولا يستطيع فحص ثابت تتبّعه. تلك يغطيها اختبار التكامل ورفض
    // المحرك نفسه لأي طلب بمعرّف غير مطابق.
    if (!body.startsWith('{')) continue;
    assert.ok(
      /request_id:/.test(call),
      `an inline adapter body is missing request_id: ${call.slice(0, 200)}`,
    );
  }
});
