/**
 * تدقيق الربط بين لوحة أثر والمحركات — على الإنتاج الحيّ.
 *
 * لماذا هذا الملف موجود: كل عطل واجهناه تقريبًا كان في المسافة بين طرفين
 * سليمين — اللوحة تحفظ والمحرك لا يعلم، أو العكس. الاختبارات داخل كل مشروع
 * تثبت أن كل طرف صحيح وحده، ولا تثبت أنهما متصلان.
 *
 * كل فحص هنا يسأل سؤالًا واحدًا: **هل وصل الأثر إلى المحرك فعلًا؟** لا
 * «هل أعادت اللوحة 200».
 *
 * التشغيل:
 *   node tests/linkage.audit.mjs
 *
 * ينشئ مستأجرين مؤقتين ويحذفهما في النهاية مهما كانت النتيجة.
 */

import { readFileSync } from 'node:fs';

const CONSOLE = process.env.ATHAR_CONSOLE_URL || 'https://athar-console.yahyakmail59.workers.dev';
const SCHOOL = process.env.ATHAR_SCHOOL_URL || 'https://athar-school-api.yahyakmail59.workers.dev';
const PHARMA = process.env.ATHAR_PHARMA_URL || 'https://pharma-sync-api.yahyakmail59.workers.dev';
const RESTAURANT = process.env.ATHAR_RESTAURANT_URL
  || 'https://athar-restaurant-api.yahyakmail59.workers.dev';
const SECRETS = process.env.ATHAR_SECRETS_FILE
  || 'C:/Users/yahya/Desktop/compony/secrets/athar-console-admin.txt';

const password = readFileSync(SECRETS, 'utf8').match(/كلمة المرور:\s*(\S+)/)?.[1];
if (!password) throw new Error(`لم أجد كلمة مرور اللوحة في ${SECRETS}`);

let cookie = '';
let csrf = '';

async function console_(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (!['GET', 'HEAD'].includes(method) && csrf) headers['X-CSRF-Token'] = csrf;
  const response = await fetch(CONSOLE + path, { method, headers, body });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: response.status, payload: await response.json().catch(() => null) };
}

/* ==================== أدوات المطعم ==================== */

async function restaurantLogin(credentials, device = 'linkage-audit') {
  const response = await fetch(`${RESTAURANT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restaurant_id: credentials.login_id,
      username: credentials.username,
      password: credentials.secret,
      device_id: device,
    }),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

const restaurantApi = async (token, path, init = {}) => {
  const response = await fetch(RESTAURANT + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
};

/** الصفحة العامة نصًّا: الفحص الوحيد الذي يرى ما يراه زبون المطعم. */
async function restaurantPage(slug, path = '') {
  const response = await fetch(`${RESTAURANT}/r/${slug}/${path}`);
  return { status: response.status, html: await response.text() };
}

const results = [];
function check(area, question, passed, detail = '') {
  results.push({ area, question, passed, detail });
  const mark = passed ? '✅' : '❌';
  console.log(`${mark} [${area}] ${question}${detail ? ` — ${detail}` : ''}`);
}

/* ==================== أدوات المدرسة ==================== */

async function schoolLogin(credentials) {
  const response = await fetch(`${SCHOOL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      school_id: credentials.login_id,
      username: credentials.username,
      password: credentials.secret,
      device_id: 'linkage-audit',
    }),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

async function schoolProfile(token) {
  const response = await fetch(`${SCHOOL}/api/pull?since=0&stores=settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) return null;
  const payload = await response.json();
  return payload.stores.settings?.find((row) => row.id === 'schoolProfile')?.doc?.value || null;
}

async function schoolStores(token) {
  const merged = {};
  let cursor = 0;
  for (let guard = 0; guard < 40; guard += 1) {
    const response = await fetch(`${SCHOOL}/api/pull?since=${cursor}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) return { status: response.status, stores: merged };
    const payload = await response.json();
    for (const [store, rows] of Object.entries(payload.stores)) {
      (merged[store] ||= []).push(...rows);
    }
    cursor = payload.cursor;
    if (payload.complete) break;
  }
  return { status: 200, stores: merged };
}

