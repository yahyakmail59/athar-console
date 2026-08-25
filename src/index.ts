import {
  HttpError,
  addDaysIso,
  assertDate,
  assertMinorAmount,
  assertSlug,
  jsonResponse,
  nowIso,
  optionalText,
  readJson,
  requestId,
  requiredText,
  safeJson,
} from './lib';
import {
  ProductAdapterError,
  callProductAdapter,
  hasAdapter,
  type HealthResult,
  type LifecycleResult,
  type ProvisionResult,
} from './adapter';
import { backupTargets, runBackup } from './backup';

const SESSION_HOURS = 12;
const PBKDF2_ROUNDS = 100_000;
const LOGIN_LOCK_STEPS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
const encoder = new TextEncoder();

type Session = {
  expires: number;
  csrf: string;
  nonce: string;
};

type CatalogPlan = {
  id: string;
  product_id: string;
  code: string;
  name_ar: string;
  description_ar: string;
  default_price_minor: number;
  currency: string;
  billing_cycle: string;
  features_json: string;
  is_active: number;
};

type TenantRow = {
  id: string;
  customer_id: string;
  product_id: string;
  plan_id: string;
  status: string;
  environment: string;
  display_name: string;
  slug: string;
  subscription_id: string;
  subscription_status: string;
  price_minor: number;
  currency: string;
  billing_cycle: string;
  current_period_end: string | null;
};

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new HttpError(500, 'AUTH_NOT_CONFIGURED', 'إعداد الدخول غير صالح.');
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    result[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return result;
}

function randomHex(length = 16): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(length)));
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

async function derivePassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ROUNDS,
    },
    key,
    256,
  );
  return bytesToHex(bits);
}

async function createSession(secret: string): Promise<{ cookie: string; session: Session }> {
  const session: Session = {
    expires: Date.now() + SESSION_HOURS * 60 * 60 * 1000,
    csrf: randomHex(),
    nonce: randomHex(),
  };
  const payload = `${session.expires}.${session.csrf}.${session.nonce}`;
  const signature = await sign(payload, secret);
  return { cookie: `${payload}.${signature}`, session };
}

async function validateSession(cookie: string, secret: string): Promise<Session | null> {
  const [expiresRaw, csrf, nonce, signature, extra] = cookie.split('.');
  if (extra || !expiresRaw || !csrf || !nonce || !signature) return null;
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return null;
  const expected = await sign(`${expires}.${csrf}.${nonce}`, secret);
  if (!safeEqual(signature, expected)) return null;
  return { expires, csrf, nonce };
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `athar_session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function attemptKey(request: Request): Promise<string> {
  return sha256(`admin|${clientIp(request)}`);
}

async function checkLoginLock(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare('SELECT locked_until FROM auth_attempts WHERE key = ?').bind(key).first<{ locked_until: number }>();
  return row && row.locked_until > Date.now() ? row.locked_until : 0;
}

async function recordLoginFailure(db: D1Database, key: string): Promise<void> {
  const current = await db.prepare('SELECT failures FROM auth_attempts WHERE key = ?').bind(key).first<{ failures: number }>();
  const failures = (current?.failures || 0) + 1;
  const lockIndex = Math.min(Math.max(failures - 5, 0), LOGIN_LOCK_STEPS_MS.length - 1);
  const lockedUntil = failures >= 5 ? Date.now() + LOGIN_LOCK_STEPS_MS[lockIndex]! : 0;
  await db.prepare(
    `INSERT INTO auth_attempts (key, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
       locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
  ).bind(key, failures, lockedUntil, Date.now()).run();
}

async function clearLoginFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(key).run();
}

function requireSecrets(env: Env): { passwordHash: string; sessionSecret: string } {
  const passwordHash = String(env.ADMIN_PASSWORD_HASH || '');
  const sessionSecret = String(env.SESSION_SECRET || '');
  if (!passwordHash.includes(':') || sessionSecret.length < 24) {
    throw new HttpError(500, 'AUTH_NOT_CONFIGURED', 'لوحة أثر غير مهيأة للدخول بعد.');
  }
  return { passwordHash, sessionSecret };
}

async function authenticate(request: Request, env: Env): Promise<Session> {
  const { sessionSecret } = requireSecrets(env);
  const session = await validateSession(readCookie(request, 'athar_session'), sessionSecret);
  if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'انتهت الجلسة. سجّل الدخول مجددًا.');
  return session;
}

function requireCsrf(request: Request, session: Session): void {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'ORIGIN_MISMATCH', 'مصدر الطلب غير مسموح.');
  }
  const provided = request.headers.get('X-CSRF-Token') || '';
  if (!safeEqual(provided, session.csrf)) {
    throw new HttpError(403, 'CSRF_FAILED', 'انتهت صلاحية نموذج الحماية. حدّث الصفحة.');
  }
}

function auditStatement(
  env: Env,
  request: Request,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  id: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs
     (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json,
      ip_hash, request_id, created_at)
     VALUES (?, 'admin', 'platform-owner', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    action,
    entityType,
    entityId,
    safeJson(before),
    safeJson(after),
    id,
    requestId(request),
    nowIso(),
  );
}

async function loadCatalog(env: Env): Promise<{ products: unknown[]; plans: CatalogPlan[]; brandKits: unknown[] }> {
  const [productResult, planResult, brandResult] = await Promise.all([
    env.DB.prepare('SELECT * FROM products ORDER BY code').all(),
    env.DB.prepare('SELECT * FROM plans ORDER BY product_id, code').all<CatalogPlan>(),
    env.DB.prepare('SELECT id, product_id, code, name, is_template FROM brand_kits ORDER BY product_id, name').all(),
  ]);
  return {
    products: productResult.results || [],
    plans: planResult.results || [],
    brandKits: brandResult.results || [],
  };
}

