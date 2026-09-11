/**
 * باب الشركاء: من يُنادي اللوحة وليس إنسانًا أمام شاشة.
 *
 * أداة المبيعات (`athar-crm`) تحتاج أن تُنشئ نسخةً تجريبية للعميل وهي في
 * منتصف محادثة واتساب — لا أن يفتح صاحبها اللوحة ويملأ نموذجًا. والطريق
 * الخاطئ إلى ذلك أن تحمل الأداةُ كلمةَ مرور مشغّل اللوحة وتسجّل الدخول
 * نيابةً عنه: كلمةُ مرورٍ إنسانيّة في خادمٍ آخر، وصلاحياتٌ كاملة على كل
 * مسار، وسجلُّ تدقيقٍ يقول «فعلها المشغّل» وهو نائم.
 *
 * فبابٌ منفصل إذن: توقيعٌ لا كلمة مرور، وسرٌّ غير سرّ المحوّل (فتسريب
 * أحدهما لا يفتح الآخر)، ومسارٌ واحد لا يفعل إلا شيئًا واحدًا — نسخةٌ
 * تجريبية. لا إنتاج، ولا حذف، ولا قراءة لبقيّة العملاء.
 *
 * والتوقيع بالصيغة نفسها التي تُنادى بها المحرّكات، لأن صيغتين لشيءٍ
 * واحد تعني حارسين، وأحدهما سيتأخّر عن الآخر يومًا.
 */

import { HttpError, SLUG_PATTERN } from './lib';

const encoder = new TextEncoder();

/* نافذة يقبل فيها الطابع الزمني. خمس دقائق تحتمل فرق الساعات بين
   عاملَين، ولا تترك طلبًا ملتقَطًا صالحًا للإعادة بعد الغد. */
const MAX_SKEW_SECONDS = 300;

/** المنتجات التي يجوز للشريك أن يطلب تجربةً منها. */
export const PARTNER_PRODUCTS = ['restaurant', 'clinic', 'pharmacy', 'school'] as const;

export type PartnerDemoRequest = {
  requestId: string;
  leadId: string;
  productId: string;
  slug: string;
  displayName: string;
  brandKitCode: string;
  planCode: string;
  phone: string;
  logoDataUrl: string;
  trialDays: number;
};

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

/**
 * مقارنة لا يكشف زمنُها كم حرفًا صحّ.
 *
 * المقارنة العادية تتوقّف عند أول اختلاف، وفرق الميكروثانية بين محاولةٍ
 * صحّ حرفها الأول وأخرى لم يصحّ يُقاس عبر الشبكة إن كُرّر كفاية.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * يتحقّق من توقيع الشريك على الطلب.
 *
 * يأخذ الجسم نصًّا كما وصل لا كائنًا مُعادَ تسلسله: `JSON.stringify` لا
 * يضمن ترتيب المفاتيح نفسه في الطرفين، فتوقيعٌ على كائنٍ أُعيدت كتابته
 * يفشل بلا سبب ظاهر — أو الأسوأ، ينجح بجسمٍ غير الذي وُقّع.
 */
export async function verifyPartnerSignature(
  env: Env,
  request: Request,
  rawBody: string,
  now = Date.now(),
): Promise<void> {
  const secret = String(env.CRM_PARTNER_SECRET || '');
  if (!secret) {
    throw new HttpError(503, 'PARTNER_NOT_CONFIGURED', 'باب الشركاء غير مُعدّ في هذه اللوحة.');
  }

  const timestamp = request.headers.get('X-Athar-Timestamp') || '';
  const requestId = request.headers.get('X-Athar-Request-Id') || '';
  const signature = request.headers.get('X-Athar-Signature') || '';

  if (!timestamp || !requestId || !signature) {
    throw new HttpError(401, 'SIGNATURE_MISSING', 'الطلب غير موقّع.');
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    throw new HttpError(401, 'SIGNATURE_INVALID', 'الطابع الزمني غير صالح.');
  }

  /* الطابع بالثواني لا بالميلي ثانية — وهذا فرقٌ أوقع عطلًا من قبل. */
  if (Math.abs(Math.floor(now / 1000) - seconds) > MAX_SKEW_SECONDS) {
    throw new HttpError(401, 'SIGNATURE_EXPIRED', 'الطلب قديم أو ساعة المُرسِل منحرفة.');
  }

  const path = new URL(request.url).pathname;
  const canonical = `${timestamp}\n${requestId}\n${request.method.toUpperCase()}\n${path}\n${await sha256Hex(rawBody)}`;

  if (!safeEqual(signature, await hmacHex(secret, canonical))) {
    throw new HttpError(401, 'SIGNATURE_INVALID', 'التوقيع لا يطابق الطلب.');
  }
}

