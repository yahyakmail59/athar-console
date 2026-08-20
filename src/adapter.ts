import { HttpError } from './lib.js';

const encoder = new TextEncoder();
const MAX_ADAPTER_RESPONSE_BYTES = 64 * 1024;

export type AdapterRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  requestId: string;
  body?: Record<string, unknown>;
};

export type HealthResult = {
  ok: true;
  request_id: string;
  tenant_id: string;
  external_tenant_id: string;
  environment: string;
  status: string;
  active: boolean;
  checked_at: string;
};

export type ProvisionResult = {
  ok: true;
  request_id: string;
  tenant_id: string;
  external_tenant_id: string;
  status: string;
  environment: string;
  public_url: string;
  credentials: {
    pharmacy_id: string;
    owner_pin: string;
  };
  replayed?: boolean;
};

export type LifecycleResult = {
  ok: true;
  request_id: string;
  tenant_id: string;
  external_tenant_id: string;
  status: string;
  replayed?: boolean;
};

export class ProductAdapterError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ProductAdapterError';
    this.status = status;
    this.code = code;
  }
}

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function signedAdapterHeaders(
  secret: string,
  method: string,
  path: string,
  requestId: string,
  rawBody: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
): Promise<Headers> {
  if (!secret) throw new HttpError(500, 'ADAPTER_NOT_CONFIGURED', 'ربط محرك الصيدليات غير مُعدّ بعد.');
  const bodyHash = await sha256Hex(rawBody);
  const canonical = `${timestamp}\n${requestId}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
  return new Headers({
    'Content-Type': 'application/json',
    'X-Athar-Timestamp': timestamp,
    'X-Athar-Request-Id': requestId,
    'X-Athar-Signature': await hmacHex(secret, canonical),
  });
}

/**
 * المنتجات التي لها محرك مربوط. إضافة منتج جديد تعني سطرًا هنا فقط،
 * لا شرطًا جديدًا منثورًا في المسارات.
 */
const PRODUCT_ADAPTERS: Record<string, { binding: keyof Env; urlVar: keyof Env; label: string }> = {
  pharmacy: { binding: 'PHARMA_ADAPTER', urlVar: 'PHARMA_ADAPTER_URL', label: 'الصيدليات' },
  school: { binding: 'SCHOOL_ADAPTER', urlVar: 'SCHOOL_ADAPTER_URL', label: 'المدارس' },
};

export const hasAdapter = (productId: string): boolean =>
  Object.hasOwn(PRODUCT_ADAPTERS, productId);

export async function callProductAdapter<T>(
  env: Env,
  productId: string,
  input: AdapterRequest,
): Promise<T> {
  const config = PRODUCT_ADAPTERS[productId];
  if (!config) {
    throw new ProductAdapterError(422, 'ADAPTER_NOT_AVAILABLE', 'هذا المنتج غير مربوط بمحرك تلقائي بعد.');
  }
  const rawBody = input.body ? JSON.stringify(input.body) : '';
  const headers = await signedAdapterHeaders(
    env.ATHAR_ADAPTER_SECRET,
    input.method,
    input.path,
    input.requestId,
    rawBody,
  );
  const fallback = String(env[config.urlVar] || '').trim();
  const service = env[config.binding] as Fetcher | undefined;
  if (!fallback && !service) {
    throw new ProductAdapterError(503, 'ADAPTER_UNREACHABLE', `محرك ${config.label} غير مربوط بعد.`);
  }
  const url = fallback
    ? new URL(input.path, fallback).toString()
    : `https://${productId}-adapter.internal${input.path}`;
  const init: RequestInit = {
    method: input.method,
    headers,
    body: input.body ? rawBody : undefined,
    signal: AbortSignal.timeout(15_000),
  };
  let response: Response;
  try {
    response = fallback ? await fetch(url, init) : await service!.fetch(url, init);
  } catch {
    throw new ProductAdapterError(503, 'ADAPTER_UNREACHABLE', `تعذر الاتصال بمحرك ${config.label}.`);
  }

  const declaredLength = Number(response.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_ADAPTER_RESPONSE_BYTES) {
    throw new ProductAdapterError(502, 'ADAPTER_BAD_RESPONSE', `أعاد محرك ${config.label} استجابة غير صالحة.`);
  }
  const raw = await response.text();
  if (encoder.encode(raw).byteLength > MAX_ADAPTER_RESPONSE_BYTES) {
    throw new ProductAdapterError(502, 'ADAPTER_BAD_RESPONSE', `أعاد محرك ${config.label} استجابة كبيرة جدًا.`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ProductAdapterError(502, 'ADAPTER_BAD_RESPONSE', `تعذر قراءة استجابة محرك ${config.label}.`);
  }
  if (!response.ok || payload.ok !== true) {
    const code = String(payload.error || 'ADAPTER_FAILED').slice(0, 80);
    const message = String(payload.message || `فشل تنفيذ الطلب في محرك ${config.label}.`).slice(0, 240);
    throw new ProductAdapterError(response.status, code, message);
  }
  return payload as T;
}

export async function callPharmaAdapter<T>(env: Env, input: AdapterRequest): Promise<T> {
  const rawBody = input.body ? JSON.stringify(input.body) : '';
  const headers = await signedAdapterHeaders(
    env.ATHAR_ADAPTER_SECRET,
    input.method,
    input.path,
    input.requestId,
    rawBody,
  );
  const fallback = String(env.PHARMA_ADAPTER_URL || '').trim();
  const url = fallback ? new URL(input.path, fallback).toString() : `https://pharma-adapter.internal${input.path}`;
  const init: RequestInit = {
    method: input.method,
    headers,
    body: input.body ? rawBody : undefined,
    signal: AbortSignal.timeout(15_000),
  };
  let response: Response;
  try {
    response = fallback ? await fetch(url, init) : await env.PHARMA_ADAPTER.fetch(url, init);
  } catch {
    throw new ProductAdapterError(503, 'ADAPTER_UNREACHABLE', 'تعذر الاتصال بمحرك الصيدليات.');
  }

  const declaredLength = Number(response.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_ADAPTER_RESPONSE_BYTES) {
    throw new ProductAdapterError(502, 'ADAPTER_BAD_RESPONSE', 'أعاد محرك الصيدليات استجابة غير صالحة.');
  }
  const raw = await response.text();
  if (encoder.encode(raw).byteLength > MAX_ADAPTER_RESPONSE_BYTES) {
    throw new ProductAdapterError(502, 'ADAPTER_BAD_RESPONSE', 'أعاد محرك الصيدليات استجابة كبيرة جدًا.');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ProductAdapterError(502, 'ADAPTER_BAD_RESPONSE', 'تعذر قراءة استجابة محرك الصيدليات.');
  }
  if (!response.ok || payload.ok !== true) {
    const code = String(payload.error || 'ADAPTER_FAILED').slice(0, 80);
    const message = String(payload.message || 'فشل تنفيذ الطلب في محرك الصيدليات.').slice(0, 240);
    throw new ProductAdapterError(response.status, code, message);
  }
  return payload as T;
}