async function dashboard(env: Env): Promise<Response> {
  const [catalog, tenantResult, metrics, auditResult] = await Promise.all([
    loadCatalog(env),
    env.DB.prepare(
      `SELECT
         t.id, t.customer_id, t.product_id, t.external_tenant_id, t.slug, t.display_name,
         t.environment, t.status, t.plan_id, t.public_url, t.admin_url, t.trial_expires_at, t.short_name,
         t.last_health_status, t.last_health_at, t.created_at, t.updated_at,
         c.contact_name, c.phone, c.email, c.notes,
         p.name_ar AS product_name,
         pl.name_ar AS plan_name,
         s.id AS subscription_id, s.status AS subscription_status, s.price_minor,
         s.currency, s.billing_cycle, s.current_period_end, s.grace_ends_at,
         (SELECT MAX(sp.paid_at) FROM subscription_payments sp WHERE sp.subscription_id = s.id) AS last_paid_at
       FROM tenants t
       JOIN customers c ON c.id = t.customer_id
       JOIN products p ON p.id = t.product_id
       JOIN plans pl ON pl.id = t.plan_id
       JOIN subscriptions s ON s.tenant_id = t.id
       WHERE t.status <> 'archived'
       ORDER BY t.created_at DESC`,
    ).all(),
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN t.status = 'draft' THEN 1 ELSE 0 END) AS draft,
         SUM(CASE WHEN t.environment = 'demo' AND t.status <> 'archived' THEN 1 ELSE 0 END) AS demos,
         SUM(CASE WHEN s.status IN ('past_due', 'grace') THEN 1 ELSE 0 END) AS due,
         SUM(CASE
               WHEN t.status = 'active' AND s.status = 'active' AND s.billing_cycle = 'monthly' THEN s.price_minor
               WHEN t.status = 'active' AND s.status = 'active' AND s.billing_cycle = 'yearly' THEN CAST(s.price_minor / 12 AS INTEGER)
               ELSE 0
             END) AS monthly_minor
       FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id
       WHERE t.status <> 'archived'`,
    ).first(),
    env.DB.prepare(
      `SELECT id, action, entity_type, entity_id, after_json, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT 12`,
    ).all(),
  ]);

  return jsonResponse({
    today: new Date().toISOString().slice(0, 10),
    catalog,
    tenants: tenantResult.results || [],
    metrics: metrics || { total: 0, active: 0, draft: 0, demos: 0, due: 0, monthly_minor: 0 },
    recentAudit: auditResult.results || [],
  });
}

async function createTenant(request: Request, env: Env, ipHash: string): Promise<Response> {
  const body = await readJson(request);
  const displayName = requiredText(body.display_name, 'اسم العميل', 160);
  const slug = assertSlug(body.slug);
  const productId = requiredText(body.product_id, 'المنتج', 40);
  const planId = requiredText(body.plan_id, 'الباقة', 80);
  const environment = body.environment === 'demo' ? 'demo' : body.environment === 'production' ? 'production' : null;
  if (!environment) throw new HttpError(422, 'INVALID_ENVIRONMENT', 'نوع النسخة غير صالح.');

  const plan = await env.DB.prepare(
    `SELECT id, product_id, code, default_price_minor, currency, billing_cycle
     FROM plans WHERE id = ? AND product_id = ? AND is_active = 1`,
  ).bind(planId, productId).first<CatalogPlan>();
  if (!plan) throw new HttpError(422, 'INVALID_PLAN', 'الباقة لا تتبع المنتج المحدد أو أنها غير مفعلة.');

  const duplicate = await env.DB.prepare(
    'SELECT id FROM tenants WHERE product_id = ? AND slug = ?',
  ).bind(productId, slug).first();
  if (duplicate) throw new HttpError(409, 'SLUG_EXISTS', 'هذا المعرّف مستخدم في المنتج المحدد.');

  const brandKitId = optionalText(body.brand_kit_id, 'الهوية', 100) || null;
  if (brandKitId) {
    const kit = await env.DB.prepare(
      'SELECT id FROM brand_kits WHERE id = ? AND product_id = ?',
    ).bind(brandKitId, productId).first();
    if (!kit) throw new HttpError(422, 'INVALID_BRAND_KIT', 'حزمة الهوية لا تتبع المنتج المحدد.');
  }

  const trialExpiresAt = environment === 'demo'
    ? assertDate(body.trial_expires_at || addDaysIso(14), 'انتهاء التجربة', false)
    : null;
  const customerId = crypto.randomUUID();
  const tenantId = crypto.randomUUID();
  const subscriptionId = crypto.randomUUID();
  const provisioningId = crypto.randomUUID();
  const createdAt = nowIso();
  const priceMinor = body.price_minor === undefined
    ? Number(plan.default_price_minor)
    : assertMinorAmount(body.price_minor, true);
  const currency = optionalText(body.currency || plan.currency, 'العملة', 8).toUpperCase();
  const phone = optionalText(body.phone, 'الهاتف', 40);
  const email = optionalText(body.email, 'البريد', 160).toLowerCase();
  const address = optionalText(body.address, 'العنوان', 300);
  const notes = optionalText(body.notes, 'الملاحظات', 1000);
  const adminUsername = optionalText(body.admin_username, 'اسم مستخدم المدير', 40).toLowerCase();
  const schoolLogoDataUrl = productId === 'school'
    ? optionalText(body.school_logo_data_url, 'شعار المدرسة', 42000)
    : '';
  if (schoolLogoDataUrl && !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(schoolLogoDataUrl)) {
    throw new HttpError(422, 'INVALID_SCHOOL_LOGO', 'بيانات شعار المدرسة غير صالحة.');
  }
  if (adminUsername && !/^[a-z0-9._-]{3,40}$/.test(adminUsername)) {
    throw new HttpError(422, 'INVALID_ADMIN_USERNAME',
      'اسم المستخدم: حروف إنجليزية صغيرة وأرقام ونقطة وشرطة، من 3 إلى 40.');
  }
  const shouldProvision = hasAdapter(productId);
  const initialStatus = shouldProvision ? 'provisioning' : 'draft';
  const provisionPayload = {
    request_id: provisioningId,
    tenant_id: tenantId,
    slug,
    display_name: displayName,
    environment,
    plan_code: plan.code,
    brand_kit_code: brandKitId || '',
    trial_expires_at: trialExpiresAt,
    // اسم مستخدم المدير اختياري: المحرك يضع افتراضه حين يُترك فارغًا.
    admin_username: adminUsername,
    config: { phone, address, currency: 'ILS', logo_data_url: schoolLogoDataUrl },
  };
  const tenantAfter = { tenantId, displayName, slug, productId, planId, environment, status: initialStatus };

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO customers
       (id, display_name, contact_name, phone, email, address, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'customer', ?, ?)`,
    ).bind(customerId, displayName, displayName, phone, email, address, notes, createdAt, createdAt),
    env.DB.prepare(
      `INSERT INTO tenants
       (id, customer_id, product_id, slug, display_name, environment, status, plan_id,
        brand_kit_id, trial_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      tenantId, customerId, productId, slug, displayName, environment, initialStatus, planId,
      brandKitId, trialExpiresAt, createdAt, createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO subscriptions
       (id, tenant_id, plan_id, status, price_minor, currency, billing_cycle, starts_at,
        current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      subscriptionId, tenantId, planId, environment === 'demo' ? 'trialing' : 'active',
      priceMinor, currency, plan.billing_cycle, createdAt, createdAt, trialExpiresAt,
      createdAt, createdAt,
    ),
    auditStatement(env, request, 'tenant.register', 'tenant', tenantId, {}, tenantAfter, ipHash),
  ];
  if (shouldProvision) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO provisioning_jobs
         (id, tenant_id, action, status, idempotency_key, request_json, result_json, attempts,
          max_attempts, started_at, created_at, updated_at)
         VALUES (?, ?, 'create', 'running', ?, ?, '{}', 1, 3, ?, ?, ?)`,
      ).bind(provisioningId, tenantId, provisioningId, safeJson(provisionPayload), createdAt, createdAt, createdAt),
    );
  }
  await env.DB.batch(statements);

  if (!shouldProvision) return jsonResponse({ ok: true, tenant_id: tenantId, status: 'draft' }, 201);

  try {
    const result = await callProductAdapter<ProvisionResult>(env, productId, {
      method: 'POST', path: '/internal/v1/tenants', requestId: provisioningId, body: provisionPayload,
    });
    const finishedAt = nowIso();
    const safeResult = {
      request_id: result.request_id,
      external_tenant_id: result.external_tenant_id,
      status: result.status,
      environment: result.environment,
      public_url: result.public_url,
    };
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE tenants SET external_tenant_id = ?, status = 'active', public_url = ?,
         last_health_status = 'healthy', last_health_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(result.external_tenant_id, result.public_url, finishedAt, finishedAt, tenantId),
      env.DB.prepare(
        `UPDATE provisioning_jobs SET status = 'succeeded', result_json = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(safeJson(safeResult), finishedAt, finishedAt, provisioningId),
      auditStatement(env, request, 'tenant.provisioned', 'tenant', tenantId,
        { status: 'provisioning' }, { ...safeResult, tenant_status: 'active' }, ipHash),
    ]);
    return jsonResponse({
      ok: true,
      tenant_id: tenantId,
      status: 'active',
      external_tenant_id: result.external_tenant_id,
      public_url: result.public_url,
      credentials: result.credentials,
    }, 201);
  } catch (error) {
    const code = error instanceof ProductAdapterError ? error.code : 'PROVISIONING_FAILED';
    const message = error instanceof ProductAdapterError ? error.message : 'فشل إنشاء الصيدلية في محرك المنتج.';
    const finishedAt = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE tenants SET status = 'failed', last_health_status = 'unreachable', updated_at = ? WHERE id = ?")
        .bind(finishedAt, tenantId),
      env.DB.prepare(
        `UPDATE provisioning_jobs SET status = 'failed', last_error_code = ?, last_error_message = ?,
         finished_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(code.slice(0, 80), message.slice(0, 240), finishedAt, finishedAt, provisioningId),
      auditStatement(env, request, 'tenant.provision_failed', 'tenant', tenantId,
        { status: 'provisioning' }, { status: 'failed', error_code: code }, ipHash),
    ]);
    return jsonResponse({
      ok: true,
      provisioning_ok: false,
      tenant_id: tenantId,
      status: 'failed',
      error: message,
      code,
    }, 201);
  }
}

