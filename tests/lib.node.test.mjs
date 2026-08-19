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
