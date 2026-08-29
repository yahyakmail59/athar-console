/**
 * دفع التجارب الحيّة إلى موقع أثر.
 *
 * النسخ التجريبية تُنشأ هنا وتُؤرشَف هنا، فقائمتها في الموقع يجب أن تُشتقّ
 * منها لا أن تُكتب بجانبها: قائمتان تُحرَّران يدويًا تفترقان في أول تغيير،
 * فيبقى رابط تجربة مؤرشفة معلنًا للزوار.
 *
 * الدفع استبدال كامل: ما لا يُرسَل لم يعد تجربة. هذا يجعل العملية عديمة
 * الأثر عند التكرار، ويجعل الأرشفة تُخفي الرابط بلا خطوة ثانية تُنسى.
 */

export type ShowcaseItem = {
  id: string;
  product_id: string;
  title_ar: string;
  title_en: string;
  summary_ar: string;
  summary_en: string;
  url: string;
  /** بيانات دخول التجربة — تُعرض علنًا، فلا تكون إلا لنسخة تجريبية. */
  login_user: string;
  login_pass: string;
  /** ماذا يجرّب الزائر بعد أن يدخل. الوصف العامّ لا يقول له شيئًا. */
  hint_ar: string;
  /** صورة معاينة اختيارية. بلا صورة تُرسم معاينة مصمَّمة بهوية المنتج. */
  image_url: string;
};

export type ShowcasePush = (items: ShowcaseItem[]) => Promise<{ stored: number }>;

/**
 * التجارب المؤهَّلة للعرض: **مُختارة صراحةً**، تجريبية، نشطة، ولها رابط عام.
 *
 * الشروط في الاستعلام لا في الترشيح بعده: شرط منسيّ عند العرض ينشر ما لم
 * يُقصد نشره، وهنا المنشور يراه كل زائر.
 *
 * وأُضيفت `is_showcase` بعد أن نشر الشرطُ الضمنيّ ثمانيةَ مستأجرين دفعةً
 * واحدة — فيهم أسماء تبدو أسماء زبائن حقيقيين وروابط دخولهم معلنة. الوضع
 * التجريبي حالةُ تشغيل لا قرارَ عرض؛ فُصل القراران.
 */
export async function eligibleDemos(db: D1Database): Promise<ShowcaseItem[]> {
  const rows = await db.prepare(
    `SELECT t.id, t.product_id, t.display_name, t.short_name, t.public_url,
            t.demo_username, t.demo_password, t.demo_hint, t.demo_image, p.name_ar AS product_name
     FROM tenants t
     JOIN products p ON p.id = t.product_id
     WHERE t.is_showcase = 1
       AND t.environment = 'demo'
       AND t.status = 'active'
       AND t.public_url <> ''
     ORDER BY p.name_ar ASC, t.created_at ASC`,
  ).all<{
    id: string; product_id: string; display_name: string;
    short_name: string | null; public_url: string; product_name: string;
    demo_username: string | null; demo_password: string | null;
    demo_hint: string | null; demo_image: string | null;
  }>();

  return (rows.results ?? [])
    // https وحده: الموقع يُخدم عليه، ورابط http يُحجب في المتصفح فيبدو
    // كأن التجربة معطّلة.
    .filter((row) => /^https:\/\//.test(row.public_url))
    .map((row) => ({
      id: row.id,
      product_id: row.product_id,
      title_ar: row.display_name,
      title_en: row.short_name || row.display_name,
      summary_ar: `نظام ${row.product_name} — نسخة تعمل الآن، افتحها وجرّبها.`,
      summary_en: `A live ${row.product_name} system you can open and try right now.`,
      url: row.public_url,
      login_user: row.demo_username ?? '',
      login_pass: row.demo_password ?? '',
      hint_ar: row.demo_hint ?? '',
      image_url: row.demo_image ?? '',
    }));
}

/** يجمع المؤهَّل ويدفعه. القناة تُمرَّر لتُختبر القائمة بلا شبكة. */
export async function syncShowcase(
  env: { DB: D1Database },
  push: ShowcasePush,
): Promise<{ sent: number; stored: number }> {
  const items = await eligibleDemos(env.DB);
  const result = await push(items);
  return { sent: items.length, stored: result.stored };
}