async function retryProvision(request: Request, env: Env, tenantId: string, ipHash: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT t.id, t.product_id, t.status, j.id AS job_id, j.request_json, j.attempts, j.max_attempts
     FROM tenants t
     JOIN provisioning_jobs j ON j.id = (
       SELECT id FROM provisioning_jobs
       WHERE tenant_id = t.id AND action = 'create'
       ORDER BY created_at DESC LIMIT 1
     )
     WHERE t.id = ?`,
  ).bind(tenantId).first<{
    id: string;
    product_id: string;
    status: string;
    job_id: string;
    request_json: string;
    attempts: number;
    max_attempts: number;
  }>();
  if (!row) throw new HttpError(404, 'PROVISION_JOB_NOT_FOUND', 'لا توجد عملية إنشاء لهذا العميل.');
  if (!hasAdapter(row.product_id)) throw new HttpError(422, 'ADAPTER_NOT_AVAILABLE', 'هذا المنتج غير مربوط بمحرك تلقائي بعد.');
  if (row.status !== 'failed' && row.status !== 'provisioning') {
    throw new HttpError(409, 'INVALID_TRANSITION', 'يمكن إعادة محاولة العمليات الفاشلة فقط.');
  }
  if (Number(row.attempts) >= Number(row.max_attempts)) {
    throw new HttpError(409, 'MAX_ATTEMPTS_REACHED', 'وصلت العملية إلى الحد الأقصى للمحاولات. راجع الإعدادات قبل المحاولة مجددًا.');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.request_json) as Record<string, unknown>;
  } catch {
    throw new HttpError(500, 'INVALID_JOB_DATA', 'بيانات عملية الإنشاء المحفوظة غير صالحة.');
  }
  const adapterRequestId = requiredText(payload.request_id, 'معرّف العملية', 80);
  const startedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET status = 'provisioning', updated_at = ? WHERE id = ?")
      .bind(startedAt, tenantId),
    env.DB.prepare(
      `UPDATE provisioning_jobs SET status = 'running', attempts = attempts + 1,
       last_error_code = '', last_error_message = '', started_at = ?, finished_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).bind(startedAt, startedAt, row.job_id),
  ]);

  try {
    const result = await callProductAdapter<ProvisionResult>(env, row.product_id, {
      method: 'POST', path: '/internal/v1/tenants', requestId: adapterRequestId, body: payload,
    });
    const finishedAt = nowIso();
    const safeResult = {
      request_id: result.request_id,
      external_tenant_id: result.external_tenant_id,
      status: result.status,
      environment: result.environment,
      public_url: result.public_url,
    };
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE tenants SET external_tenant_id = ?, status = 'active', public_url = ?,
         last_health_status = 'healthy', last_health_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(result.external_tenant_id, result.public_url, finishedAt, finishedAt, tenantId),
      env.DB.prepare(
        `UPDATE provisioning_jobs SET status = 'succeeded', result_json = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(safeJson(safeResult), finishedAt, finishedAt, row.job_id),
      auditStatement(env, request, 'tenant.provision_retried', 'tenant', tenantId,
        { status: row.status }, { ...safeResult, tenant_status: 'active' }, ipHash),
    ]);
    return jsonResponse({
      ok: true,
      tenant_id: tenantId,
      status: 'active',
      external_tenant_id: result.external_tenant_id,
      public_url: result.public_url,
      credentials: result.credentials,
    });
  } catch (error) {
    const code = error instanceof ProductAdapterError ? error.code : 'PROVISIONING_FAILED';
    const message = error instanceof ProductAdapterError ? error.message : 'فشلت إعادة محاولة إنشاء الصيدلية.';
    const finishedAt = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE tenants SET status = 'failed', last_health_status = 'unreachable', updated_at = ? WHERE id = ?")
        .bind(finishedAt, tenantId),
      env.DB.prepare(
        `UPDATE provisioning_jobs SET status = 'failed', last_error_code = ?, last_error_message = ?,
         finished_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(code.slice(0, 80), message.slice(0, 240), finishedAt, finishedAt, row.job_id),
      auditStatement(env, request, 'tenant.provision_retry_failed', 'tenant', tenantId,
        { status: 'provisioning' }, { status: 'failed', error_code: code }, ipHash),
    ]);
    throw new HttpError(502, code, message);
  }
}

