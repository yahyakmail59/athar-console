/**
 * سحب العملاء المحتملين من نموذج التواصل في موقع أثر.
 *
 * كان النموذج يحفظ محليًا في قاعدة الموقع، فيبقى العميل المحتمل في صندوق
 * منفصل لا يراه من يدير الاشتراكات — أي أن مصدر العملاء الوحيد كان معزولًا
 * عن المكان الذي يُحوَّل فيه العميل إلى مشترك.
 *
 * السحب لا الدفع: الرسالة تبقى محفوظة في الموقع حتى تصل هنا، فسقوط اللوحة
 * لحظة إرسال الزائر لا يُضيّع شيئًا. والإقرار بعد الإدراج لا قبله.
 *
 * الازدواج يمنعه `source_id` الفريد لا الإقرار: لو أُدرجت الرسالة ثم سقط
 * الإقرار، تُسحب مرة أخرى ويتجاهلها الإدراج بصمت.
 */

/** ما يعيده الموقع — لا يُوثق به إلا بعد التحقق من الحقول. */
export type RemoteLead = {
  id: string;
  name: string;
  email: string;
  phone: string;
  business_type: string;
  service_label: string;
  message: string;
  created_at: number;
};

/**
 * قناة النداء، تُمرَّر ولا تُستورد — للسبب نفسه في `billing.ts`: منطق
 * «كيف يصير العميل المحتمل صفًّا» يجب أن يُختبر بلا شبكة ولا توقيع.
 */
export type LeadChannel = {
  fetchLeads: (limit: number) => Promise<RemoteLead[]>;
  acknowledge: (ids: string[]) => Promise<void>;
};

export type LeadSyncOutcome = {
  fetched: number;
  imported: number;
  linkedToExisting: number;
  customersCreated: number;
};

/** الأرقام وحدها: نفس الرقم يُكتب بصيغ شتّى، والمقارنة النصّية تصنع عميلين من واحد. */
const digitsOnly = (value: string) => String(value ?? '').replace(/\D/g, '');

const iso = (ms: number) => new Date(ms).toISOString();

const clip = (value: unknown, max: number) => String(value ?? '').slice(0, max).trim();

/**
 * يبحث عن عميل قائم بالرقم ثم بالبريد.
 *
 * الرقم أولًا لأنه ما يُتصل به فعلًا في هذا السوق، والبريد كثيرًا ما يُترك
 * فارغًا — ومطابقة الفراغ بالفراغ تجمع كل من لا بريد له في عميل واحد،
 * فيُشترط أن يكون غير فارغ.
 */
async function findExistingCustomer(
  db: D1Database,
  phone: string,
  email: string,
): Promise<string | null> {
  const digits = digitsOnly(phone);
  if (digits.length >= 7) {
    const byPhone = await db.prepare(
      `SELECT id FROM customers
       WHERE replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?`,
    ).bind(`%${digits.slice(-9)}`).first<{ id: string }>();
    if (byPhone?.id) return byPhone.id;
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail) {
    const byEmail = await db.prepare('SELECT id FROM customers WHERE lower(email) = ?')
      .bind(normalizedEmail).first<{ id: string }>();
    if (byEmail?.id) return byEmail.id;
  }
  return null;
}

export async function syncLeads(
  env: { DB: D1Database },
  channel: LeadChannel,
  nowMs: number,
  limit = 100,
): Promise<LeadSyncOutcome> {
  const leads = await channel.fetchLeads(limit);
  const outcome: LeadSyncOutcome = {
    fetched: leads.length, imported: 0, linkedToExisting: 0, customersCreated: 0,
  };
  if (!leads.length) return outcome;

  const now = iso(nowMs);
  const delivered: string[] = [];

  for (const lead of leads) {
    const sourceId = clip(lead.id, 64);
    const name = clip(lead.name, 120);
    // بلا معرّف أو بلا اسم لا يصلح صفًّا، لكنه يُقَرّ به: تركه بلا إقرار
    // يجعله يُسحب في كل دورة إلى الأبد.
    if (!sourceId || !name) {
      if (sourceId) delivered.push(sourceId);
      continue;
    }

    const phone = clip(lead.phone, 40);
    const email = clip(lead.email, 200);

    let customerId = await findExistingCustomer(env.DB, phone, email);
    if (customerId) {
      outcome.linkedToExisting += 1;
    } else {
      customerId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO customers (id, display_name, contact_name, phone, email, address, notes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, 'lead', ?, ?)`,
      ).bind(
        customerId,
        clip(lead.business_type, 160) || name,
        name,
        phone,
        email,
        `وصل من نموذج التواصل في athar.date${lead.service_label ? ` — ${clip(lead.service_label, 120)}` : ''}`,
        now,
        now,
      ).run();
      outcome.customersCreated += 1;
    }

    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO lead_messages
        (id, source_id, customer_id, name, email, phone, business_type, service_label, message, is_read, received_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      crypto.randomUUID(), sourceId, customerId, name, email, phone,
      clip(lead.business_type, 160), clip(lead.service_label, 120), clip(lead.message, 4000),
      iso(Number(lead.created_at) || nowMs), now,
    ).run();

    if (inserted.meta?.changes) outcome.imported += 1;
    delivered.push(sourceId);
  }

  // الإقرار أخيرًا وبعد نجاح كل ما سبق: لو انقطع هنا تُسحب الرسائل ثانيةً
  // ويتجاهلها القيد الفريد، وهو أرخص من فقد عميل.
  if (delivered.length) await channel.acknowledge(delivered);
  return outcome;
}

/** عدّاد للوحة: كم عميلًا محتملًا لم يُقرأ بعد. */
export async function unreadLeadCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM lead_messages WHERE is_read = 0')
    .first<{ n: number }>();
  return Number(row?.n || 0);
}