/* ==================== أدوات الصيدلية ==================== */

async function pharmacyLogin(credentials, device = 'linkage-audit') {
  const response = await fetch(`${PHARMA}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pharmacy_id: credentials.login_id,
      pin: credentials.secret,
      device_id: device,
    }),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

async function pharmacyUpdates(token) {
  const response = await fetch(`${PHARMA}/api/get-updates?last_sync=0&device_id=linkage-audit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.status === 200 ? response.json() : null;
}

/* ==================== التدقيق ==================== */

const created = [];
const AUDIT_SCHOOL_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function cleanup() {
  for (const tenant of created) {
    try {
      await console_(`/api/tenants/${tenant.id}/lifecycle`, {
        method: 'POST', body: JSON.stringify({ action: 'archive' }),
      });
      const exported = await console_(`/api/tenants/${tenant.id}/export`, { method: 'POST', body: '{}' });
      await console_(`/api/tenants/${tenant.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm_slug: tenant.slug, export_checksum: exported.payload.checksum }),
      });
    } catch { /* التنظيف لا يُفشل التدقيق */ }
  }
}

try {
  const session = await console_('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
  if (session.status !== 200) throw new Error('تعذر الدخول إلى اللوحة — راجع كلمة المرور في ملف الأسرار.');
  csrf = session.payload.csrf;

  const catalog = (await console_('/api/dashboard')).payload.catalog;
  const stamp = Math.random().toString(16).slice(2, 7);

  /* ---------- المدرسة ---------- */

  const schoolSlug = `audit-school-${stamp}`;
  const schoolCreate = await console_('/api/tenants', {
    method: 'POST',
    body: JSON.stringify({
      display_name: 'مدرسة التدقيق', slug: schoolSlug, product_id: 'school',
      environment: 'demo', admin_username: 'audit.admin',
      plan_id: catalog.plans.find((p) => p.id === 'school:basic').id,
      phone: '0599000000', school_logo_data_url: AUDIT_SCHOOL_LOGO,
    }),
  });
  const schoolTenant = { id: schoolCreate.payload?.tenant_id, slug: schoolSlug };
  if (schoolTenant.id) created.push(schoolTenant);

  check('مدرسة/إنشاء', 'اللوحة تنشئ مستأجرًا في المحرك',
    schoolCreate.status === 201 && Boolean(schoolCreate.payload.credentials?.login_id),
    schoolCreate.payload?.external_tenant_id || schoolCreate.payload?.error || '');

  const schoolCreds = schoolCreate.payload.credentials;
  check('مدرسة/اسم المستخدم', 'الاسم المختار من اللوحة هو المستخدم فعلًا',
    schoolCreds?.username === 'audit.admin', schoolCreds?.username);

  let schoolToken = (await schoolLogin(schoolCreds)).payload?.token;
  check('مدرسة/دخول', 'بيانات اللوحة تفتح المدرسة', Boolean(schoolToken));

  const demo = await schoolStores(schoolToken);
  const createdProfile = await schoolProfile(schoolToken);
  check('school/identity', 'school name and logo reach the engine from the console',
    createdProfile?.name === 'مدرسة التدقيق' && createdProfile?.logoDataUrl === AUDIT_SCHOOL_LOGO,
    `${createdProfile?.name} / logo=${Boolean(createdProfile?.logoDataUrl)}`);
  check('مدرسة/بيانات العرض', 'النسخة التجريبية تصل ببيانات كافية',
    (demo.stores.students?.length || 0) >= 20 && (demo.stores.attendanceRecords?.length || 0) > 100,
    `طلاب=${demo.stores.students?.length || 0} حضور=${demo.stores.attendanceRecords?.length || 0}`);

  check('مدرسة/الباقة الأساسية', 'المالية محجوبة على الخادم',
    demo.stores.invoices === undefined && demo.stores.payments === undefined);

  // تغيير الباقة
  const planChange = await console_(`/api/tenants/${schoolTenant.id}/plan`, {
    method: 'PATCH', body: JSON.stringify({ plan_id: 'school:full' }),
  });
  const afterPlan = await schoolProfile(schoolToken);
  check('مدرسة/تغيير الباقة', 'الترقية تصل إلى ما تقرؤه الواجهة',
    planChange.payload?.engine_synced === true && afterPlan?.plan === 'full',
    `engine_synced=${planChange.payload?.engine_synced} plan=${afterPlan?.plan}`);

  const afterUpgrade = await schoolStores(schoolToken);
  check('مدرسة/الباقة الكاملة', 'المالية تظهر بعد الترقية',
    (afterUpgrade.stores.invoices?.length || 0) > 0,
    `فواتير=${afterUpgrade.stores.invoices?.length || 0}`);

  // تغيير الهوية
  const rename = await console_(`/api/tenants/${schoolTenant.id}/customer`, {
    method: 'PATCH', body: JSON.stringify({ display_name: 'مدرسة باسم جديد', short_name: 'الجديد' }),
  });
  const renamed = await schoolProfile(schoolToken);
  check('مدرسة/الهوية', 'تغيير الاسم من اللوحة يصل إلى المدرسة',
    rename.payload?.engine_synced === true && renamed?.name === 'مدرسة باسم جديد',
    `${renamed?.name} / ${renamed?.shortName}`);

  // المدرسة لا تملك اسمها ولا باقتها
  await fetch(`${SCHOOL}/api/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${schoolToken}` },
    body: JSON.stringify({
      changes: [{
        store: 'settings', id: 'schoolProfile',
        doc: { id: 'schoolProfile', key: 'schoolProfile', value: { name: 'مسروق', plan: 'basic' } },
      }],
    }),
  });
  const afterForge = await schoolProfile(schoolToken);
  check('مدرسة/ملكية الهوية', 'المدرسة لا تستطيع تغيير اسمها ولا باقتها',
    afterForge?.name === 'مدرسة باسم جديد' && afterForge?.plan === 'full',
    `${afterForge?.name} / ${afterForge?.plan}`);

  // بيانات دخول جديدة
  const newCreds = (await console_(`/api/tenants/${schoolTenant.id}/reset-pin`, { method: 'POST', body: '{}' }))
    .payload?.credentials;
  const oldRejected = (await schoolLogin(schoolCreds)).status === 401;
  const newAccepted = (await schoolLogin(newCreds)).status === 200;
  check('مدرسة/بيانات جديدة', 'الإصدار الجديد يعمل والقديم يبطل',
    oldRejected && newAccepted, `قديم=${oldRejected ? 'مرفوض' : 'ما زال يعمل'}`);

  schoolToken = (await schoolLogin(newCreds)).payload.token;

  // الإيقاف والاستئناف
  await console_(`/api/tenants/${schoolTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'suspend' }),
  });
  const blocked = await schoolLogin(newCreds);
  const sessionKilled = (await fetch(`${SCHOOL}/api/pull?since=0`, {
    headers: { Authorization: `Bearer ${schoolToken}` },
  })).status === 401;
  check('مدرسة/الإيقاف', 'الإيقاف يمنع الدخول ويقطع الجلسات القائمة',
    blocked.status === 403 && sessionKilled, `دخول=${blocked.status} جلسة=${sessionKilled ? 'مقطوعة' : 'حيّة'}`);

  await console_(`/api/tenants/${schoolTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'resume' }),
  });
  const resumed = await schoolLogin(newCreds);
  check('مدرسة/الاستئناف', 'الاستئناف يعيد الخدمة بلا فقد بيانات',
    resumed.status === 200 &&
    ((await schoolStores(resumed.payload.token)).stores.students?.length || 0) >= 20);

  // فحص الصحة
  const health = await console_(`/api/tenants/${schoolTenant.id}/health`, { method: 'POST', body: '{}' });
  check('مدرسة/الصحة', 'فحص الصحة يسأل المحرك ويعيد حالته',
    health.payload?.status === 'healthy', health.payload?.status);

  // الأرشفة والاستعادة
  await console_(`/api/tenants/${schoolTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'archive' }),
  });
  const archivedList = (await console_('/api/tenants/archived')).payload.archived;
  const restore = await console_(`/api/tenants/${schoolTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'restore' }),
  });
  check('مدرسة/الأرشفة', 'الأرشفة والاستعادة تعملان والاستعادة تُبقيه موقوفًا',
    archivedList.some((t) => t.id === schoolTenant.id) && restore.payload?.status === 'suspended',
    restore.payload?.status);

  /* ---------- الصيدلية ---------- */

  const pharmaSlug = `audit-pharma-${stamp}`;
  const pharmaCreate = await console_('/api/tenants', {
    method: 'POST',
    body: JSON.stringify({
      display_name: 'صيدلية التدقيق', slug: pharmaSlug, product_id: 'pharmacy',
      environment: 'demo', plan_id: catalog.plans.find((p) => p.product_id === 'pharmacy').id,
      phone: '0599111222',
    }),
  });
  const pharmaTenant = { id: pharmaCreate.payload?.tenant_id, slug: pharmaSlug };
  if (pharmaTenant.id) created.push(pharmaTenant);

  check('صيدلية/إنشاء', 'اللوحة تنشئ صيدلية وتعيد بيانات دخولها',
    pharmaCreate.status === 201 && Boolean(pharmaCreate.payload.credentials?.secret),
    pharmaCreate.payload?.external_tenant_id || pharmaCreate.payload?.error || '');

  const pharmaCreds = pharmaCreate.payload.credentials;
  const pharmaSession = await pharmacyLogin(pharmaCreds);
  check('صيدلية/دخول', 'بيانات اللوحة تفتح الصيدلية', pharmaSession.status === 200);

  const stock = await pharmacyUpdates(pharmaSession.payload.token);
  check('صيدلية/بيانات العرض', 'النسخة التجريبية تصل ببيانات كافية',
    (stock?.products?.length || 0) >= 30 && (stock?.invoices?.length || 0) >= 30,
    `أصناف=${stock?.products?.length || 0} فواتير=${stock?.invoices?.length || 0}`);

  const pharmaRename = await console_(`/api/tenants/${pharmaTenant.id}/customer`, {
    method: 'PATCH', body: JSON.stringify({ display_name: 'صيدلية باسم جديد' }),
  });
  const renamedStock = await pharmacyUpdates((await pharmacyLogin(pharmaCreds, 'audit-2')).payload.token);
  check('صيدلية/الهوية', 'تغيير الاسم من اللوحة يصل إلى الصيدلية',
    pharmaRename.payload?.engine_synced === true && renamedStock?.settings?.name === 'صيدلية باسم جديد',
    renamedStock?.settings?.name);

  const pharmaCreds2 = (await console_(`/api/tenants/${pharmaTenant.id}/reset-pin`, { method: 'POST', body: '{}' }))
    .payload?.credentials;
  check('صيدلية/بيانات جديدة', 'الرقم الجديد يعمل والقديم يبطل',
    (await pharmacyLogin(pharmaCreds, 'audit-3')).status === 401
    && (await pharmacyLogin(pharmaCreds2, 'audit-4')).status === 200);

  await console_(`/api/tenants/${pharmaTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'suspend' }),
  });
  check('صيدلية/الإيقاف', 'الإيقاف يمنع الدخول',
    (await pharmacyLogin(pharmaCreds2, 'audit-5')).status === 403);

  await console_(`/api/tenants/${pharmaTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'resume' }),
  });
  check('صيدلية/الاستئناف', 'الاستئناف يعيد الخدمة',
    (await pharmacyLogin(pharmaCreds2, 'audit-6')).status === 200);

  const pharmaHealth = await console_(`/api/tenants/${pharmaTenant.id}/health`, { method: 'POST', body: '{}' });
  check('صيدلية/الصحة', 'فحص الصحة يعيد حالة المحرك',
    pharmaHealth.payload?.status === 'healthy', pharmaHealth.payload?.status);

  /* ---------- المطعم ---------- */

  const restoSlug = `audit-resto-${stamp}`;
  const restoCreate = await console_('/api/tenants', {
    method: 'POST',
    body: JSON.stringify({
      display_name: 'مطعم التدقيق', slug: restoSlug, product_id: 'restaurant',
      environment: 'demo', admin_username: 'audit.owner',
      plan_id: catalog.plans.find((p) => p.id === 'restaurant:full').id,
      phone: '0599333444',
    }),
  });
  const restoTenant = { id: restoCreate.payload?.tenant_id, slug: restoSlug };
  if (restoTenant.id) created.push(restoTenant);

  check('مطعم/إنشاء', 'اللوحة تنشئ مطعمًا وتعيد بيانات دخوله',
    restoCreate.status === 201 && Boolean(restoCreate.payload.credentials?.secret),
    restoCreate.payload?.external_tenant_id || restoCreate.payload?.error || '');

  const restoCreds = restoCreate.payload.credentials;
  const restoPublicSlug = restoCreate.payload.slug || restoSlug;

  const restoSession = await restaurantLogin(restoCreds);
  check('مطعم/دخول', 'بيانات اللوحة تفتح لوحة المطعم', restoSession.status === 200);
  const restoToken = restoSession.payload?.token;

  // الموقع العام هو المنتج هنا، بخلاف الصيدلية والمدرسة. لا يكفي أن يرد
  // المحرك: يجب أن تصل الصفحة نفسها إلى زائر بلا حساب.
  const home = await restaurantPage(restoPublicSlug);
  check('مطعم/الموقع العام', 'رابط المطعم يفتح صفحة مبنيّة على الخادم',
    home.status === 200 && home.html.includes('مطعم التدقيق'),
    `${home.status} / ${home.html.length} حرفًا`);

  const menuPage = await restaurantPage(restoPublicSlug, 'menu/');
  check('مطعم/بيانات العرض', 'النسخة التجريبية تصل بمنيو كامل',
    menuPage.status === 200 && menuPage.html.includes('كباب أضنة')
    && menuPage.html.includes('شاورما لحم'),
    `${(menuPage.html.match(/class="mini-whatsapp/g) || []).length} صنفًا قابلًا للطلب`);

  const restoDash = await restaurantApi(restoToken, '/api/dashboard');
  check('مطعم/لوحة التشغيل', 'بذرة العرض تُظهر أرقامًا لا أصفارًا',
    restoDash.status === 200 && Number(restoDash.payload?.week?.orders) > 0,
    `طلبات الأسبوع=${restoDash.payload?.week?.orders} إيراد=${restoDash.payload?.week?.revenue}`);

  // التسعير على الخادم: أهم فحص في هذا المنتج. نرسل سعرًا كاذبًا ونتأكد
  // أن المحفوظ هو سعر قاعدة البيانات لا ما أرسله المتصفح. الحمولة والرد هنا
  // عقد `site/js/main.js` الحرفي: `items`/`qty` لا `lines`/`quantity`.
  const menuJson = await restaurantApi(restoToken, '/api/content/menu_items');
  const pricedItem = menuJson.payload?.rows?.find((row) => Number(row.is_priced) && Number(row.price_minor) > 0);
  const forgedOrder = await fetch(`${RESTAURANT}/r/${restoPublicSlug}/order/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'تدقيق', phone: '0599000111', fulfillment: 'pickup',
      items: [{ id: pricedItem.id, qty: 2, unit_price_minor: 1, total_minor: 1 }],
    }),
  });
  const forged = await forgedOrder.json().catch(() => null);
  const forgedToken = String(forged?.order_url || '').match(/\/o\/([a-z0-9]+)\//)?.[1] || '';
  const storedOrders = await restaurantApi(restoToken, '/api/orders?limit=5');
  const placed = storedOrders.payload?.orders?.find((order) => forgedToken && order.token === forgedToken);
  check('مطعم/التسعير', 'السعر يُحسب على الخادم ويتجاهل ما يرسله المتصفح',
    forgedOrder.status === 201 && Number(placed?.total_minor) === Number(pricedItem.price_minor) * 2,
    `المحفوظ=${placed?.total_minor} المتوقع=${Number(pricedItem.price_minor) * 2}`);

  // الإيصال يثبت أن resvg والخطوط على R2 يعملان في الإنتاج لا محليًا فقط.
  const receipt = await fetch(`${RESTAURANT}/r/${restoPublicSlug}/o/${forgedToken}/receipt.png`);
  const receiptBytes = new Uint8Array(await receipt.arrayBuffer());
  check('مطعم/الإيصال', 'الإيصال يُرسم صورةً على الخادم بخطوط R2',
    receipt.status === 200 && receiptBytes[0] === 0x89 && receiptBytes.length > 5000,
    `${receipt.status} / ${receiptBytes.length} بايت`);

  const restoRename = await console_(`/api/tenants/${restoTenant.id}/customer`, {
    method: 'PATCH', body: JSON.stringify({ display_name: 'مطعم باسم جديد' }),
  });
  const renamedHome = await restaurantPage(restoPublicSlug);
  check('مطعم/الهوية', 'تغيير الاسم من اللوحة يصل إلى الموقع العام',
    restoRename.payload?.engine_synced === true && renamedHome.html.includes('مطعم باسم جديد'),
    renamedHome.html.includes('مطعم باسم جديد') ? 'وصل' : 'لم يصل');

  // العلامة النصية (tagline) لا تُعرض على الصفحة الرئيسية في التصميم
  // المنسوخ عن أضنة أصلًا — hero_text_ar هو ما يظهر فعلًا هناك.
  const stealName = await restaurantApi(restoToken, '/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name_ar: 'اسم سرقه المطعم', hero_text_ar: 'نص واجهة يملكه المطعم' }),
  });
  const afterSteal = await restaurantPage(restoPublicSlug);
  check('مطعم/ملكية الهوية', 'المطعم لا يستطيع تغيير اسمه ويغيّر نص واجهته',
    stealName.status === 200 && afterSteal.html.includes('مطعم باسم جديد')
    && !afterSteal.html.includes('اسم سرقه المطعم') && afterSteal.html.includes('نص واجهة يملكه المطعم'));

  // النزول للباقة الأساسية: زر الإرسال في main.js يبقى يعمل (يرسل عبر
  // واتساب) لكن بلا حفظ في القاعدة — هذا هو الفرق التجاري الحقيقي، لا رفض
  // الطلب بـ402 الذي كان يكسر الزر لعميل الباقة الأرخص.
  const downgrade = await console_(`/api/tenants/${restoTenant.id}/plan`, {
    method: 'PATCH',
    body: JSON.stringify({ plan_id: catalog.plans.find((p) => p.id === 'restaurant:menu').id }),
  });
  const beforeCount = (await restaurantApi(restoToken, '/api/orders?limit=200')).payload?.orders?.length || 0;
  const notPersisted = await fetch(`${RESTAURANT}/r/${restoPublicSlug}/order/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'تدقيق', phone: '0599000111', fulfillment: 'pickup',
      items: [{ id: pricedItem.id, qty: 1 }],
    }),
  });
  const notPersistedBody = await notPersisted.json().catch(() => null);
  const afterCount = (await restaurantApi(restoToken, '/api/orders?limit=200')).payload?.orders?.length || 0;
  const siteStillUp = await restaurantPage(restoPublicSlug);
  check('مطعم/تغيير الباقة', 'النزول يرسل عبر واتساب بلا حفظ، ويُبقي الموقع يعمل',
    downgrade.payload?.engine_synced === true && notPersisted.status === 201
    && notPersistedBody?.order_url === '' && afterCount === beforeCount && siteStillUp.status === 200,
    `لوحة=${downgrade.status}/${downgrade.payload?.engine_synced} طلب=${notPersisted.status} `
    + `قبل=${beforeCount} بعد=${afterCount} موقع=${siteStillUp.status}`);

  const upgrade = await console_(`/api/tenants/${restoTenant.id}/plan`, {
    method: 'PATCH',
    body: JSON.stringify({ plan_id: catalog.plans.find((p) => p.id === 'restaurant:full').id }),
  });
  const ordersAfterUpgrade = await restaurantApi(
    (await restaurantLogin(restoCreds, 'audit-up')).payload?.token, '/api/orders?limit=50',
  );
  check('مطعم/الترقية', 'الترقية تعيد الميزة بلا فقد طلب واحد',
    upgrade.payload?.engine_synced === true && (ordersAfterUpgrade.payload?.orders?.length || 0) > 10,
    `لوحة=${upgrade.status}/${upgrade.payload?.engine_synced} طلبات=${ordersAfterUpgrade.payload?.orders?.length}`);

  const restoCreds2 = (await console_(`/api/tenants/${restoTenant.id}/reset-pin`, { method: 'POST', body: '{}' }))
    .payload?.credentials;
  check('مطعم/بيانات جديدة', 'الإصدار الجديد يعمل والقديم يبطل',
    (await restaurantLogin(restoCreds, 'audit-r3')).status === 401
    && (await restaurantLogin(restoCreds2, 'audit-r4')).status === 200);

  await console_(`/api/tenants/${restoTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'suspend' }),
  });
  const suspendedSite = await restaurantPage(restoPublicSlug);
  check('مطعم/الإيقاف', 'الإيقاف يغلق الموقع العام ويمنع الدخول',
    suspendedSite.status === 404 && (await restaurantLogin(restoCreds2, 'audit-r5')).status === 403,
    `موقع=${suspendedSite.status}`);

  await console_(`/api/tenants/${restoTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'resume' }),
  });
  check('مطعم/الاستئناف', 'الاستئناف يعيد الموقع والدخول',
    (await restaurantPage(restoPublicSlug)).status === 200
    && (await restaurantLogin(restoCreds2, 'audit-r6')).status === 200);

  const restoHealth = await console_(`/api/tenants/${restoTenant.id}/health`, { method: 'POST', body: '{}' });
  check('مطعم/الصحة', 'فحص الصحة يسأل المحرك ويعيد حالته',
    restoHealth.payload?.status === 'healthy', restoHealth.payload?.status);

  /* ---------- الحذف النهائي ---------- */

  const guardBeforeArchive = await console_(`/api/tenants/${pharmaTenant.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirm_slug: pharmaSlug, export_checksum: 'x' }),
  });
  await console_(`/api/tenants/${pharmaTenant.id}/lifecycle`, {
    method: 'POST', body: JSON.stringify({ action: 'archive' }),
  });
  const guardNoExport = await console_(`/api/tenants/${pharmaTenant.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirm_slug: pharmaSlug, export_checksum: 'deadbeef' }),
  });
  const exported = await console_(`/api/tenants/${pharmaTenant.id}/export`, { method: 'POST', body: '{}' });
  const guardWrongSlug = await console_(`/api/tenants/${pharmaTenant.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirm_slug: 'wrong', export_checksum: exported.payload.checksum }),
  });
  check('حذف/الحراسات', 'قبل الأرشفة 409 · بلا نسخة 428 · بمعرّف خاطئ 422',
    guardBeforeArchive.status === 409 && guardNoExport.status === 428 && guardWrongSlug.status === 422,
    `${guardBeforeArchive.status}/${guardNoExport.status}/${guardWrongSlug.status}`);

  const purged = await console_(`/api/tenants/${pharmaTenant.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirm_slug: pharmaSlug, export_checksum: exported.payload.checksum }),
  });
  const goneFromEngine = (await pharmacyLogin(pharmaCreds2, 'audit-7')).status === 401;
  check('حذف/التنفيذ', 'الحذف يمحو بيانات المحرك فعلًا',
    purged.status === 200 && goneFromEngine);
  if (purged.status === 200) created.splice(created.indexOf(pharmaTenant), 1);

  const audit = (await console_('/api/audit?limit=60')).payload.audit;
  check('تدقيق', 'العمليات الحساسة مسجّلة',
    audit.some((a) => a.action === 'tenant.purged') && audit.some((a) => a.action === 'tenant.provisioned'));
} finally {
  await cleanup();
  const failed = results.filter((r) => !r.passed);
  console.log(`\nالنتيجة: ${results.length - failed.length}/${results.length} فحصًا ناجحًا`);
  if (failed.length) {
    console.log('\nالفاشلة:');
    for (const item of failed) console.log(`  ❌ [${item.area}] ${item.question} — ${item.detail}`);
    process.exitCode = 1;
  } else {
    console.log('linkage-audit-ok');
  }
}