async function changePlan(request: Request, env: Env, tenantId: string, ipHash: string): Promise<Response> {
  const body = await readJson(request);
  const planId = requiredText(body.plan_id, 'الباقة', 80);
  const tenant = await env.DB.prepare(
    `SELECT t.id, t.product_id, t.plan_id, s.id AS subscription_id,
            s.price_minor, s.currency, s.billing_cycle, s.status AS subscription_status
     FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = ?`,
  ).bind(tenantId).first<TenantRow>();
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');
  const plan = await env.DB.prepare(
    `SELECT id, product_id, code, default_price_minor, currency, billing_cycle
     FROM plans WHERE id = ? AND product_id = ? AND is_active = 1`,
  ).bind(planId, tenant.product_id).first<CatalogPlan>();
  if (!plan) throw new HttpError(422, 'INVALID_PLAN', 'الباقة لا تتبع هذا المنتج أو أنها غير مفعلة.');
  const tenantRow = await env.DB.prepare('SELECT external_tenant_id FROM tenants WHERE id = ?')
    .bind(tenantId).first<{ external_tenant_id: string }>();

  const preservePrice = body.preserve_price === true;
  const priceMinor = preservePrice ? tenant.price_minor : Number(plan.default_price_minor);
  const updatedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE tenants SET plan_id = ?, updated_at = ? WHERE id = ?')
      .bind(planId, updatedAt, tenantId),
    env.DB.prepare(
      `UPDATE subscriptions SET plan_id = ?, price_minor = ?, currency = ?, billing_cycle = ?, updated_at = ?
       WHERE tenant_id = ?`,
    ).bind(planId, priceMinor, plan.currency, plan.billing_cycle, updatedAt, tenantId),
    auditStatement(
      env, request, 'tenant.plan_changed', 'tenant', tenantId,
      { plan_id: tenant.plan_id, price_minor: tenant.price_minor },
      { plan_id: planId, price_minor: priceMinor, preserve_price: preservePrice },
      ipHash,
    ),
  ]);

  // الباقة قرار تجاري يُفرض داخل المحرك. حفظها في اللوحة وحدها يترك العميل
  // على صلاحياته القديمة: يدفع للكاملة ويرى الأساسية، أو العكس.
  let engineSynced: boolean | undefined;
  if (hasAdapter(tenant.product_id) && String(tenantRow?.external_tenant_id || '')) {
    const planRequestId = crypto.randomUUID();
    try {
      await callProductAdapter(env, tenant.product_id, {
        method: 'POST',
        path: `/internal/v1/tenants/${encodeURIComponent(tenantId)}/plan`,
        requestId: planRequestId,
        body: { request_id: planRequestId, tenant_id: tenantId, plan_code: plan.code },
      });
      engineSynced = true;
    } catch (error) {
      engineSynced = false;
      console.error(JSON.stringify({
        level: 'error',
        event: 'plan_sync_failed',
        tenant_id: tenantId,
        code: error instanceof ProductAdapterError ? error.code : 'UNKNOWN',
      }));
    }
  }
  return jsonResponse({ ok: true, engine_synced: engineSynced });
}

async function lifecycle(request: Request, env: Env, tenantId: string, ipHash: string): Promise<Response> {
  const body = await readJson(request);
  const action = String(body.action || '');
  const tenant = await env.DB.prepare(
    `SELECT t.*, s.status AS subscription_status
     FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = ?`,
  ).bind(tenantId).first<Record<string, unknown>>();
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');

  const current = String(tenant.status);
  let nextStatus: string;
  let subscriptionStatus = String(tenant.subscription_status);
  if (action === 'archive') {
    if (current === 'purging') throw new HttpError(409, 'INVALID_TRANSITION', 'لا يمكن أرشفة سجل قيد الحذف.');
    if (current === 'archived') throw new HttpError(409, 'INVALID_TRANSITION', 'العميل مؤرشف بالفعل.');
    nextStatus = 'archived';
    subscriptionStatus = 'cancelled';
  } else if (action === 'suspend') {
    if (current !== 'active') throw new HttpError(409, 'INVALID_TRANSITION', 'يمكن إيقاف العميل النشط فقط.');
    nextStatus = 'suspended';
    subscriptionStatus = 'suspended';
  } else if (action === 'resume') {
    if (current !== 'suspended') throw new HttpError(409, 'INVALID_TRANSITION', 'يمكن استئناف العميل الموقوف فقط.');
    nextStatus = 'active';
    subscriptionStatus = 'active';
  } else if (action === 'restore') {
    // الاستعادة تُخرج العميل من الأرشيف وتبقيه موقوفًا حتى قرار استئناف صريح.
    if (current !== 'archived') throw new HttpError(409, 'INVALID_TRANSITION', 'يمكن استعادة العملاء المؤرشفين فقط.');
    nextStatus = 'suspended';
    subscriptionStatus = 'suspended';
  } else {
    throw new HttpError(422, 'INVALID_ACTION', 'الإجراء غير معروف.');
  }

  const updatedAt = nowIso();
  const adapterJobId = hasAdapter(String(tenant.product_id)) && String(tenant.external_tenant_id || '')
    ? crypto.randomUUID()
    : null;
  let adapterResult: LifecycleResult | null = null;
  let detachedFromEngine = false;
  if (adapterJobId) {
    const adapterBody = { request_id: adapterJobId, tenant_id: tenantId, action };
    await env.DB.prepare(
      `INSERT INTO provisioning_jobs
       (id, tenant_id, action, status, idempotency_key, request_json, result_json, attempts,
        max_attempts, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, '{}', 1, 3, ?, ?, ?)`,
    ).bind(adapterJobId, tenantId, action, adapterJobId, safeJson(adapterBody), updatedAt, updatedAt, updatedAt).run();
    try {
      adapterResult = await callProductAdapter<LifecycleResult>(env, String(tenant.product_id), {
        method: 'POST',
        path: `/internal/v1/tenants/${encodeURIComponent(tenantId)}/status`,
        requestId: adapterJobId,
        body: adapterBody,
      });
    } catch (error) {
      const code = error instanceof ProductAdapterError ? error.code : 'LIFECYCLE_FAILED';
      const message = error instanceof ProductAdapterError ? error.message : 'فشل تحديث حالة الصيدلية في محرك المنتج.';
      // المحرك لا يعرف هذا المستأجر: حُذف من خارج أثر أو لم يكتمل إنشاؤه.
      // إيقافه أو أرشفته لا معنى لهما هناك، والتمسك بالفشل يترك السجل عالقًا
      // في اللوحة بلا مخرج. نكمل تغيير الحالة تجاريًا ونسجّل الانفصال.
      if (code === 'TENANT_NOT_FOUND' && (action === 'archive' || action === 'suspend')) {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE provisioning_jobs SET status = 'succeeded', last_error_code = ?,
             last_error_message = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
          ).bind(code, 'المستأجر غير موجود في المحرك؛ نُفذت العملية في السجل التجاري فقط.',
            updatedAt, updatedAt, adapterJobId),
          auditStatement(env, request, 'tenant.engine_missing', 'tenant', tenantId,
            { status: current },
            { action, external_tenant_id: tenant.external_tenant_id, note: 'engine tenant not found' },
            ipHash),
        ]);
        detachedFromEngine = true;
      } else {
        await env.DB.prepare(
          `UPDATE provisioning_jobs SET status = 'failed', last_error_code = ?, last_error_message = ?,
           finished_at = ?, updated_at = ? WHERE id = ?`,
        ).bind(code.slice(0, 80), message.slice(0, 240), updatedAt, updatedAt, adapterJobId).run();
        throw new HttpError(502, code, message);
      }
    }
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE tenants SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE NULL END,
       updated_at = ? WHERE id = ?`,
    ).bind(nextStatus, nextStatus, updatedAt, updatedAt, tenantId),
    env.DB.prepare('UPDATE subscriptions SET status = ?, updated_at = ? WHERE tenant_id = ?')
      .bind(subscriptionStatus, updatedAt, tenantId),
    auditStatement(
      env, request, `tenant.${action}`, 'tenant', tenantId,
      { status: current, subscription_status: tenant.subscription_status },
      { status: nextStatus, subscription_status: subscriptionStatus },
      ipHash,
    ),
  ];
  if (adapterJobId && adapterResult) {
    statements.push(
      env.DB.prepare(
        `UPDATE provisioning_jobs SET status = 'succeeded', result_json = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(safeJson(adapterResult), updatedAt, updatedAt, adapterJobId),
    );
  }
  if (detachedFromEngine) {
    // الرابط وحالة الصحة لم تعودا صحيحتين بعد اختفاء المستأجر من المحرك.
    statements.push(
      env.DB.prepare(
        `UPDATE tenants SET last_health_status = 'unreachable', last_health_at = ?, public_url = ''
         WHERE id = ?`,
      ).bind(updatedAt, tenantId),
    );
  }
  await env.DB.batch(statements);
  return jsonResponse({
    ok: true,
    status: nextStatus,
    engine_missing: detachedFromEngine || undefined,
  });
}

