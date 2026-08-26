/**
 * دورة الاشتراك: انتهاء الفترة ← مهلة سماح ← إيقاف.
 *
 * كانت الاشتراكات تنتهي ولا يحدث شيء: الخدمة تعمل إلى أن ينتبه صاحب اللوحة
 * بنفسه. هذا تسريب إيراد صامت، ومصدر إحراج حين يُوقَف عميل فجأة بلا سابق
 * إنذار لأن أحدًا تذكّره متأخرًا.
 *
 * المسار:
 *   1. تنتهي الفترة  → `past_due`، وتُفتح مهلة ثلاثة أيام، ويُسجَّل إشعار.
 *   2. خلال المهلة    → الخدمة تعمل كاملة. المهلة للتنبيه لا للعقاب.
 *   3. تنقضي المهلة   → `suspended`، ويُوقَف المستأجر في محرك المنتج.
 *
 * لا يعمل إلا على اشتراك عليه `auto_suspend = 1`. الإيقاف قرار تجاري له
 * وجه إنساني — عميل يمرّ بظرف، أو دفعة تأخرت في التحويل — فلا يُتخذ آليًا
 * إلا حيث اختير ذلك صراحةً.
 */

/**
 * إيقاف المستأجر في محرك منتجه.
 *
 * يُمرَّر ولا يُستورد: منطق الفوترة لا شأن له بـHTTP ولا بتوقيع HMAC، وفصله
 * يجعل «متى نوقف» قابلًا للاختبار بلا شبكة — وهو الجزء الذي يُغضب عميلًا
 * إن أخطأ.
 */
export type SuspendInEngine = (tenantId: string, productId: string, externalId: string) => Promise<void>;

/** ثلاثة أيام: مهلة تكفي لتحويل بنكي تأخّر، ولا تطيل الخدمة المجانية. */
export const GRACE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();

