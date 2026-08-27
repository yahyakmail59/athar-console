/**
 * فحص المنصة على الإنتاج الحيّ.
 *
 * الاختبارات المحلية تمرّ حيث يفشل الحيّ — تكرّر هذا في المشروع أكثر من مرة
 * (سقف PBKDF2، أصول اللوحة، تقنين `/index.html`). فهذا الملف يسأل الإنتاج
 * نفسه، بلا كائنات وهمية.
 *
 * التشغيل:
 *   node scripts/verify-live.mjs
 *
 * ومع السرّ المشترك يضيف فحوص المحوّل الموقَّعة:
 *   ATHAR_ADAPTER_SECRET=... node scripts/verify-live.mjs
 *
 * السرّ من البيئة لا من ملف ولا وسيط: الوسيط يبقى في تاريخ الطرفية.
 */

const SITE = 'https://athar.date';
const CONSOLE = 'https://console.athar.date';
const SCHOOL = 'https://school.athar.date';
const PHARMACY = 'https://pharmacy.athar.date';

const secret = process.env.ATHAR_ADAPTER_SECRET || '';
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function status(url, init) {
  const response = await fetch(url, { redirect: 'follow', ...init });
  return { code: response.status, text: await response.text() };
}

/* ---------- التوقيع، كما تبنيه اللوحة ---------- */

const encoder = new TextEncoder();
const toHex = (buffer) => Array.from(new Uint8Array(buffer))
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function signedFetch(method, path, bodyObject = null) {
  const requestId = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = bodyObject ? JSON.stringify({ ...bodyObject, request_id: requestId }) : '';
  const hash = toHex(await crypto.subtle.digest('SHA-256', encoder.encode(rawBody)));
  // المسار وحده بلا استعلام — كما يوقّع الطرفان.
  const pathname = new URL(path, SITE).pathname;
  const canonical = [timestamp, requestId, method, pathname, hash].join('\n');
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));
  const response = await fetch(new URL(path, SITE), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Athar-Timestamp': timestamp,
      'X-Athar-Request-Id': requestId,
      'X-Athar-Signature': signature,
    },
    body: rawBody || undefined,
  });
  return { code: response.status, body: await response.json().catch(() => null) };
}

/* ==================== 1. الأبواب الخمسة مفتوحة ==================== */

console.log('\n▸ الخدمات الخمس');

for (const [name, url] of [
  ['موقع أثر', SITE],
  ['لوحة أثر', CONSOLE],
  ['محرك المدارس', SCHOOL],
  ['محرك الصيدليات', PHARMACY],
]) {
  await check(`${name} يستجيب`, async () => {
    const { code } = await status(url);
    assert(code === 200, `أعاد ${code}`);
  });
}

/* ==================== 2. الأبواب الداخلية مغلقة ==================== */

console.log('\n▸ حماية مسارات المحوّل');

for (const path of ['/internal/v1/leads', '/internal/v1/showcase']) {
  await check(`${path} يرفض بلا توقيع`, async () => {
    const { code } = await status(new URL(path, SITE));
    assert(code === 401, `أعاد ${code} — 404 يعني أن المسار غير منشور، و200 يعني بابًا مفتوحًا`);
  });
}

await check('/internal/v1/leads يرفض توقيعًا مزوَّرًا', async () => {
  const { code } = await status(new URL('/internal/v1/leads', SITE), {
    headers: {
      'X-Athar-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Athar-Request-Id': crypto.randomUUID(),
      'X-Athar-Signature': 'f'.repeat(64),
    },
  });
  assert(code === 401, `أعاد ${code}`);
});

await check('مسارات اللوحة تحتاج جلسة', async () => {
  for (const path of ['/api/leads', '/api/reports/revenue', '/api/reports/limits']) {
    const { code } = await status(new URL(path, CONSOLE));
    assert(code === 401, `${path} أعاد ${code}`);
  }
});

/* ==================== 3. هوية المدرسة من الرابط ==================== */

console.log('\n▸ روابط المدارس');

await check('رمز صالح يعيد اسم المدرسة الصحيح', async () => {
  const response = await fetch(`${SCHOOL}/api/school-brand?school=ATH_RMOOZ-SCHOOL2_EB891426`);
  const payload = await response.json();
  assert(response.status === 200, `أعاد ${response.status}`);
  assert(payload.name && payload.name.includes('رموز'), `الاسم المعاد: ${payload.name}`);
});

await check('رمز مجهول يعيد 404 لا اسمًا افتراضيًا', async () => {
  const { code } = await status(`${SCHOOL}/api/school-brand?school=ATH_NOPE_00000000`);
  assert(code === 404, `أعاد ${code}`);
});

await check('الشعار المحايد مخدوم', async () => {
  const { code } = await status(`${SCHOOL}/assets/images/school-generic.svg`);
  assert(code === 200, `أعاد ${code}`);
});

await check('مكتبة إكسل مخدومة — بدونها يموت زر تنزيل النموذج', async () => {
  const response = await fetch(`${SCHOOL}/vendor/xlsx.min.js`);
  assert(response.status === 200, `أعادت ${response.status}`);
  const text = await response.text();
  assert(text.includes('var XLSX'), 'الملف المخدوم ليس مكتبة إكسل');
});

await check('شيفرة الواجهة المخدومة تنتظر المكتبة قبل توليد النموذج', async () => {
  const response = await fetch(`${SCHOOL}/src/app.js`);
  const text = await response.text();
  const handler = text.slice(text.indexOf("$('#download-template')"));
  const awaitAt = handler.indexOf('await loadXlsxLibrary()');
  const useAt = handler.indexOf('downloadExcelTemplate(');
  assert(awaitAt !== -1, 'المستمع لا ينتظر المكتبة — الزر ميت');
  assert(awaitAt < useAt, 'المكتبة تُنتظر بعد استعمالها');
});

/* ==================== 4. المحوّل الموقَّع (يحتاج السرّ) ==================== */

if (!secret) {
  console.log('\n▸ فحوص المحوّل الموقَّعة — تخطّيت (لا ATHAR_ADAPTER_SECRET في البيئة)');
} else {
  console.log('\n▸ المحوّل الموقَّع');

  await check('التوقيع الصحيح يُقبل وتُقرأ قائمة التسليم', async () => {
    const { code, body } = await signedFetch('GET', '/internal/v1/leads?limit=5');
    assert(code === 200, `أعاد ${code} — 401 يعني أن السرّ مختلف بين اللوحة والموقع`);
    assert(Array.isArray(body?.leads), 'الرد بلا قائمة leads');
    console.log(`      (${body.leads.length} رسالة تنتظر التسليم)`);
  });

  await check('الإقرار بمعرّف لا وجود له لا يمسّ شيئًا', async () => {
    const { code, body } = await signedFetch('POST', '/internal/v1/leads/ack', { ids: ['probe-nonexistent'] });
    assert(code === 200, `أعاد ${code}`);
    assert(body.acknowledged === 0, `أقرّ بـ${body.acknowledged} وهو لا وجود له`);
  });
}

/* ==================== النتيجة ==================== */

console.log(`\n${passed} فحصًا نجح، ${failures.length} فشل.`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