async function recordPayment(request: Request, env: Env, ipHash: string): Promise<Response> {
  const body = await readJson(request);
  const tenantId = requiredText(body.tenant_id, 'العميل', 80);
  const amountMinor = assertMinorAmount(body.amount_minor);
  const paidAt = assertDate(body.paid_at || new Date().toISOString().slice(0, 10), 'تاريخ الدفع', false);
  const periodEnd = assertDate(body.current_period_end, 'مدفوع حتى', true);
  const method = String(body.method || 'cash');
  if (!['cash', 'wallet', 'bank_transfer', 'gateway', 'other'].includes(method)) {
    throw new HttpError(422, 'INVALID_METHOD', 'طريقة الدفع غير صالحة.');
  }

  const row = await env.DB.prepare(
    `SELECT t.customer_id, s.id AS subscription_id, s.currency, s.status
     FROM tenants t JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = ?`,
  ).bind(tenantId).first<{ customer_id: string; subscription_id: string; currency: string; status: string }>();
  if (!row) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');
  const paymentId = crypto.randomUUID();
  const createdAt = nowIso();
  const reference = optionalText(body.reference, 'المرجع', 120);
  const notes = optionalText(body.notes, 'الملاحظات', 500);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subscription_payments
       (id, subscription_id, customer_id, amount_minor, currency, paid_at, method,
        reference, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'platform-owner', ?)`,
    ).bind(
      paymentId, row.subscription_id, row.customer_id, amountMinor, row.currency,
      paidAt, method, reference, notes, createdAt,
    ),
    env.DB.prepare(
      `UPDATE subscriptions SET status = 'active',
       current_period_end = COALESCE(?, current_period_end), updated_at = ? WHERE id = ?`,
    ).bind(periodEnd, createdAt, row.subscription_id),
    auditStatement(
      env, request, 'payment.record', 'tenant', tenantId, {},
      { payment_id: paymentId, amount_minor: amountMinor, paid_at: paidAt, current_period_end: periodEnd },
      ipHash,
    ),
  ]);
  return jsonResponse({ ok: true, payment_id: paymentId }, 201);
}

async function paymentHistory(env: Env, tenantId: string): Promise<Response> {
  const tenant = await env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(tenantId).first();
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');
  const result = await env.DB.prepare(
    `SELECT sp.id, sp.amount_minor, sp.currency, sp.paid_at, sp.method, sp.reference, sp.notes, sp.created_at
     FROM subscription_payments sp
     JOIN subscriptions s ON s.id = sp.subscription_id
     WHERE s.tenant_id = ? ORDER BY sp.paid_at DESC, sp.created_at DESC LIMIT 100`,
  ).bind(tenantId).all();
  return jsonResponse({ payments: result.results || [] });
}

async function updateCustomer(request: Request, env: Env, tenantId: string, ipHash: string): Promise<Response> {
  const body = await readJson(request);
  const row = await env.DB.prepare(
    `SELECT c.id, c.display_name, c.contact_name, c.phone, c.email, c.address, c.notes, c.status,
            t.product_id, t.external_tenant_id, t.short_name
     FROM tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = ?`,
  ).bind(tenantId).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');

  const displayName = body.display_name === undefined
    ? String(row.display_name)
    : requiredText(body.display_name, 'اسم العميل', 160);
  const contactName = body.contact_name === undefined
    ? String(row.contact_name)
    : optionalText(body.contact_name, 'اسم المسؤول', 160);
  const phone = body.phone === undefined ? String(row.phone) : optionalText(body.phone, 'الهاتف', 40);
  const email = body.email === undefined
    ? String(row.email)
    : optionalText(body.email, 'البريد', 160).toLowerCase();
  const address = body.address === undefined ? String(row.address) : optionalText(body.address, 'العنوان', 300);
  const notes = body.notes === undefined ? String(row.notes) : optionalText(body.notes, 'الملاحظات', 1000);
  const shortName = body.short_name === undefined
    ? String(row.short_name || '')
    : optionalText(body.short_name, 'الاسم المختصر', 60);
  const status = body.status === undefined ? String(row.status) : String(body.status);
  if (!['lead', 'customer', 'inactive'].includes(status)) {
    throw new HttpError(422, 'INVALID_STATUS', 'حالة العميل غير صالحة.');
  }

  const updatedAt = nowIso();
  const after = { display_name: displayName, contact_name: contactName, phone, email, address, notes, status };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE customers SET display_name = ?, contact_name = ?, phone = ?, email = ?,
       address = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?`,
    ).bind(displayName, contactName, phone, email, address, notes, status, updatedAt, String(row.id)),
    // اسم المساحة يتبع اسم العميل في اللوحة حتى تبقى القوائم متسقة.
    env.DB.prepare('UPDATE tenants SET display_name = ?, short_name = ?, updated_at = ? WHERE id = ?')
      .bind(displayName, shortName, updatedAt, tenantId),
    auditStatement(env, request, 'customer.update', 'customer', String(row.id), row, after, ipHash),
  ]);

  // الهوية تُدفع إلى المحرك: حفظها في اللوحة وحدها يترك العميل يرى اسمه القديم.
  // فشل الدفع لا يُلغي الحفظ التجاري، لكن يجب أن يعرف المشغّل أنه لم يصل.
  let engineSynced: boolean | undefined;
  if (hasAdapter(String(row.product_id)) && String(row.external_tenant_id || '')) {
    const profileRequestId = crypto.randomUUID();
    try {
      await callProductAdapter(env, String(row.product_id), {
        method: 'POST',
        path: `/internal/v1/tenants/${encodeURIComponent(tenantId)}/profile`,
        requestId: profileRequestId,
        // المحوّل يشترط تطابق معرّف الطلب بين الترويسة والجسم. إغفاله هنا
        // كان يعيد 400 يظهر للمشغّل كأن المحرك لا يستجيب.
        body: {
          request_id: profileRequestId,
          tenant_id: tenantId,
          display_name: displayName,
          short_name: shortName || displayName,
        },
      });
      engineSynced = true;
    } catch (error) {
      engineSynced = false;
      console.error(JSON.stringify({
        level: 'error',
        event: 'profile_sync_failed',
        tenant_id: tenantId,
        code: error instanceof ProductAdapterError ? error.code : 'UNKNOWN',
      }));
    }
  }
  return jsonResponse({ ok: true, engine_synced: engineSynced });
}

