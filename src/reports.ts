/**
 * تقارير الإيراد والتجديدات.
 *
 * اللوحة كانت تعرض رقمًا واحدًا: الإيراد الشهري المتكرر. وهو يجيب «كم ندخل
 * نظريًا» لا «كم قبضنا فعلًا» ولا «من يجدّد الشهر القادم» — وهذان ما يُبنى
 * عليهما قرار.
 *
 * كل حساب هنا مقسَّم بالعملة لا مجموعًا في رقم واحد: جمع دولار وشيكل في
 * خانة واحدة يعطي رقمًا يبدو صحيحًا وليس كذلك، وهو أخطر من غياب الرقم.
 */

/** مبلغ بعملته. الفئة الصغرى دائمًا — لا كسور عائمة في المال. */
export type Money = { currency: string; amount_minor: number };

export type RevenueReport = {
  generated_at: string;
  /** المحصَّل فعلًا في كل شهر من الاثني عشر الماضية. */
  collected_by_month: Array<{ month: string; totals: Money[] }>;
  /** المحصَّل في الاثني عشر شهرًا كلها. */
  collected_total: Money[];
  /** الإيراد المتكرر الشهري من الاشتراكات النشطة. */
  mrr: Money[];
  /** اشتراكات تنتهي فترتها خلال النافذة القادمة. */
  upcoming_renewals: Array<{
    tenant_id: string; display_name: string; product_id: string;
    customer_name: string; phone: string;
    period_end: string; days_left: number;
    amount_minor: number; currency: string; auto_suspend: number;
  }>;
  /** ما فات موعده ولم يُدفع. */
  overdue: Array<{
    tenant_id: string; display_name: string; product_id: string;
    customer_name: string; phone: string; status: string;
    period_end: string; days_late: number;
    amount_minor: number; currency: string;
  }>;
  /** توزيع الإيراد المتكرر على المنتجات. */
  by_product: Array<{ product_id: string; product_name: string; active: number; mrr_minor: number; currency: string }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** يوم كامل بالفارق: الجزئي يجعل «باقٍ يوم» يظهر صفرًا بعد الظهر. */
const daysBetween = (fromIso: string, toMs: number) =>
  Math.floor((Date.parse(fromIso) - toMs) / DAY_MS);

/**
 * حصّة الشهر من اشتراك: السنوي يُقسم على اثني عشر.
 *
 * السنوي محسوب هنا لا مطروحًا: عرض اشتراك سنوي بكامل قيمته في شهر واحد
 * يجعل الإيراد المتكرر يقفز ثم ينهار، فلا يُقرأ منه اتجاه.
 */
const MONTHLY_SHARE = `CASE
  WHEN s.billing_cycle = 'yearly' THEN CAST(s.price_minor / 12 AS INTEGER)
  WHEN s.billing_cycle = 'monthly' THEN s.price_minor
  ELSE 0
END`;

export async function revenueReport(
  db: D1Database,
  nowMs: number,
  renewalWindowDays = 30,
): Promise<RevenueReport> {
  const now = new Date(nowMs);
  const since = new Date(nowMs - 365 * DAY_MS).toISOString();
  const windowEnd = new Date(nowMs + renewalWindowDays * DAY_MS).toISOString();

  const [monthly, mrrRows, renewals, overdue, byProduct] = await Promise.all([
    db.prepare(
      `SELECT substr(paid_at, 1, 7) AS month, currency, SUM(amount_minor) AS total
       FROM subscription_payments
       WHERE paid_at >= ?
       GROUP BY month, currency
       ORDER BY month ASC`,
    ).bind(since).all<{ month: string; currency: string; total: number }>(),

    db.prepare(
      `SELECT s.currency, SUM(${MONTHLY_SHARE}) AS total
       FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.status = 'active' AND t.status = 'active'
       GROUP BY s.currency`,
    ).all<{ currency: string; total: number }>(),

    db.prepare(
      `SELECT t.id AS tenant_id, t.display_name, t.product_id,
              c.display_name AS customer_name, c.phone,
              s.current_period_end AS period_end, s.price_minor AS amount_minor,
              s.currency, s.auto_suspend
       FROM subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
       JOIN customers c ON c.id = t.customer_id
       WHERE t.status = 'active'
         AND s.status IN ('active', 'trialing')
         AND s.current_period_end IS NOT NULL
         AND s.current_period_end >= ?
         AND s.current_period_end <= ?
       ORDER BY s.current_period_end ASC`,
    ).bind(now.toISOString(), windowEnd).all<Record<string, never>>(),

    db.prepare(
      `SELECT t.id AS tenant_id, t.display_name, t.product_id,
              c.display_name AS customer_name, c.phone, s.status,
              s.current_period_end AS period_end, s.price_minor AS amount_minor, s.currency
       FROM subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
       JOIN customers c ON c.id = t.customer_id
       WHERE t.status <> 'archived'
         AND s.status IN ('past_due', 'grace', 'suspended')
       ORDER BY s.current_period_end ASC`,
    ).all<Record<string, never>>(),

    db.prepare(
      `SELECT t.product_id, p.name_ar AS product_name, s.currency,
              COUNT(*) AS active, SUM(${MONTHLY_SHARE}) AS mrr_minor
       FROM subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
       JOIN products p ON p.id = t.product_id
       WHERE s.status = 'active' AND t.status = 'active'
       GROUP BY t.product_id, p.name_ar, s.currency
       ORDER BY mrr_minor DESC`,
    ).all<Record<string, never>>(),
  ]);

  // الأشهر تُجمَّع بالعملة داخل كل شهر، ليقرأ الشهر بعملاته لا برقم مختلط.
  const months = new Map<string, Money[]>();
  const totals = new Map<string, number>();
  for (const row of monthly.results ?? []) {
    const list = months.get(row.month) ?? [];
    list.push({ currency: row.currency, amount_minor: Number(row.total) || 0 });
    months.set(row.month, list);
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + (Number(row.total) || 0));
  }

  return {
    generated_at: now.toISOString(),
    collected_by_month: [...months.entries()].map(([month, list]) => ({ month, totals: list })),
    collected_total: [...totals.entries()].map(([currency, amount_minor]) => ({ currency, amount_minor })),
    mrr: (mrrRows.results ?? []).map((row) => ({
      currency: row.currency, amount_minor: Number(row.total) || 0,
    })),
    upcoming_renewals: (renewals.results ?? []).map((row: any) => ({
      ...row,
      amount_minor: Number(row.amount_minor) || 0,
      auto_suspend: Number(row.auto_suspend) || 0,
      days_left: daysBetween(String(row.period_end), nowMs),
    })),
    overdue: (overdue.results ?? []).map((row: any) => ({
      ...row,
      amount_minor: Number(row.amount_minor) || 0,
      days_late: row.period_end ? -daysBetween(String(row.period_end), nowMs) : 0,
    })),
    by_product: (byProduct.results ?? []).map((row: any) => ({
      ...row,
      active: Number(row.active) || 0,
      mrr_minor: Number(row.mrr_minor) || 0,
    })),
  };
}
