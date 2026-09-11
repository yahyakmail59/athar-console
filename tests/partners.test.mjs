/**
 * باب الشركاء: التوقيع، وما لا يجوز أن يمرّ منه.
 *
 * الخطر هنا ليس عطلًا يُرى، بل بابٌ يُفتح أوسع مما قُصد: مسارٌ بلا جلسة
 * على اللوحة التي تملك كل عملائك. فالفحوص تسأل سؤالين لا غير:
 *   ١. هل يُردّ من لا يملك السرّ؟
 *   ٢. وهل يستطيع من يملكه أن يتجاوز ما رُسم له؟
 *
 * والثاني أهمّ. سرقة السرّ حادثة، أما مسارٌ يقبل `environment: production`
 * فعطلٌ يعمل كل يوم بلا أن يلاحظه أحد.
 *
 * التشغيل: node --test tests/partners.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const { readPartnerDemo, resolveDemoPlan, verifyPartnerSignature } = await import('../src/partners.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'partner-secret-for-tests-only';
const ORIGIN = 'https://console.athar.test';
const NOW = Date.parse('2026-09-08T10:00:00.000Z');

/* ==================== أدوات ==================== */

const encoder = new TextEncoder();

const hex = (buffer) => [...new Uint8Array(buffer)]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (value) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

/** يوقّع كما توقّع أداة المبيعات — الطابع بالثواني. */
async function sign(path, rawBody, {
  /* الطابع من الساعة الحقيقية: الخادم يقارن بها، وتجميدها هنا يعني أن كل
     طلبٍ صحيح يُردّ «منتهي الصلاحية» فتمرّ الفحوص السالبة وحدها. */
  secret = SECRET, timestamp = String(Math.floor(Date.now() / 1000)), requestId = 'req-1', method = 'POST',
} = {}) {
  const canonical = `${timestamp}\n${requestId}\n${method}\n${path}\n${await sha256Hex(rawBody)}`;
  return {
    'Content-Type': 'application/json',
    'X-Athar-Timestamp': timestamp,
    'X-Athar-Request-Id': requestId,
    'X-Athar-Signature': await hmacHex(secret, canonical),
  };
}

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
  return {
    prepare: (sql) => wrap(sql),
    /* `batch` في D1 ذرّيّ. هنا يكفي التتابع: ما يُفحص هو ما كُتب لا كيف. */
    batch: async (statements) => {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
}

/** قاعدةٌ من الهجرات نفسها لا من ذاكرة كاتب الفحص. */
function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return sqlite;
}