async function tenantHealth(env: Env, tenantId: string): Promise<Response> {
  const tenant = await env.DB.prepare(
    'SELECT id, product_id, external_tenant_id FROM tenants WHERE id = ?',
  ).bind(tenantId).first<{ id: string; product_id: string; external_tenant_id: string }>();
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');
  if (!hasAdapter(tenant.product_id) || !String(tenant.external_tenant_id || '')) {
    throw new HttpError(422, 'ADAPTER_NOT_AVAILABLE', 'هذا العميل غير مربوط بمحرك يدعم فحص الصحة.');
  }

  const checkedAt = nowIso();
  let status: 'healthy' | 'degraded' | 'unreachable';
  let detail: Record<string, unknown>;
  try {
    const result = await callProductAdapter<HealthResult>(env, tenant.product_id, {
      method: 'GET',
      path: `/internal/v1/tenants/${encodeURIComponent(tenantId)}/health`,
      requestId: crypto.randomUUID(),
    });
    status = result.active ? 'healthy' : 'degraded';
    detail = { engine_status: result.status, active: result.active, environment: result.environment };
  } catch (error) {
    status = 'unreachable';
    detail = { error: error instanceof ProductAdapterError ? error.code : 'HEALTH_FAILED' };
  }
  await env.DB.prepare(
    'UPDATE tenants SET last_health_status = ?, last_health_at = ?, updated_at = ? WHERE id = ?',
  ).bind(status, checkedAt, checkedAt, tenantId).run();
  return jsonResponse({ ok: true, status, checked_at: checkedAt, ...detail });
}

/**
 * رقم سري جديد للمالك عند فقدان القديم. البديل الوحيد لولا ذلك هو حذف الصيدلية
 * وإنشاء غيرها، وهو غير مقبول مع عميل يملك مخزونًا وفواتير.
 */
async function resetOwnerPin(request: Request, env: Env, tenantId: string, ipHash: string): Promise<Response> {
  const tenant = await env.DB.prepare(
    'SELECT id, product_id, status, external_tenant_id, public_url FROM tenants WHERE id = ?',
  ).bind(tenantId).first<{
    id: string;
    product_id: string;
    status: string;
    external_tenant_id: string;
    public_url: string;
  }>();
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');
  if (!hasAdapter(tenant.product_id) || !String(tenant.external_tenant_id || '')) {
    throw new HttpError(422, 'ADAPTER_NOT_AVAILABLE', 'هذا العميل غير مربوط بمحرك يدعم إعادة تعيين الرقم.');
  }
  if (tenant.status === 'archived' || tenant.status === 'purging') {
    throw new HttpError(409, 'INVALID_TRANSITION', 'استعد العميل من الأرشيف قبل إصدار رقم جديد.');
  }

  const jobId = crypto.randomUUID();
  const startedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO provisioning_jobs
     (id, tenant_id, action, status, idempotency_key, request_json, result_json, attempts,
      max_attempts, started_at, created_at, updated_at)
     VALUES (?, ?, 'reset_owner_pin', 'running', ?, ?, '{}', 1, 3, ?, ?, ?)`,
  ).bind(
    jobId, tenantId, jobId, safeJson({ action: 'reset_owner_pin', tenant_id: tenantId }),
    startedAt, startedAt, startedAt,
  ).run();

  try {
    const result = await callProductAdapter<ProvisionResult>(env, tenant.product_id, {
      method: 'POST',
      path: `/internal/v1/tenants/${encodeURIComponent(tenantId)}/reset-owner-credential`,
      requestId: jobId,
      body: { request_id: jobId, tenant_id: tenantId },
    });
    const finishedAt = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE provisioning_jobs SET status = 'succeeded', result_json = ?, finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(safeJson({ status: 'pin_reset', external_tenant_id: result.external_tenant_id }), finishedAt, finishedAt, jobId),
      // التدقيق يسجل الحدث لا الرقم. الرقم يمر إلى المتصفح مرة واحدة فقط.
      auditStatement(env, request, 'tenant.owner_pin_reset', 'tenant', tenantId, {},
        { external_tenant_id: result.external_tenant_id, sessions_revoked: true }, ipHash),
    ]);
    return jsonResponse({
      ok: true,
      tenant_id: tenantId,
      public_url: tenant.public_url,
      credentials: result.credentials,
    });
  } catch (error) {
    const code = error instanceof ProductAdapterError ? error.code : 'PIN_RESET_FAILED';
    const message = error instanceof ProductAdapterError ? error.message : 'تعذر إصدار رقم سري جديد.';
    const finishedAt = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE provisioning_jobs SET status = 'failed', last_error_code = ?, last_error_message = ?,
         finished_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(code.slice(0, 80), message.slice(0, 240), finishedAt, finishedAt, jobId),
      auditStatement(env, request, 'tenant.owner_pin_reset_failed', 'tenant', tenantId, {},
        { error_code: code }, ipHash),
    ]);
    throw new HttpError(502, code, message);
  }
}

async function archivedTenants(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT t.id, t.slug, t.display_name, t.environment, t.external_tenant_id, t.product_id,
            t.archived_at, t.created_at, p.name_ar AS product_name, pl.name_ar AS plan_name,
            c.phone, c.email
     FROM tenants t
     JOIN products p ON p.id = t.product_id
     JOIN plans pl ON pl.id = t.plan_id
     JOIN customers c ON c.id = t.customer_id
     WHERE t.status = 'archived'
     ORDER BY t.archived_at DESC LIMIT 200`,
  ).all();
  return jsonResponse({ archived: result.results || [] });
}

/** لقطة كاملة للسجل التجاري للعميل. لا تحتوي بيانات تشغيل المنتج. */
async function buildTenantExport(env: Env, tenantId: string): Promise<Record<string, unknown>> {
  const tenant = await env.DB.prepare(
    `SELECT t.*, c.display_name AS customer_display_name, c.contact_name, c.phone, c.email,
            c.address, c.notes, c.status AS customer_status
     FROM tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = ?`,
  ).bind(tenantId).first<Record<string, unknown>>();
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');
  const [subscription, payments, jobs] = await Promise.all([
    env.DB.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').bind(tenantId).first(),
    env.DB.prepare(
      `SELECT sp.* FROM subscription_payments sp JOIN subscriptions s ON s.id = sp.subscription_id
       WHERE s.tenant_id = ? ORDER BY sp.paid_at`,
    ).bind(tenantId).all(),
    env.DB.prepare(
      `SELECT id, action, status, idempotency_key, last_error_code, created_at, finished_at
       FROM provisioning_jobs WHERE tenant_id = ? ORDER BY created_at`,
    ).bind(tenantId).all(),
  ]);
  return {
    format: 'athar-console-tenant-export',
    version: 1,
    exported_at: nowIso(),
    tenant,
    subscription: subscription || null,
    payments: payments.results || [],
    provisioning_jobs: jobs.results || [],
  };
}

