export const MAX_JSON_BYTES = 64 * 1024;
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeSlug(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function assertSlug(value: unknown): string {
  const slug = normalizeSlug(value);
  if (!SLUG_PATTERN.test(slug)) {
    throw new HttpError(
      422,
      'INVALID_SLUG',
      'المعرّف يجب أن يحتوي أحرفًا إنجليزية صغيرة وأرقامًا وشرطات، من 2 إلى 40 حرفًا.',
    );
  }
  return slug;
}

export function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new HttpError(422, 'REQUIRED_FIELD', `الحقل «${field}» مطلوب.`);
  if (text.length > maxLength) {
    throw new HttpError(422, 'FIELD_TOO_LONG', `الحقل «${field}» أطول من المسموح.`);
  }
  return text;
}

export function optionalText(value: unknown, field: string, maxLength: number): string {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) {
    throw new HttpError(422, 'FIELD_TOO_LONG', `الحقل «${field}» أطول من المسموح.`);
  }
  return text;
}

export function assertMinorAmount(value: unknown, allowZero = false): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) {
    throw new HttpError(422, 'INVALID_AMOUNT', 'المبلغ غير صالح.');
  }
  return amount;
}

export function assertDate(value: unknown, field: string, allowEmpty = true): string | null {
  const date = String(value ?? '').trim();
  if (!date && allowEmpty) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpError(422, 'INVALID_DATE', `صيغة «${field}» يجب أن تكون YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new HttpError(422, 'INVALID_DATE', `التاريخ في «${field}» غير صالح.`);
  }
  return date;
}

export function requestId(request: Request): string {
  const incoming = request.headers.get('CF-Ray') || request.headers.get('X-Request-ID');
  return incoming?.slice(0, 100) || crypto.randomUUID();
}

export function securityHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = securityHeaders();
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), { status, headers });
}

export async function readJson<T extends Record<string, unknown>>(request: Request): Promise<T> {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'JSON_REQUIRED', 'يجب إرسال البيانات بصيغة JSON.');
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'حجم الطلب أكبر من المسموح.');
  }
  if (!request.body) throw new HttpError(400, 'EMPTY_BODY', 'الطلب فارغ.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel('body too large');
      throw new HttpError(413, 'BODY_TOO_LARGE', 'حجم الطلب أكبر من المسموح.');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'تعذّر قراءة بيانات الطلب.');
  }
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function addDaysIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * الإيقاف التلقائيّ عند انتهاء المدّة: يُطلب صراحةً، وإلا فلا.
 *
 * ✦ القاعدة مكتوبة هنا لا منثورةً في مسار الإنشاء، لأن طرفيها متعارضان
 * ولا يُقرأ أحدهما إلا مع الآخر: تجربة أداة المبيعات **يجب** أن تتوقّف
 * (وإلا صارت هديّةً دائمة ورسالتُها كاذبة)، ونسخُ العرض المصنوعة من
 * شاشة اللوحة (`demo`، `sanabel`) **يجب** ألّا تتوقّف — أوّل رابطٍ
 * يُرسَل يفتح على «غير متاح».
 *
 * فالافتراض «لا يتوقّف»، والطلب الصريح وحده يقلبه.
 */
export const wantsAutoSuspend = (value: unknown): 0 | 1 =>
  (value === 1 || value === true ? 1 : 0);

/* ==================== أرقام الجوّال الفلسطينية ==================== */

/**
 * رقم واتساب صالح من أيّ شكلٍ يُكتب به الرقم عندنا.
 *
 * ✦ كانت اللوحة تبني الرابط بـ`phone.replace(/\D/g,'')` ولا شيء غيره.
 * وبيانات الإنتاج الحقيقية تحوي أربعة أشكال، ثلاثة منها تُنتج رابطًا
 * معطوبًا:
 *
 *   0597862389                          → wa.me/0597862389        بلا مقدّمة
 *   ‏+972 56-666-0005‏                   → wa.me/972566660005      مقدّمة خطأ
 *   0599901300 | 0599307303 | 05979...  → ثلاثة أرقام ملتصقة في واحد
 *   ⁦+970 599 526 100⁩                   → صحيح — وهو الشكل الوحيد الذي كان يعمل
 *
 * وفي البيانات علاماتُ اتجاهٍ خفيّة (U+200F و U+2066 و U+2069) تأتي مع
 * النسخ من جهات اتصال أندرويد وواتساب. لا تُرى ولا تُطبع، وتكسر أيّ
 * مقارنةٍ أو تحقّقٍ مربوطٍ بأوّل النصّ أو آخره.
 *
 * **و972 ليست خطأً دائمًا.** الرقم الفلسطينيّ (059 جوّال · 056 أوريدو)
 * يُكتب أحيانًا بالمقدّمة القديمة، فيُصحَّح إلى 970. أمّا 050 و052 و054
 * وأخواتها فمشغّلون إسرائيليّون فعلًا، وتحويلها إلى 970 يعطي رقمًا لا
 * وجود له.
 */

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/* الفواصل المستعملة فعلًا في القاعدة. والشرطة ليست منها: تقع داخل
   الرقم نفسه (56-666-0005) لا بينه وبين غيره. */
const PHONE_SEPARATORS = /[\/|,،;؛\n\r]+|\s+-\s+|\s+و\s+|\s+أو\s+|\s+ext\.?\s*/gi;

export type PhoneKind =
  'jawwal' | 'ooredoo' | 'israeli' | 'landline' | 'unknown' | 'none';

export type PhoneRead = {
  /** رقم واتساب كاملًا بلا `+`، أو "" إن لم يصلح. */
  number: string;
  mobile: boolean;
  kind: PhoneKind;
  /** كم رقمًا وُجد في الحقل — لتقول للمستخدم «اختير أوّل جوّال من ثلاثة». */
  count: number;
  /** كل الأرقام الصالحة للواتساب في الحقل، بالترتيب. */
  all: string[];
};

/** يحوّل الأرقام العربية-الهندية ويُسقط كل ما ليس رقمًا. */
const onlyDigits = (value: string): string => value
  .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) & 0x0f))
  .replace(/\D/g, '');

/**
 * الرقم الوطنيّ: تسع خانات للجوّال، وثمان للأرضيّ.
 *
 * والمقدّمة المكتوبة تُسقَط ولا تُحفظ، لأنها لا تدخل القرار: 059 جوّالٌ
 * فلسطينيّ سواءٌ كُتب بـ970 أو 972 أو بلا مقدّمة.
 */
function nationalNumber(digits: string): string {
  let rest = digits;
  if (rest.startsWith('00')) rest = rest.slice(2);
  if (rest.startsWith('970') || rest.startsWith('972')) return rest.slice(3);
  if (rest.startsWith('0')) return rest.slice(1);
  return rest;
}

function classify(nsn: string): PhoneKind {
  if (/^59\d{7}$/.test(nsn)) return 'jawwal';
  if (/^56\d{7}$/.test(nsn)) return 'ooredoo';
  if (/^5[0234578]\d{7}$/.test(nsn)) return 'israeli';
  if (/^[2489]\d{7}$/.test(nsn)) return 'landline';
  return 'unknown';
}

const RANK: Record<PhoneKind, number> = {
  jawwal: 0, ooredoo: 0, israeli: 1, landline: 2, unknown: 3, none: 4,
};

export function readPhone(raw: unknown): PhoneRead {
  const parts = String(raw ?? '')
    .split(PHONE_SEPARATORS)
    .map(onlyDigits)
    .filter(Boolean);

  if (!parts.length) return { number: '', mobile: false, kind: 'none', count: 0, all: [] };

  let best: { kind: PhoneKind; nsn: string } | null = null;
  const all: string[] = [];

  for (const part of parts) {
    const nsn = nationalNumber(part);
    const kind = classify(nsn);
    if (!best || RANK[kind] < RANK[best.kind]) best = { kind, nsn };
    /* ✦ كل الأرقام الصالحة لا الأوّل وحده.
       حقلُ «مطعم سنابل» فيه ثلاثة، والأداة كانت تعرض الأوّل وتُخفي
       الآخرين — فحين لم يكن على الأوّل واتساب بدا العميل غير قابلٍ
       للوصول، وهو قابل. */
    if (kind === 'jawwal' || kind === 'ooredoo') all.push(`970${nsn}`);
    else if (kind === 'israeli') all.push(`972${nsn}`);
  }

  const { kind, nsn } = best!;

  /* الفلسطينيّ إلى 970 مهما كُتب، والإسرائيليّ يبقى 972. وما عداهما لا
     يُخترع له رقم: الأرضيّ لا يعمل على واتساب، والناقص ناقص. */
  const country = kind === 'jawwal' || kind === 'ooredoo' ? '970'
    : kind === 'israeli' ? '972'
      : '';

  return {
    number: country ? country + nsn : '',
    mobile: Boolean(country),
    kind,
    count: parts.length,
    all,
  };
}

/** رابط واتساب جاهز، أو "" إن لم يصلح الرقم. */
export function whatsappUrl(raw: unknown, text = ''): string {
  const { number } = readPhone(raw);
  if (!number) return '';
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