/** محرك المطاعم كما يردّ عند نجاح التهيئة. */
function fakeEngine(calls) {
  return {
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return new Response(JSON.stringify({
        ok: true,
        request_id: 'r',
        tenant_id: 't',
        external_tenant_id: 'ext-1',
        status: 'active',
        environment: 'demo',
        public_url: 'https://alaseel.athar.date',
        credentials: { pharmacy_id: 'alaseel', owner_pin: '482913' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}

function makeEnv(sqlite, calls = []) {
  return {
    DB: fakeD1(sqlite),
    CRM_PARTNER_SECRET: SECRET,
    ATHAR_ADAPTER_SECRET: 'adapter-secret',
    SESSION_SECRET: 'session-secret-session-secret',
    ADMIN_PASSWORD_HASH: 'aa:bb',
    RESTAURANT_ADAPTER: fakeEngine(calls),
    ASSETS: { fetch: async () => new Response('ok', { status: 200 }) },
  };
}

const post = (env, path, body, headers) => worker.fetch(
  new Request(ORIGIN + path, { method: 'POST', headers, body }),
  env,
  { waitUntil() {}, passThroughOnException() {} },
);

/* ==================== التوقيع ==================== */

test('طلبٌ بلا توقيع يُردّ', async () => {
  const env = makeEnv(freshDb());
  const response = await post(env, '/api/partners/demo', '{}', { 'Content-Type': 'application/json' });
  assert.equal(response.status, 401);
});

test('وتوقيعٌ بسرٍّ آخر يُردّ', async () => {
  const path = '/api/partners/demo';
  const body = JSON.stringify({ request_id: 'a' });
  const env = makeEnv(freshDb());
  const response = await post(env, path, body, await sign(path, body, { secret: 'another-secret' }));
  assert.equal(response.status, 401);
});

test('وجسمٌ بُدّل بعد التوقيع يُردّ', async () => {
  const path = '/api/partners/demo';
  const headers = await sign(path, JSON.stringify({ slug: 'alaseel' }));
  const env = makeEnv(freshDb());
  /* التوقيع على جسمٍ والمُرسَل غيره: هذا هو الهجوم لا الخطأ. */
  const response = await post(env, path, JSON.stringify({ slug: 'someone-else' }), headers);
  assert.equal(response.status, 401);
});

test('والطابع الزمني بالميلي ثانية يُردّ', async () => {
  /* عطلٌ وقع من قبل في هذا العقد نفسه: طرفٌ يوقّع بالثواني وآخر بالميلي.
     الرقم يبدو صالحًا، والفرق بينهما أربعون ألف سنة. */
  const env = makeEnv(freshDb());
  await assert.rejects(
    () => verifyPartnerSignature(
      env,
      new Request(ORIGIN + '/api/partners/demo', { method: 'POST' , headers: {
        'X-Athar-Timestamp': String(NOW),
        'X-Athar-Request-Id': 'r',
        'X-Athar-Signature': 'x'.repeat(64),
      } }),
      '',
      NOW,
    ),
    (error) => error.code === 'SIGNATURE_EXPIRED',
  );
});

test('وطلبٌ عمره ساعة يُردّ ولو صحّ توقيعه', async () => {
  const path = '/api/partners/demo';
  const body = '{}';
  const old = String(Math.floor((Date.now() - 3600_000) / 1000));
  const env = makeEnv(freshDb());
  const response = await post(env, path, body, await sign(path, body, { timestamp: old }));
  assert.equal(response.status, 401);
});

test('وبلا سرٍّ مضبوط في اللوحة يُردّ الباب كلّه', async () => {
  const env = makeEnv(freshDb());
  delete env.CRM_PARTNER_SECRET;
  const path = '/api/partners/demo';
  const body = '{}';
  const response = await post(env, path, body, await sign(path, body));
  assert.equal(response.status, 503);
});

/* ==================== حدود ما يُطلب ==================== */

test('نوع النسخة لا يُقرأ من الشريك أصلًا', () => {
  const input = readPartnerDemo({
    request_id: 'r', lead_id: 'R05', product_id: 'restaurant',
    slug: 'alaseel', display_name: 'مطعم الأصيل',
    environment: 'production',
  });
  assert.equal('environment' in input, false, 'وصل نوع النسخة إلى ما بعد القراءة');
});

test('ومنتجٌ خارج القائمة يُرفض', () => {
  assert.throws(() => readPartnerDemo({
    request_id: 'r', lead_id: 'R05', product_id: 'console',
    slug: 'x1', display_name: 'س',
  }), (error) => error.code === 'PRODUCT_NOT_ALLOWED');
});

test('ومعرّفٌ فيه نقطة يُرفض — النطاق الفرعيّ يُشتقّ منه', () => {
  assert.throws(() => readPartnerDemo({
    request_id: 'r', lead_id: 'R05', product_id: 'restaurant',
    slug: 'a.b', display_name: 'س',
  }), (error) => error.code === 'INVALID_SLUG');
});

test('ومدّة التجربة تُقصّ ولا تُترك مفتوحة', () => {
  const long = readPartnerDemo({
    request_id: 'r', lead_id: 'R05', product_id: 'restaurant',
    slug: 'x1', display_name: 'س', trial_days: 9999,
  });
  assert.equal(long.trialDays, 30, 'تجربةٌ بلا نهاية ليست تجربة');

  const missing = readPartnerDemo({
    request_id: 'r', lead_id: 'R05', product_id: 'restaurant',
    slug: 'x1', display_name: 'س',
  });
  assert.equal(missing.trialDays, 14);
});

/* ==================== انتهاء التجربة ==================== */

test('تجربة أداة المبيعات تتوقّف عند انتهاء مدّتها', async () => {
  /* `auto_suspend` افتراضه صفر في المخطّط، ودورة الاشتراكات لا تمسّ من
     كان عليه صفرًا. فكانت الرسالة تقول للعميل «تعمل أربعة عشر يومًا»
     وهي تعمل إلى الأبد — هديّةٌ لا تجربة. */
  const sqlite = freshDb();
  const env = makeEnv(sqlite);
  const path = '/api/partners/demo';
  const body = JSON.stringify({
    request_id: 'req-exp', lead_id: 'R11', product_id: 'restaurant',
    slug: 'expires', display_name: 'ينتهي',
  });

  await post(env, path, body, await sign(path, body));

  const row = sqlite.prepare(
    `SELECT s.auto_suspend, s.status, s.current_period_end
     FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = ?`,
  ).get('expires');
  assert.equal(Number(row.auto_suspend), 1, 'التجربة لن تتوقّف أبدًا');
  assert.equal(row.status, 'trialing');
  assert.ok(row.current_period_end, 'بلا تاريخ انتهاء لا تلتقطها الدورة');
});

test('والشريك لا يستطيع تعطيل الإيقاف بطلبه', async () => {
  /* القرار في اللوحة لا عند المُنادي: `auto_suspend` لا يُقرأ من جسم
     الشريك أصلًا، فإرسال صفرٍ لا يجعل التجربة دائمة. */
  const sqlite = freshDb();
  const env = makeEnv(sqlite);
  const path = '/api/partners/demo';
  const body = JSON.stringify({
    request_id: 'req-forever', lead_id: 'R12', product_id: 'restaurant',
    slug: 'forever-try', display_name: 'محاولة دوام', auto_suspend: 0,
  });

  await post(env, path, body, await sign(path, body));

  const row = sqlite.prepare(
    `SELECT s.auto_suspend FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
     WHERE t.slug = ?`,
  ).get('forever-try');
  assert.equal(Number(row.auto_suspend), 1, 'الشريك جعل تجربته دائمة');
});

/* ==================== الشعار ==================== */

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('الشعار يمرّ إلى المحرك', async () => {
  const sqlite = freshDb();
  const calls = [];
  const env = makeEnv(sqlite, calls);
  const path = '/api/partners/demo';
  const body = JSON.stringify({
    request_id: 'req-logo', lead_id: 'R09', product_id: 'restaurant',
    slug: 'with-logo', display_name: 'مطعم بشعار', logo_data_url: LOGO,
  });

  const response = await post(env, path, body, await sign(path, body));
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(calls[0].body.config.logo_data_url, LOGO, 'لم يصل الشعار إلى المحرك');
});

test('وملفٌ ليس صورة يُرفض', () => {
  assert.throws(() => readPartnerDemo({
    request_id: 'r', lead_id: 'R05', product_id: 'restaurant',
    slug: 'x1', display_name: 'س',
    /* `data:text/html` في وسم `<img src>` لا يُنفَّذ، لكن قبول أيّ
       `data:` يعني تخزين ما يُرسَل بلا فحصٍ لنوعه. */
    logo_data_url: 'data:text/html;base64,PHNjcmlwdD4=',
  }), (error) => error.code === 'INVALID_LOGO');
});

test('وشعارٌ ضخم يُرفض قبل أن يبلغ القاعدة', () => {
  assert.throws(() => readPartnerDemo({
    request_id: 'r', lead_id: 'R05', product_id: 'restaurant',
    slug: 'x1', display_name: 'س',
    logo_data_url: `data:image/png;base64,${'A'.repeat(50000)}`,
  }), (error) => error.code === 'FIELD_TOO_LONG');
});

test('وبلا شعار يمرّ الطلب فارغًا لا معطوبًا', async () => {
  const sqlite = freshDb();
  const calls = [];
  const env = makeEnv(sqlite, calls);
  const path = '/api/partners/demo';
  const body = JSON.stringify({
    request_id: 'req-nologo', lead_id: 'R10', product_id: 'restaurant',
    slug: 'no-logo', display_name: 'بلا شعار',
  });
  await post(env, path, body, await sign(path, body));
  assert.equal(calls[0].body.config.logo_data_url, '');
});

/* ==================== اختيار الباقة ==================== */

test('باقة التجربة هي الأغلى المفعّلة', async () => {
  const sqlite = freshDb();
  const env = makeEnv(sqlite);
  assert.equal(await resolveDemoPlan(env, 'restaurant', ''), 'restaurant:full');
});

test('وباقةٌ مطلوبة باسمها تُحترم', async () => {
  const env = makeEnv(freshDb());
  assert.equal(await resolveDemoPlan(env, 'restaurant', 'menu'), 'restaurant:menu');
});

test('وباقةٌ لا وجود لها تُرفض ولا تسقط على غيرها', async () => {
  const env = makeEnv(freshDb());
  await assert.rejects(
    () => resolveDemoPlan(env, 'restaurant', 'free-forever'),
    (error) => error.code === 'INVALID_PLAN',
  );
});

/* ==================== الطريق كاملًا ==================== */

test('طلبٌ موقّع يُنشئ نسخةً تجريبية ويعيد بياناتها', async () => {
  const sqlite = freshDb();
  const calls = [];
  const env = makeEnv(sqlite, calls);
  const path = '/api/partners/demo';
  const body = JSON.stringify({
    request_id: 'req-1', lead_id: 'R05', product_id: 'restaurant',
    slug: 'alaseel', display_name: 'مطعم الأصيل',
    brand_kit_code: 'b12_red', phone: '0592500015',
  });

  const response = await post(env, path, body, await sign(path, body));
  const payload = await response.json();

  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.status, 'active');
  assert.equal(payload.public_url, 'https://alaseel.athar.date');
  assert.ok(payload.credentials?.owner_pin, 'لم تعد البيانات التي تُرسل للعميل');

  const row = sqlite.prepare(
    'SELECT environment, status, product_id, brand_kit_id, trial_expires_at FROM tenants WHERE slug = ?',
  ).get('alaseel');
  assert.equal(row.environment, 'demo');
  assert.equal(row.brand_kit_id, 'restaurant:b12_red');
  assert.ok(row.trial_expires_at, 'تجربةٌ بلا تاريخ انتهاء تبقى مجّانيةً للأبد');

  assert.equal(calls.length, 1, 'لم يُنادَ المحرك');
  assert.equal(calls[0].body.environment, 'demo');
});

test('وطلبٌ يقول `production` ينتهي تجربةً لا إنتاجًا', async () => {
  const sqlite = freshDb();
  const env = makeEnv(sqlite);
  const path = '/api/partners/demo';
  /* هذا هو الفحص الذي يبرّر الباب كلّه. */
  const body = JSON.stringify({
    request_id: 'req-2', lead_id: 'R06', product_id: 'restaurant',
    slug: 'production-try', display_name: 'محاولة',
    environment: 'production',
  });

  const response = await post(env, path, body, await sign(path, body));
  assert.equal(response.status, 201, await response.clone().text());

  const row = sqlite.prepare('SELECT environment FROM tenants WHERE slug = ?').get('production-try');
  assert.equal(row.environment, 'demo', 'الشريك بلغ الإنتاج');
});

test('والسجلّ يقول إن الأداة فعلتها لا المشغّل', async () => {
  const sqlite = freshDb();
  const env = makeEnv(sqlite);
  const path = '/api/partners/demo';
  const body = JSON.stringify({
    request_id: 'req-3', lead_id: 'R07', product_id: 'restaurant',
    slug: 'audit-check', display_name: 'تدقيق',
  });

  await post(env, path, body, await sign(path, body));

  const row = sqlite.prepare(
    "SELECT actor_type, actor_id FROM audit_logs WHERE action = 'tenant.register' LIMIT 1",
  ).get();
  assert.equal(row.actor_id, 'athar-crm', 'ظهر عميلٌ في السجل كأن المشغّل أنشأه');
});

test('ومعرّفٌ مكرّر يُرفض فلا تُنشأ نسختان', async () => {
  const sqlite = freshDb();
  const env = makeEnv(sqlite);
  const path = '/api/partners/demo';
  const body = JSON.stringify({
    request_id: 'req-4', lead_id: 'R08', product_id: 'restaurant',
    slug: 'twice', display_name: 'مرّتان',
  });

  const first = await post(env, path, body, await sign(path, body));
  assert.equal(first.status, 201);

  const second = await post(env, path, body, await sign(path, body, { requestId: 'req-5' }));
  assert.equal(second.status, 409, 'ضغطةٌ ثانية أنشأت مطعمًا ثانيًا');

  const count = sqlite.prepare('SELECT COUNT(*) AS n FROM tenants WHERE slug = ?').get('twice');
  assert.equal(Number(count.n), 1);
});

test('وإعادة إصدار البيانات لا تمسّ عميلًا إنتاجيًّا', async () => {
  const sqlite = freshDb();
  const env = makeEnv(sqlite);
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO customers (id, display_name, contact_name, phone, email, address, notes, status, created_at, updated_at)
     VALUES ('c1','عميل','عميل','','','','','customer',?,?)`,
  ).run(now, now);
  sqlite.prepare(
    `INSERT INTO tenants (id, customer_id, product_id, slug, display_name, environment, status,
     plan_id, external_tenant_id, public_url, created_at, updated_at)
     VALUES ('t-prod','c1','restaurant','paying','عميل يدفع','production','active','restaurant:full','ext','https://paying.athar.date',?,?)`,
  ).run(now, now);

  const path = '/api/partners/credentials';
  const body = JSON.stringify({ tenant_id: 't-prod' });
  const response = await post(env, path, body, await sign(path, body));

  assert.equal(response.status, 404, 'أداة المبيعات أبطلت جلسات عميل يدفع');
});
