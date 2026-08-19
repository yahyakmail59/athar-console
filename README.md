# لوحة أثر المركزية — V2

لوحة Cloudflare Worker + D1 لإدارة سجل منصة أثر التجاري من مكان واحد. تحفظ المنتجات والباقات والعملاء ومساحات التشغيل والاشتراكات والدفعات وحالات الإيقاف وسجل العمليات.

هذه النسخة هي **Control Plane** فقط: إنشاء عميل يسجله كـ`draft`. إنشاء الصيدلية فعليًا داخل محرك Pharma Gaza سيأتي عبر Product Adapter في المرحلة التالية.

## ما أصبح متاحًا

- تسجيل دخول مالك بجلسة موقعة وCookie محمية وCSRF.
- إبطاء وقفل تدريجي لمحاولات الدخول الفاشلة.
- منتجات مستقلة: المطاعم، المدارس، الصيدليات، عيادات الأسنان.
- باقتان للمطاعم والمدارس، وباقة واحدة للصيدليات والعيادات.
- نسخ `demo` و`production` من نفس السجل والمحرك المستقبلي.
- حزم هوية قابلة للربط بالعميل.
- تغيير الباقة والسعر الافتراضي.
- تسجيل الدفعات وفترة الاشتراك.
- إيقاف واستئناف وأرشفة بدل الحذف المباشر.
- سجل تدقيق للإجراءات الإدارية.
- واجهة عربية RTL متجاوبة بلا مكتبات واجهة خارجية.

## التشغيل المحلي

المتطلبات: Node.js حديث وحساب Cloudflare عند الانتقال إلى النشر.

```powershell
npm install
npm run db:migrate:local
Copy-Item .dev.vars.example .dev.vars
```

ولّد تجزئة كلمة المرور (12 حرفًا على الأقل):

```powershell
node scripts/generate-password-hash.mjs "ضع-كلمة-مرور-طويلة-هنا"
```

ضع الناتج بعد `ADMIN_PASSWORD_HASH=` داخل `.dev.vars`. ولّد `SESSION_SECRET` عشوائيًا بطول 24 حرفًا على الأقل، ثم:

```powershell
npm run dev
```

ملف `.dev.vars` مستبعد من Git ولا يجوز رفعه أو مشاركة قيمه.

## فحوص الجودة

```powershell
npm run check
npm test
npm run db:migrate:local
npm run deploy:check
```

تغطي الاختبارات الحالية التحقق من المعرّفات والنصوص والتواريخ والمبالغ، إضافة إلى فحص مستقل لترحيلات SQLite/D1 والاستيراد القديم:

```powershell
python tests/validate_migrations.py
```

## قاعدة البيانات

- `0001_legacy_baseline.sql`: يثبت جداول النسخة القديمة إن لم تكن موجودة.
- `0002_control_plane_v2.sql`: ينشئ النموذج الجديد ويستورد سجلات النسخة القديمة دون حذفها.

أهم الجداول: `products`, `plans`, `customers`, `tenants`, `subscriptions`, `subscription_payments`, `brand_kits`, `domains`, `provisioning_jobs`, `audit_logs`.

لا تعدّل ترحيلًا طُبق سابقًا. أي تغيير جديد يُضاف في ملف migration جديد.

## واجهات الإدارة الحالية

- `POST /api/login`
- `GET /api/session`
- `POST /api/logout`
- `GET /api/dashboard`
- `POST /api/tenants`
- `POST /api/tenants/:id/retry-provision`
- `PATCH /api/tenants/:id/plan`
- `POST /api/tenants/:id/lifecycle`
- `GET /api/tenants/:id/payments`
- `POST /api/payments`
- `PATCH /api/plans/:id`
- `GET /api/audit`
- `GET /api/health`

كل طلب تعديل بعد تسجيل الدخول يحتاج `X-CSRF-Token`. لا تُستخدم هذه الواجهات من محرك منتج مباشرة؛ عقد Product Adapter في المرحلة التالية سيكون منفصلًا وموقعًا وقابلًا لإعادة المحاولة.

## النشر لاحقًا

لم تُنشر V2 بعد. عند اعتماد الخطوة:

```powershell
npx wrangler login
npx wrangler d1 migrations apply athar-console --remote --config wrangler.jsonc
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
npx wrangler deploy --config wrangler.jsonc
```

ابدأ على رابط `workers.dev` دون شراء نطاق. يمكن إضافة نطاق مدفوع أو Cloudflare Access لاحقًا، لكنهما ليسا شرطًا لبدء التجربة.

## الملفات القديمة

`worker.js`, `schema.sql`, و`wrangler.toml` بقيت مؤقتًا كمرجع للنسخة V1. التشغيل الحالي يستخدم `src/index.ts`, مجلد `migrations/`, و`wrangler.jsonc`. لا تحذف الملفات القديمة قبل مقارنة البيانات البعيدة وأخذ نسخة احتياطية موثقة.

## ربط Pharma Gaza

أصبح منتج الصيدليات مربوطًا بلوحة أثر عبر Product Adapter موقّع:

- إنشاء نسخة تجريبية مع أدوية ودفعات وزبون تجريبي.
- إنشاء نسخة حقيقية نظيفة.
- إظهار رمز الصيدلية ورقم المالك مرة واحدة بعد الإنشاء.
- إيقاف الصيدلية واستئنافها وأرشفتها من لوحة أثر.
- إعادة محاولة الإنشاء بنفس المعرّف لمنع التكرار عند انقطاع الاتصال.
- حفظ نتيجة العملية الآمنة في `provisioning_jobs` دون حفظ الرقم السري.

لتشغيل اللوحة ومحرك الصيدليات معًا محليًا:

```powershell
npm run db:migrate:local
npm run dev
```

يهيئ `predev` قاعدة Pharma تلقائيًا داخل مخزن D1 المحلي المشترك لجلسة العاملين. ثم افتح `http://127.0.0.1:8787`. ملفا `.dev.vars` و`.dev.vars.adapter` محليان ومهملان من Git. عند النشر اضبط السر نفسه باسم `ATHAR_ADAPTER_SECRET` في الخدمتين، ولا تستخدم القيمة المحلية التجريبية في الإنتاج.

عقد الربط الكامل موجود في `../PRODUCT_ADAPTER_CONTRACT.md`. لم تُطبق أي ترحيلات بعيدة ولم يتم نشر هذه المرحلة بعد.
