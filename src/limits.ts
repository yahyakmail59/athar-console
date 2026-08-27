/**
 * مراقبة حدود المنصة.
 *
 * كل شيء هنا يعمل داخل حدود مجانية أو شبه مجانية، وتجاوزها لا يُعلن عن نفسه
 * برسالة بل بتوقّف مفاجئ: قاعدة تمتلئ فترفض الكتابة، وسطلٌ يكبر فيصير له
 * ثمن. الرقم الذي لا يُقاس لا يُدار.
 *
 * ما يُقاس من داخل الـWorker ثلاثة:
 *   1. حجم كل قاعدة D1، من `meta.size_after` المرفق بكل استعلام.
 *   2. حجم سطل النسخ في R2 وعدد كائناته، بالمرور على القائمة.
 *   3. عدد النسخ لكل قاعدة — إن نقص عن المتوقَّع فالنسخ الليلي يفشل صامتًا.
 *
 * وما لا يُقاس من هنا: عدد الطلبات وزمن المعالج. هذان في تحليلات كلاودفلير
 * ويحتاجان رمز API لحساب كامل — سرّ أوسع صلاحية بكثير من قيمة الرقم، ولا
 * يُوضَع في Worker مكشوف للإنترنت. يُقرآن من اللوحة الرسمية.
 */

export type D1Usage = {
  name: string;
  size_bytes: number;
  limit_bytes: number;
  used_percent: number;
};

export type R2Usage = {
  objects: number;
  size_bytes: number;
  by_prefix: Array<{ prefix: string; objects: number; size_bytes: number }>;
};

export type LimitWarning = {
  level: 'warn' | 'critical';
  resource: string;
  message: string;
};

export type LimitsReport = {
  generated_at: string;
  d1: D1Usage[];
  r2: R2Usage | null;
  warnings: LimitWarning[];
};

/**
 * حدّ حجم قاعدة D1 على الخطة المجانية: 500 ميجابايت.
 *
 * المجاني لا المدفوع عمدًا: لو كان الحساب مدفوعًا فالتحذير مبكر لا خاطئ،
 * ولو كان مجانيًا وافترضنا المدفوع لجاء التحذير بعد أن ترفض القاعدة الكتابة.
 * الخطأ في اتجاه الأمان.
 */
const D1_LIMIT_BYTES = 500 * 1024 * 1024;

/** عتبتان: تنبيه عند النصف، وحرج عند أربعة أخماس. */
const WARN_AT = 0.5;
const CRITICAL_AT = 0.8;

/** كم كائنًا يُمرّ عليه قبل التوقف — حارس ضد سطل كبّرته أخطاء. */
const MAX_LISTED = 5000;

/**
 * حجم القاعدة من `meta.size_after`.
 *
 * استعلام تافه يكفي: D1 يرفق حجم القاعدة بعد كل استعلام، فلا حاجة إلى
 * `PRAGMA page_count` ولا إلى واجهة REST برمزها الواسع.
 */
async function d1SizeBytes(db: D1Database): Promise<number> {
  const result = await db.prepare('SELECT 1').all();
  const meta = (result as { meta?: { size_after?: number } }).meta;
  return Number(meta?.size_after) || 0;
}

export async function d1Usage(targets: Array<{ name: string; db: D1Database }>): Promise<D1Usage[]> {
  return Promise.all(targets.map(async ({ name, db }) => {
    const size = await d1SizeBytes(db);
    return {
      name,
      size_bytes: size,
      limit_bytes: D1_LIMIT_BYTES,
      // منزلتان: النسبة تُقرأ لا تُحسب عليها فوائد.
      used_percent: Math.round((size / D1_LIMIT_BYTES) * 10000) / 100,
    };
  }));
}

/** يمرّ على السطل ويجمع الحجم، مقسَّمًا على البادئة الأولى (اسم القاعدة). */
export async function r2Usage(bucket: R2Bucket): Promise<R2Usage> {
  const byPrefix = new Map<string, { objects: number; size_bytes: number }>();
  let objects = 0;
  let sizeBytes = 0;
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ limit: 1000, cursor });
    for (const object of page.objects) {
      objects += 1;
      sizeBytes += Number(object.size) || 0;
      // المجلد كاملًا لا الجزء الأول: مفاتيح النسخ `d1/{اسم القاعدة}/{وقت}`،
      // والاكتفاء بالأول يجعل القواعد الأربع بادئة واحدة — ففحص «هل لكل
      // قاعدة نسخة؟» يمرّ دائمًا وهو أهم فحص هنا.
      const slash = object.key.lastIndexOf('/');
      const prefix = slash > 0 ? object.key.slice(0, slash) : '(بلا مجلد)';
      const entry = byPrefix.get(prefix) ?? { objects: 0, size_bytes: 0 };
      entry.objects += 1;
      entry.size_bytes += Number(object.size) || 0;
      byPrefix.set(prefix, entry);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && objects < MAX_LISTED);

  return {
    objects,
    size_bytes: sizeBytes,
    by_prefix: [...byPrefix.entries()]
      .map(([prefix, value]) => ({ prefix, ...value }))
      .sort((a, b) => b.size_bytes - a.size_bytes),
  };
}

/**
 * يحوّل الأرقام إلى تحذيرات.
 *
 * القاعدة: لا يُذكر إلا ما يحتاج فعلًا قرارًا. تقرير يذكر كل شيء يُقرأ مرة
 * ثم يُهمَل، ويصير غيابُ التحذير وحضورُه سواء.
 */
export function limitWarnings(d1: D1Usage[], r2: R2Usage | null, expectedBackupPrefixes: string[]): LimitWarning[] {
  const warnings: LimitWarning[] = [];

  for (const usage of d1) {
    const ratio = usage.size_bytes / usage.limit_bytes;
    if (ratio >= CRITICAL_AT) {
      warnings.push({
        level: 'critical', resource: `D1/${usage.name}`,
        message: `القاعدة بلغت ${usage.used_percent}% من الحد. الكتابة تتوقف عند الامتلاء.`,
      });
    } else if (ratio >= WARN_AT) {
      warnings.push({
        level: 'warn', resource: `D1/${usage.name}`,
        message: `القاعدة بلغت ${usage.used_percent}% من الحد.`,
      });
    }
  }

  if (r2) {
    // نسخة ناقصة لقاعدة = فشل ليلي صامت. وهذا أخطر من الامتلاء: الامتلاء
    // يُعلن عن نفسه بخطأ، وغياب النسخة لا يُكتشف إلا يوم الاستعادة.
    for (const name of expectedBackupPrefixes) {
      const found = r2.by_prefix.find((entry) => entry.prefix === name);
      if (!found || found.objects === 0) {
        warnings.push({
          level: 'critical', resource: `R2/${name}`,
          message: 'لا نسخة احتياطية واحدة لهذه القاعدة في السطل.',
        });
      }
    }
  } else {
    warnings.push({
      level: 'critical', resource: 'R2',
      message: 'سطل النسخ غير مربوط — لا نسخ احتياطي أصلًا.',
    });
  }

  return warnings;
}

export async function limitsReport(
  targets: Array<{ name: string; db: D1Database }>,
  bucket: R2Bucket | undefined,
  nowMs: number,
): Promise<LimitsReport> {
  const d1 = await d1Usage(targets);
  const r2 = bucket ? await r2Usage(bucket) : null;
  return {
    generated_at: new Date(nowMs).toISOString(),
    d1,
    r2,
    // `d1/` بادئة النسخ في السطل — كما يكتبها `runBackup`.
    warnings: limitWarnings(d1, r2, targets.map((t) => `d1/${t.name}`)),
  };
}
