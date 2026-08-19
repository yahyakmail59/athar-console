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
