/**
 * نسخ احتياطي مجدول لقواعد D1 الأربع إلى R2.
 *
 * لماذا هذا موجود: المطاعم كلها في قاعدة واحدة، وكذلك المدارس والصيدليات.
 * ترحيل خاطئ واحد يضرب كل المستأجرين معًا، ولم تكن هناك نسخة يُرجَع إليها
 * سوى ما أنشأناه يدويًا قبل ترحيلات بعينها.
 *
 * لماذا قراءة الجداول لا `d1 export`: التصدير الرسمي واجهة REST تحتاج رمز
 * API لحساب كلاودفلير كاملًا — سرّ صلاحيته أوسع بكثير من قراءة أربع قواعد،
 * ولو تسرّب من الـWorker لأمكن به حذف الحساب لا قراءته فقط. الربط المباشر
 * يعطي القراءة وحدها.
 *
 * الصيغة SQL نصّي: يُستعاد بـ`wrangler d1 execute --file` بلا أداة خاصة،
 * ويُقرأ بالعين عند الحاجة. JSON أصغر لكنه يحتاج شيفرة استعادة نكتبها نحن،
 * وشيفرة الاستعادة التي لا تُجرَّب ليست نسخة احتياطية.
 */

/** ما يُنسخ: الاسم الذي يظهر في المسار، والرابط. */
export type BackupTarget = { name: string; db: D1Database };

/**
 * كم نسخة تُحفظ لكل قاعدة.
 *
 * ثلاثون يومًا: عطل يُكتشف بعد أسبوعين ليس نادرًا (تقرير شهري خاطئ مثلًا)،
 * وحجم القواعد اليوم أقل من ميجابايت فالتكلفة لا تُذكر.
 */
const KEEP = 30;

const SKIP_TABLES = new Set(['sqlite_sequence', 'sqlite_stat1', '_cf_KV']);

const quote = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : (value as Uint8Array).buffer);
    let hex = '';
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
};

/**
 * يبني ملف SQL لقاعدة واحدة.
 *
 * يُعاد نصًّا كاملًا لا تدفّقًا: القواعد هنا بحجم مئات الكيلوبايتات، والتدفّق
 * يضيف تعقيدًا بلا مقابل. لو كبرت قاعدة إلى عشرات الميجابايتات فهذا هو
 * الموضع الذي يجب أن يتغيّر — والحدّ يُقاس من `size` في نتيجة الرفع.
 */
export async function dumpDatabase(db: D1Database): Promise<string> {
  const tables = await db.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).all<{ name: string; sql: string }>();

  const parts: string[] = [
    '-- نسخة احتياطية من لوحة أثر',
    `-- ${new Date().toISOString()}`,
    'PRAGMA defer_foreign_keys = true;',
    '',
  ];

  for (const table of tables.results) {
    if (SKIP_TABLES.has(table.name)) continue;
    parts.push(`DROP TABLE IF EXISTS "${table.name}";`);
    parts.push(`${table.sql};`);

    const rows = await db.prepare(`SELECT * FROM "${table.name}"`).all<Record<string, unknown>>();
    if (!rows.results.length) { parts.push(''); continue; }

    const first = rows.results[0];
    if (!first) { parts.push(''); continue; }
    const columns = Object.keys(first);
    const columnList = columns.map((c) => `"${c}"`).join(', ');
    for (const row of rows.results) {
      parts.push(`INSERT INTO "${table.name}" (${columnList}) VALUES (${
        columns.map((c) => quote(row[c])).join(', ')});`);
    }
    parts.push('');
  }

  // الفهارس والمشغّلات بعد البيانات: بناء الفهرس مرة واحدة على جدول ممتلئ
  // أرخص من تحديثه مع كل إدراج.
  const rest = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view')
       AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  ).all<{ sql: string }>();
  for (const row of rest.results) parts.push(`${row.sql};`);

  return parts.join('\n');
}

/** يحذف ما زاد عن `KEEP` نسخة لهذه القاعدة. */
async function prune(bucket: R2Bucket, name: string): Promise<number> {
  // المفاتيح مؤرَّخة بـISO فترتيبها المعجمي هو ترتيبها الزمني.
  const listed = await bucket.list({ prefix: `d1/${name}/` });
  const keys = listed.objects.map((o) => o.key).sort();
  const stale = keys.slice(0, Math.max(0, keys.length - KEEP));
  for (const key of stale) await bucket.delete(key);
  return stale.length;
}

export type BackupOutcome = {
  name: string; ok: boolean; bytes?: number; key?: string; pruned?: number; error?: string;
};

/**
 * ينسخ كل قاعدة على حدة.
 *
 * فشل قاعدة لا يمنع البقية: نسخة ثلاث قواعد من أربع أفضل من لا شيء، والقاعدة
 * الفاشلة تظهر في السجل باسمها.
 */
export async function runBackup(targets: BackupTarget[], bucket: R2Bucket): Promise<BackupOutcome[]> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results: BackupOutcome[] = [];

  for (const target of targets) {
    try {
      const sql = await dumpDatabase(target.db);
      const key = `d1/${target.name}/${stamp}.sql`;
      const body = new TextEncoder().encode(sql);
      await bucket.put(key, body, {
        httpMetadata: { contentType: 'application/sql; charset=utf-8' },
        customMetadata: { database: target.name, takenAt: new Date().toISOString() },
      });
      const pruned = await prune(bucket, target.name);
      results.push({ name: target.name, ok: true, bytes: body.byteLength, key, pruned });
    } catch (error: unknown) {
      results.push({ name: target.name, ok: false, error: String(error) });
    }
  }

  return results;
}

/** القواعد المربوطة، متجاهلًا ما لم يُربط بعد. */
export function backupTargets(env: Env): BackupTarget[] {
  const all: Array<[string, D1Database | undefined]> = [
    ['athar-console', env.DB],
    ['restaurant-db', (env as unknown as Record<string, D1Database>).BACKUP_RESTAURANT],
    ['school-db', (env as unknown as Record<string, D1Database>).BACKUP_SCHOOL],
    ['pharma-db', (env as unknown as Record<string, D1Database>).BACKUP_PHARMA],
  ];
  return all.filter((entry): entry is [string, D1Database] => Boolean(entry[1]))
    .map(([name, db]) => ({ name, db }));
}