function text(value: unknown, field: string, maxLength: number, required: boolean): string {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out && required) throw new HttpError(422, 'FIELD_REQUIRED', `${field} مطلوب.`);
  if (out.length > maxLength) throw new HttpError(422, 'FIELD_TOO_LONG', `${field} أطول من المسموح.`);
  return out;
}

/**
 * يقرأ ما أرسله الشريك ولا يثق بشيء منه.
 *
 * ما لا يُقرأ هنا لا يصل إلى `createTenant`: نوع النسخة مثلًا لا يُقرأ
 * أصلًا، فلا سبيل لأن يطلب الشريك نسخةً إنتاجية مهما أرسل.
 */
export function readPartnerDemo(body: Record<string, unknown>): PartnerDemoRequest {
  const productId = text(body.product_id, 'المنتج', 40, true);
  if (!(PARTNER_PRODUCTS as readonly string[]).includes(productId)) {
    throw new HttpError(422, 'PRODUCT_NOT_ALLOWED', 'هذا المنتج غير متاح لإنشاء التجارب.');
  }

  const slug = text(body.slug, 'المعرّف', 40, true).toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new HttpError(422, 'INVALID_SLUG',
      'المعرّف: حروف إنجليزية صغيرة وأرقام وشرطة، يبدأ وينتهي بحرف أو رقم.');
  }

  const trialDaysRaw = Number(body.trial_days);
  const trialDays = Number.isFinite(trialDaysRaw)
    ? Math.min(Math.max(Math.floor(trialDaysRaw), 1), 30)
    : 14;

  const brandKitCode = text(body.brand_kit_code, 'الهوية', 60, false);
  if (brandKitCode && !/^[a-z0-9_-]{1,60}$/.test(brandKitCode)) {
    throw new HttpError(422, 'INVALID_BRAND_KIT', 'رمز الهوية غير صالح.');
  }

  const planCode = text(body.plan_code, 'الباقة', 40, false);
  if (planCode && !/^[a-z0-9_-]{1,40}$/.test(planCode)) {
    throw new HttpError(422, 'INVALID_PLAN', 'رمز الباقة غير صالح.');
  }

  /* الشعار يصل من أداة المبيعات مصغَّرًا في المتصفّح. والحدّ هنا لا هناك:
     ما يحمي القاعدة هو الحارس الذي لا يستطيع المُرسِل تخطّيه. */
  const logoDataUrl = text(body.logo_data_url, 'الشعار', 42000, false);
  if (logoDataUrl && !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(logoDataUrl)) {
    throw new HttpError(422, 'INVALID_LOGO', 'بيانات الشعار غير صالحة.');
  }

  return {
    requestId: text(body.request_id, 'معرّف الطلب', 80, true),
    leadId: text(body.lead_id, 'معرّف العميل المحتمل', 40, true),
    productId,
    slug,
    displayName: text(body.display_name, 'اسم العميل', 160, true),
    brandKitCode,
    planCode,
    phone: text(body.phone, 'الهاتف', 40, false),
    logoDataUrl,
    trialDays,
  };
}

/**
 * يختار باقة التجربة: الأغلى المفعّلة في المنتج ما لم تُطلب باسمها.
 *
 * الأغلى لا الأرخص عمدًا — التجربة تُري ما يُشترى، والعميل الذي رأى
 * النسخة الناقصة لا يعرف ما الذي يدفع مقابله في الكاملة.
 */
export async function resolveDemoPlan(
  env: Env,
  productId: string,
  planCode: string,
): Promise<string> {
  const row = planCode
    ? await env.DB.prepare(
      'SELECT id FROM plans WHERE product_id = ? AND code = ? AND is_active = 1',
    ).bind(productId, planCode).first<{ id: string }>()
    : await env.DB.prepare(
      `SELECT id FROM plans WHERE product_id = ? AND is_active = 1
       ORDER BY default_price_minor DESC, id ASC LIMIT 1`,
    ).bind(productId).first<{ id: string }>();

  if (!row) throw new HttpError(422, 'INVALID_PLAN', 'لا توجد باقة مفعّلة لهذا المنتج.');
  return row.id;
}