/** نصّ الإشعار — يُحفظ كما هو وقت إنشائه. */
function noticeText(kind: string, name: string, graceEndsAt: string): string {
  const day = new Date(graceEndsAt).toLocaleDateString('ar', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  if (kind === 'grace_started') {
    return `مرحبًا ${name}، انتهت فترة اشتراكك. الخدمة تعمل كالمعتاد حتى ${day}`
      + ` (${GRACE_DAYS} أيام)، وبعدها تتوقف تلقائيًا حتى التجديد.`;
  }
  return `مرحبًا ${name}، انقضت مهلة التجديد فأُوقفت الخدمة مؤقتًا.`
    + ' تعود فور تسجيل الدفعة، وبياناتك كلها محفوظة.';
}

export type BillingOutcome = {
  graceStarted: number;
  suspended: number;
  failures: Array<{ tenant: string; error: string }>;
};

type DueRow = {
  subscription_id: string;
  tenant_id: string;
  product_id: string;
  external_tenant_id: string;
  display_name: string;
  contact_name: string;
  current_period_end: string;
  grace_ends_at: string | null;
};

/**
 * الاشتراكات التي انتهت فترتها ولم تدخل المهلة بعد.
 *
 * `tenant_status = 'active'` شرط: مستأجر مؤرشف أو موقوف سلفًا لا معنى
 * لتنبيهه، ومحاولة إيقافه ثانيةً ترفضها قواعد الانتقال.
 */
const dueForGrace = (env: Env, now: string) => env.DB.prepare(
  `SELECT s.id AS subscription_id, t.id AS tenant_id, t.product_id, t.external_tenant_id,
          t.display_name, c.contact_name, s.current_period_end, s.grace_ends_at
   FROM subscriptions s
   JOIN tenants t ON t.id = s.tenant_id
   JOIN customers c ON c.id = t.customer_id
   WHERE s.auto_suspend = 1
     AND s.status IN ('active', 'trialing')
     AND t.status = 'active'
     AND s.current_period_end IS NOT NULL
     AND s.current_period_end <= ?`,
).bind(now).all<DueRow>();

/** الاشتراكات التي انقضت مهلتها. */
const dueForSuspend = (env: Env, now: string) => env.DB.prepare(
  `SELECT s.id AS subscription_id, t.id AS tenant_id, t.product_id, t.external_tenant_id,
          t.display_name, c.contact_name, s.current_period_end, s.grace_ends_at
   FROM subscriptions s
   JOIN tenants t ON t.id = s.tenant_id
   JOIN customers c ON c.id = t.customer_id
   WHERE s.auto_suspend = 1
     AND s.status IN ('past_due', 'grace')
     AND t.status = 'active'
     AND s.grace_ends_at IS NOT NULL
     AND s.grace_ends_at <= ?`,
).bind(now).all<DueRow>();

const recordNotice = (
  env: Env, row: DueRow, kind: string, graceEndsAt: string, now: string,
) => env.DB.prepare(
  `INSERT OR IGNORE INTO billing_notices
    (id, tenant_id, subscription_id, kind, period_end, grace_ends_at, message, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  crypto.randomUUID(), row.tenant_id, row.subscription_id, kind,
  row.current_period_end, graceEndsAt,
  noticeText(kind, row.contact_name || row.display_name, graceEndsAt), now,
);

/**
 * يشغّل الدورة.
 *
 * فشل مستأجر لا يوقف البقية: محرك متعطّل لمنتج واحد لا يجوز أن يمنع تنبيه
 * عملاء منتج آخر. والفشل يُعاد في القائمة باسمه.
 */
export async function runBillingCycle(
  env: Env,
  nowMs = Date.now(),
  suspendInEngine: SuspendInEngine = async () => {},
): Promise<BillingOutcome> {
  const now = iso(nowMs);
  const outcome: BillingOutcome = { graceStarted: 0, suspended: 0, failures: [] };

  // 1) فتح المهلة
  const grace = await dueForGrace(env, now);
  for (const row of grace.results) {
    try {
      const graceEndsAt = iso(nowMs + GRACE_DAYS * DAY_MS);
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE subscriptions SET status = 'past_due', grace_ends_at = ?, updated_at = ?
           WHERE id = ?`,
        ).bind(graceEndsAt, now, row.subscription_id),
        recordNotice(env, row, 'grace_started', graceEndsAt, now),
      ]);
      outcome.graceStarted += 1;
    } catch (error: unknown) {
      outcome.failures.push({ tenant: row.display_name, error: String(error) });
    }
  }

  // 2) الإيقاف بعد انقضاء المهلة
  const suspend = await dueForSuspend(env, now);
  for (const row of suspend.results) {
    try {
      // المحرك أولًا: لو فشل، يبقى المستأجر عاملًا وحالته في اللوحة صادقة.
      // العكس — تعليمه موقوفًا وهو يعمل — يجعل اللوحة تكذب على صاحبها،
      // فيظنّ العميل موقوفًا وهو يستقبل طلبات.
      if (row.external_tenant_id) {
        await suspendInEngine(row.tenant_id, row.product_id, row.external_tenant_id);
      }
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE subscriptions SET status = 'suspended', updated_at = ? WHERE id = ?",
        ).bind(now, row.subscription_id),
        env.DB.prepare(
          "UPDATE tenants SET status = 'suspended', updated_at = ? WHERE id = ?",
        ).bind(now, row.tenant_id),
        recordNotice(env, row, 'suspended', row.grace_ends_at || now, now),
      ]);
      outcome.suspended += 1;
    } catch (error: unknown) {
      outcome.failures.push({ tenant: row.display_name, error: String(error) });
    }
  }

  return outcome;
}

/**
 * الإشعارات التي لم تُبلَّغ بعد، ومعها رابط واتساب جاهز.
 *
 * الإشعار الآلي يقف عند حدود ما نملكه: لا بريد ولا رسائل نصية في المنصة،
 * وادّعاء أن العميل «أُبلغ» بمجرد كتابة صف في جدول ادّعاء كاذب. فالنظام
 * يجهّز الرسالة ويترك الإرسال لصاحب اللوحة، ثم يسجّل متى وقع فعلًا.
 */
export async function pendingNotices(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT n.id, n.kind, n.message, n.grace_ends_at, n.created_at, n.delivered_at,
            t.display_name, t.product_id, c.phone, c.contact_name
     FROM billing_notices n
     JOIN tenants t ON t.id = n.tenant_id
     JOIN customers c ON c.id = t.customer_id
     WHERE n.delivered_at IS NULL
     ORDER BY n.created_at DESC
     LIMIT 100`,
  ).all<Record<string, unknown>>();

  return rows.results.map((row) => {
    const digits = String(row.phone || '').replace(/\D/g, '');
    return {
      ...row,
      whatsapp_url: digits
        ? `https://wa.me/${digits}?text=${encodeURIComponent(String(row.message))}`
        : '',
    };
  });
}

export const markNoticeDelivered = (env: Env, id: string) => env.DB.prepare(
  'UPDATE billing_notices SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
).bind(nowIsoLocal(), id).run();

const nowIsoLocal = () => new Date().toISOString();