/**
 * بصمة النسخة الاحتياطية. تُحسب من المحتوى دون `exported_at` حتى يبقى التوقيع
 * ثابتًا للبيانات نفسها، ويثبت أن المشغّل نزّل نسخة مطابقة للحالة الحالية.
 */
async function exportChecksum(snapshot: Record<string, unknown>): Promise<string> {
  const { exported_at: _ignored, ...stable } = snapshot;
  return sha256(safeJson(stable));
}

async function exportTenant(request: Request, env: Env, tenantId: string, ipHash: string): Promise<Response> {
  const snapshot = await buildTenantExport(env, tenantId);
  const checksum = await exportChecksum(snapshot);
  await env.DB.prepare(
    `INSERT INTO audit_logs
     (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json,
      ip_hash, request_id, created_at)
     VALUES (?, 'admin', 'platform-owner', 'tenant.exported', 'tenant', ?, '{}', ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), tenantId, safeJson({ checksum }), ipHash, requestId(request), nowIso(),
  ).run();
  return jsonResponse({ ...snapshot, checksum });
}

async function purgeTenant(request: Request, env: Env, tenantId: string, ipHash: string): Promise<Response> {
  const body = await readJson(request);
  const tenant = await env.DB.prepare(
    'SELECT id, customer_id, product_id, slug, display_name, status, external_tenant_id FROM tenants WHERE id = ?',
  ).bind(tenantId).first<{
    id: string;
    customer_id: string;
    product_id: string;
    slug: string;
    display_name: string;
    status: string;
    external_tenant_id: string;
  }>();
  if (!tenant) throw new HttpError(404, 'TENANT_NOT_FOUND', 'العميل غير موجود.');
  if (tenant.status !== 'archived') {
    throw new HttpError(409, 'PURGE_REQUIRES_ARCHIVE', 'يجب أرشفة العميل قبل الحذف النهائي.');
  }
  if (String(body.confirm_slug || '') !== tenant.slug) {
    throw new HttpError(422, 'CONFIRMATION_MISMATCH', 'اكتب معرّف العميل كما هو لتأكيد الحذف.');
  }
  const snapshot = await buildTenantExport(env, tenantId);
  const checksum = await exportChecksum(snapshot);
  if (!safeEqual(String(body.export_checksum || ''), checksum)) {
    throw new HttpError(428, 'EXPORT_REQUIRED', 'نزّل نسخة احتياطية محدثة قبل الحذف النهائي.');
  }

  const purgingAt = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET status = 'purging', updated_at = ? WHERE id = ?").bind(purgingAt, tenantId),
    auditStatement(env, request, 'tenant.purge_started', 'tenant', tenantId,
      { status: 'archived' }, { status: 'purging', checksum }, ipHash),
  ]);

  // حذف بيانات المنتج أولًا. لو فشل المحرك يبقى السجل في `purging` ولا تُفقد اللقطة.
  if (hasAdapter(tenant.product_id) && String(tenant.external_tenant_id || '')) {
    try {
      await callProductAdapter<LifecycleResult>(env, tenant.product_id, {
        method: 'DELETE',
        path: `/internal/v1/tenants/${encodeURIComponent(tenantId)}`,
        requestId: crypto.randomUUID(),
      });
    } catch (error) {
      const code = error instanceof ProductAdapterError ? error.code : 'PURGE_FAILED';
      const message = error instanceof ProductAdapterError ? error.message : 'تعذر حذف بيانات المنتج.';
      await env.DB.batch([
        env.DB.prepare("UPDATE tenants SET status = 'archived', updated_at = ? WHERE id = ?")
          .bind(nowIso(), tenantId),
        auditStatement(env, request, 'tenant.purge_failed', 'tenant', tenantId,
          { status: 'purging' }, { status: 'archived', error_code: code }, ipHash),
      ]);
      throw new HttpError(502, code, message);
    }
  }

  const otherTenants = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM tenants WHERE customer_id = ? AND id <> ?',
  ).bind(tenant.customer_id, tenantId).first<{ count: number }>();
  const finishedAt = nowIso();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `DELETE FROM subscription_payments WHERE subscription_id IN
       (SELECT id FROM subscriptions WHERE tenant_id = ?)`,
    ).bind(tenantId),
    env.DB.prepare('DELETE FROM subscriptions WHERE tenant_id = ?').bind(tenantId),
    env.DB.prepare('DELETE FROM provisioning_jobs WHERE tenant_id = ?').bind(tenantId),
    env.DB.prepare('DELETE FROM domains WHERE tenant_id = ?').bind(tenantId),
    env.DB.prepare('DELETE FROM tenants WHERE id = ?').bind(tenantId),
  ];
  if (Number(otherTenants?.count || 0) === 0) {
    statements.push(env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(tenant.customer_id));
  }
  // سجل تدقيق مختصر يبقى بعد الحذف: من ومتى وماذا، دون بيانات تشغيل.
  statements.push(
    auditStatement(env, request, 'tenant.purged', 'tenant', tenantId, {},
      {
        slug: tenant.slug,
        display_name: tenant.display_name,
        product_id: tenant.product_id,
        external_tenant_id: tenant.external_tenant_id,
        checksum,
        purged_at: finishedAt,
      }, ipHash),
  );
  await env.DB.batch(statements);
  return jsonResponse({ ok: true, purged_at: finishedAt });
}

async function updatePlan(request: Request, env: Env, planId: string, ipHash: string): Promise<Response> {
  const body = await readJson(request);
  const current = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first<Record<string, unknown>>();
  if (!current) throw new HttpError(404, 'PLAN_NOT_FOUND', 'الباقة غير موجودة.');
  const nameAr = body.name_ar === undefined
    ? String(current.name_ar)
    : requiredText(body.name_ar, 'اسم الباقة', 120);
  const descriptionAr = body.description_ar === undefined
    ? String(current.description_ar)
    : optionalText(body.description_ar, 'وصف الباقة', 500);
  const priceMinor = body.default_price_minor === undefined
    ? Number(current.default_price_minor)
    : assertMinorAmount(body.default_price_minor, true);
  const isActive = body.is_active === undefined ? Number(current.is_active) : body.is_active ? 1 : 0;
  const updatedAt = nowIso();
  const after = { name_ar: nameAr, description_ar: descriptionAr, default_price_minor: priceMinor, is_active: isActive };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE plans SET name_ar = ?, description_ar = ?, default_price_minor = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(nameAr, descriptionAr, priceMinor, isActive, updatedAt, planId),
    auditStatement(env, request, 'plan.update', 'plan', planId, current, after, ipHash),
  ]);
  return jsonResponse({ ok: true });
}

async function auditLog(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
  const result = await env.DB.prepare(
    `SELECT id, actor_type, actor_id, action, entity_type, entity_id,
            before_json, after_json, request_id, created_at
     FROM audit_logs ORDER BY created_at DESC LIMIT ?`,
  ).bind(limit).all();
  return jsonResponse({ audit: result.results || [] });
}

async function login(request: Request, env: Env): Promise<Response> {
  const { passwordHash, sessionSecret } = requireSecrets(env);
  const key = await attemptKey(request);
  const lockedUntil = await checkLoginLock(env.DB, key);
  if (lockedUntil) {
    const retryAfter = Math.max(Math.ceil((lockedUntil - Date.now()) / 1000), 1);
    return jsonResponse(
      { error: 'محاولات كثيرة. حاول لاحقًا.', code: 'LOGIN_LOCKED', retry_after: retryAfter },
      429,
      { 'Retry-After': String(retryAfter) },
    );
  }

  const body = await readJson(request);
  const password = String(body.password || '');
  const [saltHex, expected, extra] = passwordHash.split(':');
  if (extra || !saltHex || !expected) throw new HttpError(500, 'AUTH_NOT_CONFIGURED', 'إعداد الدخول غير صالح.');
  const given = await derivePassword(password, saltHex);
  if (!safeEqual(given, expected)) {
    await recordLoginFailure(env.DB, key);
    return jsonResponse({ error: 'بيانات الدخول غير صحيحة.', code: 'INVALID_CREDENTIALS' }, 401);
  }

  await clearLoginFailures(env.DB, key);
  const { cookie, session } = await createSession(sessionSecret);
  return jsonResponse(
    { ok: true, csrf: session.csrf, expires_at: new Date(session.expires).toISOString() },
    200,
    { 'Set-Cookie': sessionCookie(cookie, SESSION_HOURS * 60 * 60) },
  );
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/health' && request.method === 'GET') {
    return jsonResponse({ ok: true, service: 'athar-console', version: '2.0.0' });
  }
  if (path === '/api/login' && request.method === 'POST') return login(request, env);

  const session = await authenticate(request, env);
  if (path === '/api/session' && request.method === 'GET') {
    return jsonResponse({ authenticated: true, csrf: session.csrf, expires_at: new Date(session.expires).toISOString() });
  }
  if (!['GET', 'HEAD'].includes(request.method)) requireCsrf(request, session);

  const ipHash = await sha256(clientIp(request));
  if (path === '/api/logout' && request.method === 'POST') {
    return jsonResponse(
      { ok: true },
      200,
      { 'Set-Cookie': sessionCookie('', 0) },
    );
  }
  if (path === '/api/dashboard' && request.method === 'GET') return dashboard(env);
  if (path === '/api/tenants' && request.method === 'POST') return createTenant(request, env, ipHash);
  if (path === '/api/payments' && request.method === 'POST') return recordPayment(request, env, ipHash);
  if (path === '/api/audit' && request.method === 'GET') return auditLog(env, url);
  if (path === '/api/tenants/archived' && request.method === 'GET') return archivedTenants(env);

  const customerMatch = path.match(/^\/api\/tenants\/([^/]+)\/customer$/);
  if (customerMatch && request.method === 'PATCH') {
    return updateCustomer(request, env, decodeURIComponent(customerMatch[1] || ''), ipHash);
  }
  const healthMatch = path.match(/^\/api\/tenants\/([^/]+)\/health$/);
  if (healthMatch && request.method === 'POST') {
    return tenantHealth(env, decodeURIComponent(healthMatch[1] || ''));
  }
  const pinMatch = path.match(/^\/api\/tenants\/([^/]+)\/reset-pin$/);
  if (pinMatch && request.method === 'POST') {
    return resetOwnerPin(request, env, decodeURIComponent(pinMatch[1] || ''), ipHash);
  }
  const exportMatch = path.match(/^\/api\/tenants\/([^/]+)\/export$/);
  if (exportMatch && request.method === 'POST') {
    return exportTenant(request, env, decodeURIComponent(exportMatch[1] || ''), ipHash);
  }
  const purgeMatch = path.match(/^\/api\/tenants\/([^/]+)$/);
  if (purgeMatch && request.method === 'DELETE') {
    return purgeTenant(request, env, decodeURIComponent(purgeMatch[1] || ''), ipHash);
  }

  const tenantPlanMatch = path.match(/^\/api\/tenants\/([^/]+)\/plan$/);
  if (tenantPlanMatch && request.method === 'PATCH') {
    return changePlan(request, env, decodeURIComponent(tenantPlanMatch[1] || ''), ipHash);
  }
  const retryMatch = path.match(/^\/api\/tenants\/([^/]+)\/retry-provision$/);
  if (retryMatch && request.method === 'POST') {
    return retryProvision(request, env, decodeURIComponent(retryMatch[1] || ''), ipHash);
  }
  const lifecycleMatch = path.match(/^\/api\/tenants\/([^/]+)\/lifecycle$/);
  if (lifecycleMatch && request.method === 'POST') {
    return lifecycle(request, env, decodeURIComponent(lifecycleMatch[1] || ''), ipHash);
  }
  const paymentsMatch = path.match(/^\/api\/tenants\/([^/]+)\/payments$/);
  if (paymentsMatch && request.method === 'GET') {
    return paymentHistory(env, decodeURIComponent(paymentsMatch[1] || ''));
  }
  const planMatch = path.match(/^\/api\/plans\/(.+)$/);
  if (planMatch && request.method === 'PATCH') {
    return updatePlan(request, env, decodeURIComponent(planMatch[1] || ''), ipHash);
  }

  throw new HttpError(404, 'NOT_FOUND', 'المسار غير موجود.');
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await api(request, env);
      return await env.ASSETS.fetch(request);
    } catch (error: unknown) {
      if (error instanceof HttpError) {
        return jsonResponse({ error: error.message, code: error.code }, error.status);
      }
      const id = requestId(request);
      console.error(JSON.stringify({ level: 'error', event: 'request_failed', request_id: id, error: String(error) }));
      return jsonResponse({ error: 'حدث خطأ غير متوقع.', code: 'INTERNAL_ERROR', request_id: id }, 500);
    }
  },

  /**
   * النسخ الاحتياطي الليلي.
   *
   * لا يرمي أبدًا: خطأ غير ملتقط هنا يظهر كتشغيل فاشل بلا تفصيل، فيصعب
   * معرفة أي قاعدة سقطت. النتيجة تُسجَّل سطرًا واحدًا لكل قاعدة.
   */
  async scheduled(event, env, ctx): Promise<void> {
    ctx.waitUntil((async () => {
      const started = Date.now();
      const results = await runBackup(backupTargets(env), env.BACKUPS);
      for (const result of results) {
        console.log(JSON.stringify({
          level: result.ok ? 'info' : 'error',
          event: 'backup', cron: event.cron, ...result,
        }));
      }
      console.log(JSON.stringify({
        level: 'info', event: 'backup_done', cron: event.cron,
        ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length,
        ms: Date.now() - started,
      }));
    })());
  },
} satisfies ExportedHandler<Env>;
