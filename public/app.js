const state = {
  csrf: '',
  dashboard: null,
  view: 'overview',
  layout: 'grid',
  archived: [],
  purge: { tenant: null, checksum: '' },
  leads: [],
  report: null,
  limits: null,
};

const byId = (id) => document.getElementById(id);
const loginView = byId('login-view');
const appView = byId('app-view');

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value ?? '';
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'attrs') for (const [name, attr] of Object.entries(value)) node.setAttribute(name, attr);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node[key] = value;
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function showToast(message, error = false) {
  const toast = element('div', { className: `toast${error ? ' is-error' : ''}`, text: message });
  byId('toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

/**
 * تأكيد بنافذة اللوحة نفسها لا بنافذة النظام.
 *
 * `window.confirm` تُوقف الصفحة، ولا تتبع اتجاهها ولا خطّها، وتظهر باسم
 * المضيف فوقها — فتبدو وسط لوحة مصمَّمة كأنها عطل لا حماية. وهي أيضًا
 * تختلف شكلًا بين متصفّح وآخر، فما يراه صاحب اللوحة ليس ما نصمّمه.
 */
function confirmAction({ title, message, okLabel = 'تأكيد', danger = false }) {
  return new Promise((resolve) => {
    const dialog = byId('confirm-dialog');
    byId('confirm-title').textContent = title;
    byId('confirm-message').textContent = message;
    const ok = byId('confirm-ok');
    ok.textContent = okLabel;
    ok.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      ok.removeEventListener('click', onOk);
      byId('confirm-cancel').removeEventListener('click', onCancel);
      dialog.close();
      resolve(value);
    };
    // الإغلاق بمفتاح الهروب أو بزرّ × يعني «لا»: صمتٌ لا يُقرأ موافقةً.
    function onClose() { finish(false); }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    dialog.addEventListener('close', onClose);
    ok.addEventListener('click', onOk);
    byId('confirm-cancel').addEventListener('click', onCancel);
    dialog.showModal();
  });
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(method) && state.csrf) headers.set('X-CSRF-Token', state.csrf);
  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') showLogin();
    throw new Error(payload.error || 'تعذر إكمال العملية. حاول مرة أخرى.');
  }
  return payload;
}

function showLogin() {
  state.csrf = '';
  state.dashboard = null;
  appView.hidden = true;
  loginView.hidden = false;
  byId('password').focus();
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
}

function money(minor, currency = 'USD') {
  const amount = Number(minor || 0) / 100;
  try {
    return new Intl.NumberFormat('ar', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function dateText(value) {
  if (!value) return '—';
  const date = new Date(String(value).length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat('ar', { dateStyle: 'medium' }).format(date);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addMonths(dateString, months) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

const statusLabels = {
  draft: 'مسودة', active: 'نشط', suspended: 'موقوف', archived: 'مؤرشف',
  provisioning: 'قيد الإنشاء', failed: 'فشل الإنشاء', trialing: 'تجريبي',
  past_due: 'متأخر', grace: 'مهلة', cancelled: 'ملغي', demo: 'تجريبية', production: 'حقيقية',
};

const actionLabels = {
  'tenant.register': 'تسجيل عميل', 'tenant.plan_changed': 'تغيير الباقة',
  'tenant.suspend': 'إيقاف عميل', 'tenant.resume': 'استئناف عميل',
  'tenant.archive': 'أرشفة عميل', 'tenant.restore': 'استعادة من الأرشيف',
  'payment.record': 'تسجيل دفعة', 'plan.update': 'تعديل باقة',
  'customer.update': 'تعديل بيانات عميل', 'tenant.exported': 'تنزيل نسخة احتياطية',
  'tenant.owner_pin_reset': 'رقم سري جديد للمالك', 'tenant.owner_pin_reset_failed': 'فشل إصدار رقم سري',
  'tenant.purge_started': 'بدء حذف نهائي', 'tenant.purged': 'حذف نهائي',
  'tenant.purge_failed': 'فشل الحذف النهائي', 'tenant.engine_missing': 'مساحة مفقودة في المحرك',
  'tenant.provisioned': 'إنشاء مساحة في المحرك', 'tenant.provision_failed': 'فشل إنشاء المساحة',
  'tenant.provision_retried': 'إعادة إنشاء ناجحة', 'tenant.provision_retry_failed': 'فشل إعادة الإنشاء',
};

// المنتجات التي يدخل مستخدمها باسم. الصيدلية ليست منها: تدخل برمزها ورقم
// سري بلا اسم، فحقل الاسم لها حقل بلا أثر — والأسوأ من غيابه أن يظهر ثم
// لا يفعل شيئًا.
const PRODUCTS_WITH_USERNAME = new Set(['school', 'restaurant', 'clinic']);
let createSchoolLogoDataUrl = '';

// وصف كل هوية للعرض وحده عند الاختيار؛ القيم الفعلية (الألوان والخطوط) لا
// تعيش هنا بل في `athar-restaurant/worker/brandkits.js` — هذا نص توضيحي
// يطابقها يدويًا، والرمز نفسه (`code`) هو ما يصل فعليًا للمحرك.
const RESTAURANT_BRAND_KIT_INFO = {
  adana_classic: { description: 'أحمر وذهبي، Cairo وBebas Neue.', swatch: '#E30613' },
  luxury_navy: { description: 'كحلي وذهبي مع طبقة فاخرة إضافية، Playfair Display.', swatch: '#0B1D2D' },
  vibrant_emerald: { description: 'زمردي حيوي، Tajawal وOswald.', swatch: '#0F9D6B' },
  warm_amber: { description: 'كهرماني دافئ، Almarai وAnton.', swatch: '#C2540A' },
};

/** أيقونة المنتج من المجموعة المضمّنة: رمزٌ لكل معنى، لا معنيان لرمز. */
function productIcon(productId) {
  const known = ['restaurant', 'school', 'pharmacy', 'clinic'];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${known.includes(productId) ? productId : 'clients'}`);
  svg.append(use);
  return svg;
}

function badge(value) {
  return element('span', { className: `badge badge-${value}`, text: statusLabels[value] || value || '—' });
}

function productById(id) {
  return state.dashboard?.catalog.products.find((item) => item.id === id);
}

function plansFor(productId) {
  return (state.dashboard?.catalog.plans || []).filter((plan) => plan.product_id === productId && Number(plan.is_active) === 1);
}

function tenantById(id) {
  return state.dashboard?.tenants.find((tenant) => tenant.id === id);
}

function button(label, className, action, id) {
  return element('button', { className: `button button-small ${className}`, text: label, type: 'button', dataset: { action, id } });
}

function emptyState(title, description, includeButton = false) {
  const children = [element('strong', { text: title }), element('p', { className: 'muted', text: description })];
  if (includeButton) children.push(element('button', { className: 'button button-primary', text: 'إنشاء عميل', type: 'button', onClick: openCreateDialog }));
  return element('div', { className: 'empty-state' }, children);
}

function clientActions(tenant) {
  const actions = element('div', { className: 'client-actions' });
  actions.append(button('دفعة', 'button-primary', 'payment', tenant.id));
  actions.append(button('الباقة', 'button-secondary', 'plan', tenant.id));
  actions.append(button('تعديل البيانات', 'button-secondary', 'edit', tenant.id));
  actions.append(button('السجل المالي', 'button-quiet', 'history', tenant.id));
  actions.append(button(
    Number(tenant.auto_suspend) ? 'إلغاء الإيقاف التلقائي' : 'تفعيل الإيقاف التلقائي',
    'button-quiet', 'auto-suspend', tenant.id,
  ));
  if (tenant.external_tenant_id) {
    actions.append(button('فحص الصحة', 'button-quiet', 'health', tenant.id));
    actions.append(button('بيانات دخول جديدة', 'button-quiet', 'reset-pin', tenant.id));
  }
  if (tenant.status === 'active') actions.append(button('إيقاف', 'button-danger', 'suspend', tenant.id));
  if (tenant.status === 'suspended') actions.append(button('استئناف', 'button-secondary', 'resume', tenant.id));
  if (tenant.status === 'failed' && tenant.product_id === 'pharmacy') actions.append(button('إعادة الإنشاء', 'button-secondary', 'retry', tenant.id));
  actions.append(button('أرشفة', 'button-quiet', 'archive', tenant.id));
  return actions;
}

function clientCard(tenant) {
  const header = element('div', { className: 'client-card-header' }, [
    element('div', { className: 'product-icon' }, productIcon(tenant.product_id)),
    element('div', { className: 'client-title' }, [
      element('h3', { text: tenant.display_name }),
      element('p', { text: `${tenant.product_name} · ${tenant.slug}` }),
    ]),
  ]);
  const badges = element('div', { className: 'badges' }, [badge(tenant.status), badge(tenant.environment), badge(tenant.subscription_status)]);
  const details = element('div', { className: 'client-details' }, [
    detail('الباقة', tenant.plan_name), detail('السعر', money(tenant.price_minor, tenant.currency)),
    detail('مدفوع حتى', dateText(tenant.current_period_end)), detail('الرابط', tenant.public_url || 'بانتظار ربط المحرك'),
    detail('صحة المحرك', healthText(tenant)),
    // الحالة تُعرض دائمًا لا عند التفعيل فقط: «مطفأ» معلومة يحتاجها المشغّل
    // بقدر «مفعّل» — بها يعرف أن هذا العميل لن يتوقف مهما تأخر.
    detail('الإيقاف عند عدم الدفع', autoSuspendText(tenant)),
  ]);
  // تاريخ انتهاء التجربة كان يُحفظ ولا يُعرض. إظهاره هنا يجعل الحقل مفيدًا
  // للمشغّل: يعرف أي عرض قارب على الانتهاء دون فتح كل عميل.
  if (tenant.environment === 'demo' && tenant.trial_expires_at) {
    details.append(detail('تنتهي التجربة', trialText(tenant.trial_expires_at)));
  }
  return element('article', { className: 'client-card' }, [header, badges, details, clientActions(tenant)]);
}

/**
 * حالة الإيقاف التلقائي بالنصّ لا بعلامة صحّ.
 *
 * ومع المهلة صراحةً: «تلقائي بعد 3 أيام» تشرح ما سيحدث، بينما «مفعّل» تترك
 * المشغّل يخمّن هل يتوقف العميل فورًا أم بعد مدة.
 */
function autoSuspendText(tenant) {
  if (!Number(tenant.auto_suspend)) return 'مطفأ — لن يتوقف تلقائيًا';
  if (tenant.grace_ends_at) return `مفعّل — المهلة تنتهي ${dateText(tenant.grace_ends_at)}`;
  return 'مفعّل — تلقائي بعد 3 أيام من انتهاء الفترة';
}

const healthLabels = { healthy: 'سليم', degraded: 'متوقف داخل المحرك', unreachable: 'تعذر الوصول', unknown: 'لم يُفحص' };

function healthText(tenant) {
  const label = healthLabels[tenant.last_health_status] || 'لم يُفحص';
  return tenant.last_health_at ? `${label} · ${dateText(tenant.last_health_at)}` : label;
}

/** يوضّح قرب الانتهاء بالنص لا باللون وحده. */
function trialText(value) {
  const days = Math.ceil((new Date(`${String(value).slice(0, 10)}T00:00:00Z`) - Date.now()) / 86400000);
  if (Number.isNaN(days)) return dateText(value);
  if (days < 0) return `${dateText(value)} — انتهت`;
  if (days === 0) return `${dateText(value)} — تنتهي اليوم`;
  if (days <= 7) return `${dateText(value)} — بقي ${days} يومًا`;
  return dateText(value);
}

function detail(label, value) {
  return element('div', {}, [element('small', { text: label }), element('strong', { text: value || '—', title: value || '' })]);
}

/**
 * شاشة «العملاء» للنسخ الحقيقية وحدها.
 *
 * النسخة التجريبية ليست عميلًا بعد — هي عرضٌ قيد التجربة. وخلطُ الاثنين في
 * قائمة واحدة يجعل «كم عميلًا عندي؟» سؤالًا بلا جواب: العدد يشمل من لم
 * يدفع. التجريبية تظهر مع المحتملين، وتنتقل إلى هنا حين تصير حقيقية.
 */
function filteredTenants() {
  const query = byId('client-search').value.trim().toLowerCase();
  const product = byId('product-filter').value;
  const status = byId('status-filter').value;
  return (state.dashboard?.tenants || []).filter((tenant) => {
    if (tenant.environment !== 'production') return false;
    const haystack = [tenant.display_name, tenant.slug, tenant.phone, tenant.email, tenant.product_name].join(' ').toLowerCase();
    return (!query || haystack.includes(query)) && (!product || tenant.product_id === product) &&
      (!status || tenant.status === status);
  });
}

/** النسخ التجريبية: عروضٌ قيد التجربة، تُعرض مع المحتملين لا مع العملاء. */
function demoTenants() {
  return (state.dashboard?.tenants || []).filter((tenant) => tenant.environment === 'demo');
}

function renderClientTable(tenants) {
  const table = element('table');
  table.append(element('thead', {}, element('tr', {}, ['العميل', 'المنتج', 'النسخة', 'الحالة', 'الباقة', 'السعر', 'إجراءات'].map((label) => element('th', { text: label })))));
  const tbody = element('tbody');
  for (const tenant of tenants) {
    const actions = element('div', { className: 'table-actions' }, [
      button('دفعة', 'button-primary', 'payment', tenant.id), button('الباقة', 'button-secondary', 'plan', tenant.id),
      button('⋯', 'button-quiet', 'history', tenant.id),
    ]);
    if (tenant.status === 'failed' && tenant.product_id === 'pharmacy') {
      actions.prepend(button('إعادة', 'button-secondary', 'retry', tenant.id));
    }
    tbody.append(element('tr', {}, [
      element('td', {}, [element('strong', { text: tenant.display_name }), element('small', { className: 'muted', text: ` · ${tenant.slug}` })]),
      element('td', { text: tenant.product_name }), element('td', {}, badge(tenant.environment)),
      element('td', {}, badge(tenant.status)), element('td', { text: tenant.plan_name }),
      element('td', { text: money(tenant.price_minor, tenant.currency) }), element('td', {}, actions),
    ]));
  }
  table.append(tbody);
  return element('div', { className: 'clients-table' }, element('div', { className: 'table-scroll' }, table));
}

function renderClients() {
  const tenants = filteredTenants();
  const production = (state.dashboard?.tenants || []).filter((t) => t.environment === 'production').length;
  byId('client-count').textContent = `${tenants.length} من ${production} عميل حقيقي`;
  const container = byId('clients-container');
  container.replaceChildren();
  if (!tenants.length) {
    const demos = demoTenants().length;
    return container.append(emptyState('لا عملاء حقيقيون هنا',
      demos ? `عندك ${demos} نسخة تجريبية في «العملاء المحتملون». حوّل النسخة إلى حقيقية حين يدفع صاحبها.`
        : 'غيّر البحث أو عوامل التصفية، أو أنشئ عميلًا جديدًا.',
      !state.dashboard?.tenants.length));
  }
  if (state.layout === 'table') return container.append(renderClientTable(tenants));
  for (const tenant of tenants) container.append(clientCard(tenant));
}

/** شارة العدد غير المقروء: العميل المحتمل يفقد قيمته بالتأخير، فيجب أن يُرى بلا فتح تبويب. */
function renderLeadsBadge() {
  const badge = byId('leads-badge');
  const count = Number(state.dashboard?.unreadLeads || 0);
  // الشارة للرسائل غير المقروءة وحدها: التجريبية معروفة لصاحبها لأنه أنشأها،
  // ورقمٌ يشملها يجعل الشارة دائمة فتُهمَل.

  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = count === 0;
}

function renderMetrics() {
  const metrics = state.dashboard.metrics || {};
  const cards = [
    ['العملاء الحقيقيون', Number(metrics.real_total || 0).toLocaleString('ar'), 'نسخ مدفوعة غير مؤرشفة'],
    ['منهم يعمل الآن', Number(metrics.real_active || 0).toLocaleString('ar'), 'غير موقوف ولا مسودة'],
    ['نسخ تجريبية', Number(metrics.demos || 0).toLocaleString('ar'), 'احتمالات بيع لم تُغلَق'],
    ['دفعات تحتاج متابعة', Number(metrics.due || 0).toLocaleString('ar'), 'متأخرة أو في المهلة'],
    ['الإيراد الشهري', money(metrics.monthly_minor || 0, 'USD'), 'تقدير الاشتراكات النشطة'],
  ];
  byId('metrics-grid').replaceChildren(...cards.map(([label, value, hint]) => element('article', { className: 'metric-card' }, [
    element('span', { className: 'metric-label', text: label }), element('strong', { className: 'metric-value', text: value }), element('span', { className: 'metric-hint', text: hint }),
  ])));
}

function renderRecent() {
  const container = byId('recent-clients');
  container.replaceChildren();
  const tenants = state.dashboard.tenants.slice(0, 6);
  if (!tenants.length) return container.append(emptyState('ابدأ بأول عميل', 'أنشئ نسخة تجريبية أو حقيقية وسجّل باقتها وبياناتها.', true));
  for (const tenant of tenants) container.append(clientCard(tenant));
}

function renderPlans() {
  const container = byId('plans-container');
  container.replaceChildren();
  for (const plan of state.dashboard.catalog.plans) {
    const product = productById(plan.product_id);
    const priceInput = element('input', { type: 'number', min: '0', step: '.01', value: Number(plan.default_price_minor || 0) / 100, attrs: { 'aria-label': `سعر ${plan.name_ar}` } });
    const save = element('button', { className: 'button button-primary button-small', text: 'حفظ السعر', type: 'button' });
    save.addEventListener('click', () => updatePlanPrice(plan, priceInput, save));
    const activeLabel = Number(plan.is_active) ? badge('active') : element('span', { className: 'badge', text: 'غير مفعلة' });
    container.append(element('article', { className: 'plan-card' }, [
      element('div', { className: 'plan-card-top' }, [element('div', {}, [element('p', { className: 'eyebrow', text: product?.name_ar || plan.product_id }), element('h3', { text: plan.name_ar })]), activeLabel]),
      element('p', { className: 'muted', text: plan.description_ar || 'يمكن تعديل وصف الباقة لاحقًا.' }),
      element('div', { className: 'plan-price' }, [element('small', { text: plan.billing_cycle === 'yearly' ? 'السعر السنوي الافتراضي' : 'السعر الشهري الافتراضي' }), element('strong', { text: money(plan.default_price_minor, plan.currency) })]),
      element('div', { className: 'plan-edit' }, [priceInput, save]),
    ]));
  }
}

async function updatePlanPrice(plan, input, saveButton) {
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) return showToast('أدخل سعرًا صحيحًا.', true);
  saveButton.disabled = true;
  try {
    await api(`/api/plans/${encodeURIComponent(plan.id)}`, { method: 'PATCH', body: JSON.stringify({ default_price_minor: Math.round(value * 100) }) });
    showToast('تم تحديث سعر الباقة.');
    await loadDashboard();
  } catch (error) { showToast(error.message, true); }
  finally { saveButton.disabled = false; }
}

function renderAudit(rows = state.dashboard.recentAudit || []) {
  const body = byId('audit-body');
  body.replaceChildren();
  if (!rows.length) {
    body.append(element('tr', {}, element('td', { text: 'لا توجد عمليات مسجلة بعد.', attrs: { colspan: '4' } })));
    return;
  }
  for (const row of rows) body.append(element('tr', {}, [
    element('td', { text: actionLabels[row.action] || row.action }), element('td', { text: row.entity_type }),
    element('td', { text: row.entity_id || '—', attrs: { dir: 'ltr' } }), element('td', { text: dateText(row.created_at) }),
  ]));
}

function fillCatalogControls() {
  const products = state.dashboard.catalog.products;
  const productFilter = byId('product-filter');
  const currentFilter = productFilter.value;
  productFilter.replaceChildren(element('option', { value: '', text: 'كل المنتجات' }));
  for (const product of products) productFilter.append(element('option', { value: product.id, text: product.name_ar }));
  productFilter.value = currentFilter;

  const createProduct = byId('create-product');
  createProduct.replaceChildren(...products.map((product) => element('option', { value: product.id, text: product.name_ar })));
  updateCreateOptions();
}

function updateCreateOptions() {
  const productId = byId('create-product').value;
  const planSelect = byId('create-plan');
  const previousPlan = planSelect.value;
  planSelect.replaceChildren(...plansFor(productId).map((plan) => element('option', { value: plan.id, text: `${plan.name_ar} — ${money(plan.default_price_minor, plan.currency)}` })));
  if ([...planSelect.options].some((option) => option.value === previousPlan)) planSelect.value = previousPlan;
  // اسم مستخدم المدير يظهر للمنتجات التي تستخدم أسماء مستخدمين. الصيدلية
  // تدخل برمزها ورقم سري بلا اسم، فإظهاره لها حقل بلا أثر.
  document.querySelectorAll('.username-only').forEach((field) => {
    field.hidden = !PRODUCTS_WITH_USERNAME.has(productId);
  });
  // اسم الطبيب يظهر للعيادات وحدها: التحية في لوحة العيادة تناديه باسمه،
  // وبلا هذا الحقل تناديه باسم عيادته.
  document.querySelectorAll('.clinic-only').forEach((field) => {
    field.hidden = productId !== 'clinic';
  });
  byId('school-logo-field').hidden = productId !== 'school';
  // حزمة الهوية: محرك المطاعم يقرؤها فعلًا الآن ويطبّقها عند الإنشاء، فتظهر
  // لهذا المنتج وحده — حقل بلا أثر لبقية المنتجات لا يزال يُخفى.
  const brandKitField = byId('restaurant-brand-kit-field');
  brandKitField.hidden = productId !== 'restaurant';
  if (productId !== 'restaurant') {
    // القيمة تبقى في DOM بعد التبديل بعيدًا عن المطاعم؛ لو تُركت كانت
    // تُرسَل ضمن FormData مع منتج آخر فيرفضها التحقق في اللوحة بلا سبب
    // ظاهر لمن يملأ النموذج — الحقل هنا لا يخصّ إلا المطاعم.
    byId('create-brand-kit').replaceChildren();
    byId('brand-kit-description').textContent = '';
  } else {
    const brandKitSelect = byId('create-brand-kit');
    const kits = (state.dashboard.catalog.brandKits || []).filter((kit) => kit.product_id === 'restaurant');
    const previousKit = brandKitSelect.value;
    brandKitSelect.replaceChildren(...kits.map((kit) => element('option', { value: kit.id, text: kit.name })));
    if ([...brandKitSelect.options].some((option) => option.value === previousKit)) brandKitSelect.value = previousKit;
    const updateBrandKitDescription = () => {
      const code = brandKitSelect.value.split(':').pop();
      byId('brand-kit-description').textContent = RESTAURANT_BRAND_KIT_INFO[code]?.description || '';
    };
    brandKitSelect.onchange = updateBrandKitDescription;
    updateBrandKitDescription();
  }
  const chosen = state.dashboard.catalog.plans.find((plan) => plan.id === planSelect.value);
  byId('create-form').elements.price.value = chosen ? Number(chosen.default_price_minor) / 100 : '';
}

function renderAll() {
  renderMetrics();
  renderRecent();
  fillCatalogControls();
  renderClients();
  renderPlans();
  renderAudit();
  renderLeadsBadge();
}

async function loadDashboard(quiet = false) {
  const refresh = byId('refresh-button');
  refresh.disabled = true;
  try {
    state.dashboard = await api('/api/dashboard');
    renderAll();
    if (!quiet) showToast('تم تحديث بيانات اللوحة.');
  } finally { refresh.disabled = false; }
}

function setView(view) {
  state.view = view;
  const titles = { overview: ['مساحة العمل', 'نظرة عامة'], clients: ['إدارة المساحات', 'العملاء'], plans: ['الكتالوج التجاري', 'الباقات والأسعار'], leads: ['من نموذج التواصل', 'العملاء المحتملون'], reports: ['المال والتجديدات', 'التقارير'], archive: ['العملاء المؤرشفون', 'الأرشيف'], audit: ['المراقبة', 'سجل العمليات'] };
  document.querySelectorAll('.page-view').forEach((section) => { section.hidden = section.id !== `${view}-view`; });
  document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.classList.toggle('is-active', item.dataset.view === view));
  byId('page-kicker').textContent = titles[view][0];
  byId('page-title').textContent = titles[view][1];
  document.body.classList.remove('sidebar-open');
  // رابط نظيف بلا `#`: المسار في العنوان نفسه، فيُنسخ ويُرسل ويُفتح مباشرة.
  const path = view === 'overview' ? '/' : `/${view}`;
  if (window.location.pathname !== path) window.history.pushState(null, '', path);
  if (view === 'archive') void loadArchive(true);
  if (view === 'leads') void loadLeads(true);
  if (view === 'reports') void loadReports(true);
}

function openCreateDialog() {
  const form = byId('create-form');
  form.reset();
  createSchoolLogoDataUrl = '';
  byId('create-school-logo-preview').hidden = true;
  byId('create-school-logo-preview').removeAttribute('src');
  byId('create-error').textContent = '';
  fillCatalogControls();
  form.elements.trial_expires_at.value = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  updateDemoVisibility();
  byId('create-dialog').showModal();
}

function prepareSchoolLogo(file) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file?.type)) return Promise.reject(new Error('اختر صورة بصيغة JPG أو PNG أو WebP.'));
  if (file.size > 3 * 1024 * 1024) return Promise.reject(new Error('حجم شعار المدرسة يجب ألا يتجاوز 3 ميجابايت.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذر قراءة ملف الشعار.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('ملف الشعار غير صالح.'));
      image.onload = () => {
        const maxSide = 320;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('تعذر تجهيز صورة الشعار.'));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        let result = canvas.toDataURL('image/webp', .82);
        if (result.length > 42000) result = canvas.toDataURL('image/jpeg', .78);
        if (result.length > 42000) return reject(new Error('الشعار كبير بعد الضغط. اختر صورة أبسط أو أصغر.'));
        resolve(result);
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

function updateDemoVisibility() {
  const demo = byId('create-form').elements.environment.value === 'demo';
  document.querySelectorAll('.demo-only').forEach((field) => field.hidden = !demo);
}

/**
 * بيانات الدخول تصل بشكل موحّد من كل محرك. القراءة تتحمّل المفاتيح القديمة
 * أيضًا، فلا تنكسر الشاشة أمام العميل لو تأخّر نشر محرك عن اللوحة.
 */
function showProvisionedCredentials(payload) {
  const c = payload.credentials || {};
  const loginId = c.login_id || c.pharmacy_id || c.school_id || '—';
  const secret = c.secret || c.owner_pin || c.admin_password || '—';
  byId('credential-pharmacy').textContent = loginId;
  byId('credential-pin').textContent = secret;
  byId('credential-secret-label').textContent = c.secret_label || 'الرقم السري';
  const userRow = byId('credential-user-row');
  const username = c.username || c.admin_username || '';
  byId('credential-user').textContent = username;
  userRow.hidden = !username || username === 'owner';
  const link = byId('credential-link');
  link.href = payload.public_url || '#';
  link.hidden = !payload.public_url;
  byId('credentials-dialog').showModal();
}

async function submitCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  data.price_minor = Math.round(Number(data.price || 0) * 100);
  delete data.price;
  delete data.school_logo;
  if (data.product_id === 'school' && createSchoolLogoDataUrl) data.school_logo_data_url = createSchoolLogoDataUrl;
  else delete data.school_logo_data_url;
  if (data.environment !== 'demo') delete data.trial_expires_at;
  if (!String(data.admin_username || '').trim()) delete data.admin_username;
  if (data.product_id !== 'clinic' || !String(data.admin_full_name || '').trim()) {
    delete data.admin_full_name;
  }
  submit.disabled = true;
  byId('create-error').textContent = '';
  try {
    const payload = await api('/api/tenants', { method: 'POST', body: JSON.stringify(data) });
    byId('create-dialog').close();
    if (payload.credentials) {
      showProvisionedCredentials(payload);
      showToast('أُنشئت المساحة ورُبطت بلوحة أثر.');
    } else if (payload.provisioning_ok === false) {
      showToast(`سُجل العميل لكن تعذر إنشاء الصيدلية: ${payload.error}`, true);
    } else {
      showToast('تم تسجيل العميل كمسودة حتى ربط محرك المنتج.');
    }
    await loadDashboard(true);
  } catch (error) { byId('create-error').textContent = error.message; }
  finally { submit.disabled = false; }
}

function openPayment(tenant) {
  const form = byId('payment-form');
  form.reset();
  form.elements.tenant_id.value = tenant.id;
  form.elements.amount.value = Number(tenant.price_minor || 0) / 100;
  form.elements.paid_at.value = today();
  form.elements.current_period_end.value = addMonths(today(), tenant.billing_cycle === 'yearly' ? 12 : 1);
  byId('payment-title').textContent = `دفعة: ${tenant.display_name}`;
  byId('payment-error').textContent = '';
  byId('payment-dialog').showModal();
}

async function submitPayment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  data.amount_minor = Math.round(Number(data.amount) * 100);
  delete data.amount;
  submit.disabled = true;
  byId('payment-error').textContent = '';
  try {
    await api('/api/payments', { method: 'POST', body: JSON.stringify(data) });
    byId('payment-dialog').close();
    showToast('تم تسجيل الدفعة وتحديث الاشتراك.');
    await loadDashboard(true);
  } catch (error) { byId('payment-error').textContent = error.message; }
  finally { submit.disabled = false; }
}

function openPlan(tenant) {
  const form = byId('plan-form');
  form.reset();
  form.elements.tenant_id.value = tenant.id;
  const select = form.elements.plan_id;
  select.replaceChildren(...plansFor(tenant.product_id).map((plan) => element('option', { value: plan.id, text: `${plan.name_ar} — ${money(plan.default_price_minor, plan.currency)}` })));
  select.value = tenant.plan_id;
  byId('plan-title').textContent = `باقة: ${tenant.display_name}`;
  byId('plan-error').textContent = '';
  byId('plan-dialog').showModal();
}

async function submitPlan(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const tenantId = form.elements.tenant_id.value;
  const data = { plan_id: form.elements.plan_id.value, preserve_price: form.elements.preserve_price.checked };
  submit.disabled = true;
  byId('plan-error').textContent = '';
  try {
    await api(`/api/tenants/${encodeURIComponent(tenantId)}/plan`, { method: 'PATCH', body: JSON.stringify(data) });
    byId('plan-dialog').close();
    showToast('تم تغيير الباقة.');
    await loadDashboard(true);
  } catch (error) { byId('plan-error').textContent = error.message; }
  finally { submit.disabled = false; }
}

async function showHistory(tenant) {
  byId('history-title').textContent = `دفعات: ${tenant.display_name}`;
  const content = byId('history-content');
  content.replaceChildren(element('p', { className: 'muted', text: 'جارٍ تحميل السجل…' }));
  byId('history-dialog').showModal();
  try {
    const payload = await api(`/api/tenants/${encodeURIComponent(tenant.id)}/payments`);
    if (!payload.payments.length) return content.replaceChildren(emptyState('لا توجد دفعات', 'سجّل أول دفعة لهذا العميل.'));
    const list = element('div', { className: 'history-list' });
    for (const payment of payload.payments) list.append(element('div', { className: 'history-item' }, [
      element('div', {}, [element('strong', { text: money(payment.amount_minor, payment.currency) }), element('p', {}, element('small', { text: payment.reference || payment.method }))]),
      element('small', { text: dateText(payment.paid_at) }),
    ]));
    content.replaceChildren(list);
  } catch (error) { content.replaceChildren(element('p', { className: 'form-error', text: error.message })); }
}

async function lifecycle(tenant, action) {
  const labels = { suspend: 'إيقاف', resume: 'استئناف', archive: 'أرشفة' };
  const extra = action === 'archive' ? ' سيختفي من القائمة ويلغى اشتراكه، مع بقاء السجل في قاعدة البيانات.' : '';
  const agreed = await confirmAction({
    title: `${labels[action]}: ${tenant.display_name}`,
    message: `هل تريد ${labels[action]} هذا العميل؟${extra}`,
    okLabel: labels[action],
    danger: action !== 'resume',
  });
  if (!agreed) return;
  try {
    const payload = await api(`/api/tenants/${encodeURIComponent(tenant.id)}/lifecycle`, { method: 'POST', body: JSON.stringify({ action }) });
    if (payload.engine_missing) {
      showToast(`تم ${labels[action]} السجل، لكن مساحة العميل غير موجودة في المحرك — رُبما حُذفت من خارج أثر.`, true);
    } else {
      showToast(`تم ${labels[action]} العميل.`);
    }
    await loadDashboard(true);
  } catch (error) { showToast(error.message, true); }
}

async function retryProvision(tenant) {
  const agreed = await confirmAction({
    title: `إعادة الإنشاء: ${tenant.display_name}`,
    message: 'يُعاد إنشاء المساحة داخل محرك الصيدليات، وتصدر بيانات دخول جديدة.',
    okLabel: 'إعادة الإنشاء',
  });
  if (!agreed) return;
  try {
    const payload = await api(`/api/tenants/${encodeURIComponent(tenant.id)}/retry-provision`, {
      method: 'POST', body: '{}',
    });
    showProvisionedCredentials(payload);
    showToast('نجحت إعادة إنشاء الصيدلية وربطها بلوحة أثر.');
    await loadDashboard(true);
  } catch (error) { showToast(error.message, true); }
}

async function handleClientAction(event) {
  const target = event.target.closest('[data-action][data-id]');
  if (!target) return;
  const tenant = tenantById(target.dataset.id);
  if (!tenant) return;
  const action = target.dataset.action;
  if (action === 'payment') openPayment(tenant);
  else if (action === 'plan') openPlan(tenant);
  else if (action === 'edit') openCustomerDialog(tenant);
  else if (action === 'health') await checkHealth(tenant);
  else if (action === 'reset-pin') await resetOwnerPin(tenant);
  else if (action === 'history') await showHistory(tenant);
  else if (action === 'retry') await retryProvision(tenant);
  // فرع صريح: ما لا يُذكر هنا يذهب إلى `lifecycle` فيُرفض كإجراء مجهول.
  else if (action === 'auto-suspend') await toggleAutoSuspend(tenant);
  else await lifecycle(tenant, action);
}

/**
 * يفتح أو يغلق الإيقاف التلقائي.
 *
 * التفعيل يستأذن، والإلغاء لا: التفعيل يعني أن برنامجًا سيقطع خدمة عميل بلا
 * حضورك، والإلغاء يعني أن أحدًا لن يُقطع — والثاني لا يحتاج تحذيرًا.
 */
async function toggleAutoSuspend(tenant) {
  const enabling = !Number(tenant.auto_suspend);
  if (enabling) {
    const agreed = await confirmAction({
      title: `تفعيل الإيقاف التلقائي: ${tenant.display_name}`,
      message: 'عند انتهاء فترة الاشتراك تُفتح مهلة ثلاثة أيام تعمل فيها الخدمة كالمعتاد، '
        + 'ثم تتوقف تلقائيًا حتى تسجيل الدفعة.',
      okLabel: 'تفعيل',
      danger: true,
    });
    if (!agreed) return;
  }
  try {
    await api(`/api/tenants/${encodeURIComponent(tenant.id)}/auto-suspend`, {
      method: 'POST', body: JSON.stringify({ enabled: enabling }),
    });
    showToast(enabling ? 'فُعِّل الإيقاف التلقائي.' : 'أُلغي الإيقاف التلقائي.');
    await loadDashboard(true);
  } catch (error) { showToast(error.message, true); }
}

function openCustomerDialog(tenant) {
  const form = byId('customer-form');
  form.reset();
  form.elements.tenant_id.value = tenant.id;
  form.elements.display_name.value = tenant.display_name || '';
  form.elements.short_name.value = tenant.short_name || '';
  // الاسم المختصر يظهر للمنتجات التي تعرضه في واجهتها.
  document.querySelectorAll('.short-name-only').forEach((field) => {
    field.hidden = !PRODUCTS_WITH_USERNAME.has(tenant.product_id);
  });
  form.elements.contact_name.value = tenant.contact_name || '';
  form.elements.phone.value = tenant.phone || '';
  form.elements.email.value = tenant.email || '';
  form.elements.address.value = tenant.address || '';
  form.elements.notes.value = tenant.notes || '';
  byId('customer-title').textContent = `بيانات: ${tenant.display_name}`;
  byId('customer-error').textContent = '';
  byId('customer-dialog').showModal();
}

async function submitCustomer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  const tenantId = data.tenant_id;
  delete data.tenant_id;
  submit.disabled = true;
  byId('customer-error').textContent = '';
  try {
    const payload = await api(`/api/tenants/${encodeURIComponent(tenantId)}/customer`, { method: 'PATCH', body: JSON.stringify(data) });
    byId('customer-dialog').close();
    if (payload.engine_synced === false) {
      showToast('حُفظت البيانات، لكن لم تصل إلى المحرك. افحص الصحة ثم أعد الحفظ.', true);
    } else {
      showToast('تم تحديث بيانات العميل.');
    }
    await loadDashboard(true);
  } catch (error) { byId('customer-error').textContent = error.message; }
  finally { submit.disabled = false; }
}

async function resetOwnerPin(tenant) {
  const agreed = await confirmAction({
    title: `رقم سري جديد: ${tenant.display_name}`,
    message: 'الرقم الحالي يتوقف فورًا، وكل الأجهزة المسجّلة تُخرَج وتحتاج الدخول من جديد. '
      + 'المخزون والفواتير لا تتأثر. والرقم الجديد يظهر مرة واحدة فقط.',
    okLabel: 'إصدار رقم جديد',
    danger: true,
  });
  if (!agreed) return;
  try {
    const payload = await api(`/api/tenants/${encodeURIComponent(tenant.id)}/reset-pin`, { method: 'POST', body: '{}' });
    showProvisionedCredentials(payload);
    showToast('صدر رقم سري جديد. انسخه الآن قبل إغلاق النافذة.');
  } catch (error) { showToast(error.message, true); }
}

async function checkHealth(tenant) {
  try {
    const payload = await api(`/api/tenants/${encodeURIComponent(tenant.id)}/health`, { method: 'POST', body: '{}' });
    showToast(`صحة «${tenant.display_name}»: ${healthLabels[payload.status] || payload.status}`, payload.status === 'unreachable');
    await loadDashboard(true);
  } catch (error) { showToast(error.message, true); }
}

function archiveCard(tenant) {
  const header = element('div', { className: 'client-card-header' }, [
    element('div', { className: 'product-icon' }, productIcon(tenant.product_id)),
    element('div', { className: 'client-title' }, [
      element('h3', { text: tenant.display_name }),
      element('p', { text: `${tenant.product_name} · ${tenant.slug}` }),
    ]),
  ]);
  const details = element('div', { className: 'client-details' }, [
    detail('النسخة', statusLabels[tenant.environment] || tenant.environment),
    detail('الباقة', tenant.plan_name),
    detail('تاريخ الأرشفة', dateText(tenant.archived_at)),
    detail('الهاتف', tenant.phone || '—'),
  ]);
  const actions = element('div', { className: 'client-actions' }, [
    button('استعادة', 'button-secondary', 'restore', tenant.id),
    button('تنزيل نسخة', 'button-quiet', 'export', tenant.id),
    button('حذف نهائي', 'button-danger', 'purge', tenant.id),
  ]);
  return element('article', { className: 'client-card' }, [header, element('div', { className: 'badges' }, [badge('archived')]), details, actions]);
}

/**
 * بطاقة عميل محتمل.
 *
 * الرسالة كاملة لا مقتطعة: نصّ العميل هو كل ما نملكه عنه قبل أن يردّ أحد،
 * وقصّه يعني فتح صندوق آخر لقراءته — وهو ما جاء هذا التبويب ليُلغيه.
 */
function leadCard(lead) {
  const header = element('div', { className: 'client-card-header' }, [
    element('div', { className: 'product-icon', text: lead.is_read ? '✓' : '✉', attrs: { 'aria-hidden': 'true' } }),
    element('div', { className: 'client-title' }, [
      element('h3', { text: lead.name }),
      element('p', { text: [lead.business_type, lead.service_label].filter(Boolean).join(' · ') || 'بلا تصنيف' }),
    ]),
  ]);
  const details = element('div', { className: 'client-details' }, [
    detail('الهاتف', lead.phone),
    detail('البريد', lead.email),
    detail('وصلت في', dateText(lead.received_at)),
    detail('حالة العميل', statusLabels[lead.customer_status] || lead.customer_status || '—'),
  ]);
  const body = element('p', { className: 'lead-message', text: lead.message });
  const actions = element('div', { className: 'client-actions' });
  if (lead.phone) {
    // واتساب: قناة الردّ الفعلية في هذا السوق، ورقم بلا زر يعني نسخًا يدويًا.
    actions.append(element('a', {
      className: 'button button-primary',
      text: 'ردّ عبر واتساب',
      href: `https://wa.me/${lead.phone.replace(/\D/g, '')}`,
      target: '_blank', rel: 'noopener',
    }));
  }
  if (!lead.is_read) {
    actions.append(element('button', {
      className: 'button button-secondary', type: 'button', text: 'تعليم كمقروء',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await api(`/api/leads/${encodeURIComponent(lead.id)}/read`, { method: 'POST' });
          await loadLeads(true);
          await loadDashboard(true);
        } catch (error) { showToast(error.message, true); }
      },
    }));
  }
  return element('article', { className: `client-card${lead.is_read ? '' : ' is-unread'}` }, [header, details, body, actions]);
}

/**
 * المحتملون: من يجرّب ومن يسأل.
 *
 * النسخة التجريبية والرسالة الواردة شيء واحد تجاريًا — كلاهما احتمال بيع لم
 * يُغلَق. وفصلهما في شاشتين كان يجعل صاحب اللوحة يتابع نصف خطّ البيع في
 * مكان ونصفه في آخر.
 */
function renderLeads() {
  const container = byId('leads-container');
  container.replaceChildren();
  const demos = demoTenants();
  if (!demos.length && !state.leads.length) {
    return container.append(emptyState('لا عملاء محتملون بعد',
      'النسخ التجريبية التي تنشئها، وما يصل نموذج التواصل في athar.date، يظهران هنا.'));
  }
  for (const tenant of demos) container.append(clientCard(tenant));
  for (const lead of state.leads) container.append(leadCard(lead));
}

async function loadLeads(quiet = false) {
  try {
    const payload = await api('/api/leads');
    state.leads = payload.leads || [];
    renderLeads();
    if (!quiet) showToast('تم تحديث العملاء المحتملين.');
  } catch (error) { showToast(error.message, true); }
}

/** السحب اليدوي: الدورة الليلية تكفي، لكن انتظار الليل لا يكفي لمن ينتظر عميلًا. */
async function syncLeadsNow() {
  const trigger = byId('sync-leads-button');
  trigger.disabled = true;
  try {
    const result = await api('/api/leads/sync', { method: 'POST' });
    await loadLeads(true);
    await loadDashboard(true);
    showToast(result.imported
      ? `وصل ${result.imported} عميلًا محتملًا جديدًا.`
      : 'لا جديد منذ آخر سحب.');
  } catch (error) { showToast(error.message, true); }
  finally { trigger.disabled = false; }
}
/**
 * دفع قائمة التجارب إلى موقع أثر.
 *
 * تُدفع ليلًا تلقائيًا، والزر لمن أنشأ تجربة الآن ولا يريد انتظار الليل.
 * والدفع استبدال كامل، فتكراره بلا أثر.
 */
async function syncShowcaseNow() {
  const trigger = byId('sync-showcase-button');
  trigger.disabled = true;
  try {
    const result = await api('/api/showcase/sync', { method: 'POST' });
    showToast(result.stored
      ? `تُعرض الآن ${result.stored} تجربة في athar.date.`
      : 'لا تجارب مؤهَّلة: التجربة تحتاج نسخة تجريبية نشطة برابط https. قسم التجارب لن يظهر في الموقع.');
  } catch (error) { showToast(error.message, true); }
  finally { trigger.disabled = false; }
}

/** مبالغ بعملات مختلفة تُعرض متجاورة: جمعها في رقم واحد كذب يبدو صحيحًا. */
const moneyList = (list) => (list?.length
  ? list.map((m) => money(m.amount_minor, m.currency)).join(' + ')
  : '—');

function renderReports() {
  const report = state.report;
  if (!report) return;

  byId('reports-money').replaceChildren(...[
    ['الإيراد الشهري المتكرر', moneyList(report.mrr), 'من الاشتراكات النشطة'],
    ['المحصَّل — 12 شهرًا', moneyList(report.collected_total), 'دفعات مسجَّلة فعلًا'],
    ['تجديدات قادمة', String(report.upcoming_renewals.length), 'خلال النافذة المحدَّدة'],
    ['متأخرون', String(report.overdue.length), 'فات موعدهم ولم يُسجَّل دفع'],
  ].map(([label, value, hint]) => element('div', { className: 'metric-card' }, [
    element('small', { text: label }),
    element('strong', { text: value }),
    element('p', { className: 'muted', text: hint }),
  ])));

  const renewals = byId('renewals-body');
  renewals.replaceChildren(...(report.upcoming_renewals.length
    ? report.upcoming_renewals.map((row) => element('tr', {}, [
        element('td', { text: row.customer_name }),
        element('td', { text: row.display_name }),
        element('td', { text: dateText(row.period_end) }),
        element('td', { text: row.days_left <= 0 ? 'اليوم' : `${row.days_left} يومًا` }),
        element('td', { text: money(row.amount_minor, row.currency) }),
        // المفتاح يُعرض هنا لا ليُبدَّل: من يقرأ التجديدات يحتاج أن يعرف
        // أيّها سيتوقف تلقائيًا وأيّها ينتظر قراره.
        element('td', { text: row.auto_suspend ? 'مفعّل' : 'معطّل' }),
      ]))
    : [element('tr', {}, [element('td', { text: 'لا تجديدات في هذه النافذة', attrs: { colspan: '6' } })])]));

  const overdue = byId('overdue-body');
  overdue.replaceChildren(...(report.overdue.length
    ? report.overdue.map((row) => element('tr', {}, [
        element('td', { text: row.customer_name }),
        element('td', { text: row.display_name }),
        element('td', { text: statusLabels[row.status] || row.status }),
        element('td', { text: `${row.days_late} يومًا` }),
        element('td', { text: money(row.amount_minor, row.currency) }),
        element('td', {}, row.phone
          ? element('a', { className: 'text-button', text: 'واتساب', target: '_blank', rel: 'noopener',
              href: `https://wa.me/${row.phone.replace(/\D/g, '')}` })
          : element('span', { className: 'muted', text: '—' })),
      ]))
    : [element('tr', {}, [element('td', { text: 'لا متأخرين — كل الاشتراكات في موعدها', attrs: { colspan: '6' } })])]));

  byId('collected-body').replaceChildren(...(report.collected_by_month.length
    ? [...report.collected_by_month].reverse().map((row) => element('tr', {}, [
        element('td', { text: row.month }),
        element('td', { text: moneyList(row.totals) }),
      ]))
    : [element('tr', {}, [element('td', { text: 'لا دفعات مسجَّلة بعد', attrs: { colspan: '2' } })])]));

  byId('by-product-body').replaceChildren(...(report.by_product.length
    ? report.by_product.map((row) => element('tr', {}, [
        element('td', { text: row.product_name }),
        element('td', { text: String(row.active) }),
        element('td', { text: money(row.mrr_minor, row.currency) }),
      ]))
    : [element('tr', {}, [element('td', { text: 'لا اشتراكات نشطة', attrs: { colspan: '3' } })])]));
}

const megabytes = (bytes) => `${(Number(bytes || 0) / 1048576).toFixed(1)} م.ب`;

function renderLimits() {
  const report = state.limits;
  if (!report) return;

  // التحذيرات فوق الجدول: من يفتح الصفحة يجب أن يرى المشكلة لا أن يبحث عنها.
  byId('limits-warnings').replaceChildren(...report.warnings.map((warning) => element('p', {
    className: warning.level === 'critical' ? 'form-error' : 'muted',
    text: `${warning.resource}: ${warning.message}`,
  })));

  const rows = report.d1.map((row) => element('tr', {}, [
    element('td', { text: `قاعدة ${row.name}` }),
    element('td', { text: megabytes(row.size_bytes) }),
    element('td', { text: `${row.used_percent}%` }),
  ]));
  if (report.r2) {
    rows.push(element('tr', {}, [
      element('td', { text: `سطل النسخ (${report.r2.objects} ملفًا)` }),
      element('td', { text: megabytes(report.r2.size_bytes) }),
      element('td', { text: '—' }),
    ]));
    for (const entry of report.r2.by_prefix) {
      rows.push(element('tr', {}, [
        element('td', { text: `— ${entry.prefix}` }),
        element('td', { text: megabytes(entry.size_bytes) }),
        element('td', { text: `${entry.objects} نسخة` }),
      ]));
    }
  }
  byId('limits-body').replaceChildren(...rows);
}

async function loadReports(quiet = false) {
  const refresh = byId('load-reports-button');
  refresh.disabled = true;
  try {
    const [revenue, limits] = await Promise.all([
      api('/api/reports/revenue'),
      api('/api/reports/limits'),
    ]);
    state.report = revenue.report;
    state.limits = limits.report;
    renderReports();
    renderLimits();
    if (!quiet) showToast('تم تحديث التقرير.');
  } catch (error) { showToast(error.message, true); }
  finally { refresh.disabled = false; }
}
function renderArchive() {
  const container = byId('archive-container');
  container.replaceChildren();
  if (!state.archived.length) {
    return container.append(emptyState('الأرشيف فارغ', 'لا يوجد عملاء مؤرشفون حاليًا.'));
  }
  for (const tenant of state.archived) container.append(archiveCard(tenant));
}

async function loadArchive(quiet = false) {
  const refresh = byId('load-archive-button');
  refresh.disabled = true;
  try {
    const payload = await api('/api/tenants/archived');
    state.archived = payload.archived || [];
    renderArchive();
    if (!quiet) showToast('تم تحديث الأرشيف.');
  } catch (error) { showToast(error.message, true); }
  finally { refresh.disabled = false; }
}

function downloadJson(name, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportTenant(tenant) {
  const payload = await api(`/api/tenants/${encodeURIComponent(tenant.id)}/export`, { method: 'POST', body: '{}' });
  downloadJson(`athar-${tenant.slug}-${today()}.json`, payload);
  return payload.checksum;
}

function openPurgeDialog(tenant) {
  state.purge = { tenant, checksum: '' };
  const form = byId('purge-form');
  form.reset();
  form.elements.tenant_id.value = tenant.id;
  byId('purge-title').textContent = `حذف: ${tenant.display_name}`;
  byId('purge-slug').textContent = tenant.slug;
  byId('purge-export-state').textContent = 'جارٍ تنزيل النسخة الاحتياطية…';
  byId('purge-submit').disabled = true;
  byId('purge-error').textContent = '';
  byId('purge-dialog').showModal();
  void purgeExport();
}

/**
 * النسخة الاحتياطية تُنزَّل تلقائيًا عند فتح النافذة.
 *
 * الخادم يرفض الحذف بلا بصمة نسخة مطابقة — وهذه الحماية تبقى كما هي. لكن
 * جعلها **خطوة يدوية** كان يحوّل حمايةً إلى عبء: زرٌّ يُضغط وانتظارٌ ثم
 * خطوة ثانية. الحماية نفسها تتحقّق إن نزّلها البرنامج بنفسه، وما يبقى على
 * صاحب اللوحة هو الفعل الواعي وحده: كتابة المعرّف.
 */
async function purgeExport() {
  byId('purge-error').textContent = '';
  try {
    state.purge.checksum = await exportTenant(state.purge.tenant);
    byId('purge-export-state').textContent = 'نُزّلت نسخة احتياطية كاملة على جهازك.';
    byId('purge-submit').disabled = false;
  } catch (error) {
    byId('purge-export-state').textContent = 'تعذّر تنزيل النسخة — الحذف موقوف.';
    byId('purge-error').textContent = error.message;
  }
}

async function submitPurge(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = byId('purge-submit');
  const tenant = state.purge.tenant;
  const confirmSlug = form.elements.confirm_slug.value.trim();
  if (confirmSlug !== tenant.slug) {
    byId('purge-error').textContent = 'المعرّف غير مطابق.';
    return;
  }
  submit.disabled = true;
  byId('purge-error').textContent = '';
  try {
    await api(`/api/tenants/${encodeURIComponent(tenant.id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm_slug: confirmSlug, export_checksum: state.purge.checksum }),
    });
    byId('purge-dialog').close();
    showToast('تم الحذف النهائي وبقي أثر مختصر في سجل العمليات.');
    await Promise.all([loadArchive(true), loadDashboard(true)]);
  } catch (error) {
    byId('purge-error').textContent = error.message;
    submit.disabled = false;
  }
}

async function handleArchiveAction(event) {
  const target = event.target.closest('[data-action][data-id]');
  if (!target) return;
  const tenant = state.archived.find((item) => item.id === target.dataset.id);
  if (!tenant) return;
  const action = target.dataset.action;
  try {
    if (action === 'export') {
      await exportTenant(tenant);
      showToast('تم تنزيل النسخة الاحتياطية.');
    } else if (action === 'purge') {
      openPurgeDialog(tenant);
    } else if (action === 'restore') {
      const agreed = await confirmAction({
        title: `استعادة: ${tenant.display_name}`,
        message: 'يعود العميل موقوفًا حتى تستأنفه — لا نشطًا مباشرة.',
        okLabel: 'استعادة',
      });
      if (!agreed) return;
      await api(`/api/tenants/${encodeURIComponent(tenant.id)}/lifecycle`, { method: 'POST', body: JSON.stringify({ action: 'restore' }) });
      showToast('تمت الاستعادة. العميل الآن موقوف.');
      await Promise.all([loadArchive(true), loadDashboard(true)]);
    }
  } catch (error) { showToast(error.message, true); }
}

async function loadFullAudit() {
  const button = byId('load-audit-button');
  button.disabled = true;
  try {
    const payload = await api('/api/audit?limit=200');
    renderAudit(payload.audit);
    showToast('تم تحديث سجل العمليات.');
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

function bindEvents() {
  byId('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    byId('login-error').textContent = '';
    try {
      const payload = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: form.elements.password.value }) });
      state.csrf = payload.csrf;
      form.reset();
      showApp();
      await loadDashboard(true);
    } catch (error) { byId('login-error').textContent = error.message; }
    finally { submit.disabled = false; }
  });
  byId('logout-button').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } finally { showLogin(); } });
  byId('new-client-button').addEventListener('click', openCreateDialog);
  document.querySelectorAll('[data-open-create]').forEach((node) => node.addEventListener('click', openCreateDialog));
  byId('refresh-button').addEventListener('click', () => loadDashboard());
  byId('menu-button').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  // `[data-view]` لا `.nav-item` وحدها: القائمة تحوي رابطًا خارجيًا يحمل
  // الصنف نفسه للتنسيق، وربطه هنا يعني `setView(undefined)` عند نقره.
  document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));
  document.querySelectorAll('[data-view-jump]').forEach((item) => item.addEventListener('click', () => setView(item.dataset.viewJump)));
  byId('sync-leads-button').addEventListener('click', syncLeadsNow);
  byId('sync-showcase-button').addEventListener('click', syncShowcaseNow);
  byId('load-reports-button').addEventListener('click', () => loadReports());
  ['client-search', 'product-filter', 'status-filter'].forEach((id) => byId(id).addEventListener(id === 'client-search' ? 'input' : 'change', renderClients));
  document.querySelectorAll('[data-layout]').forEach((item) => item.addEventListener('click', () => {
    state.layout = item.dataset.layout;
    document.querySelectorAll('[data-layout]').forEach((node) => node.classList.toggle('is-active', node === item));
    renderClients();
  }));
  byId('clients-container').addEventListener('click', handleClientAction);
  byId('recent-clients').addEventListener('click', handleClientAction);
  byId('create-product').addEventListener('change', updateCreateOptions);
  byId('create-plan').addEventListener('change', updateCreateOptions);
  byId('create-form').elements.environment.addEventListener('change', updateDemoVisibility);
  byId('create-school-logo').addEventListener('change', async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      createSchoolLogoDataUrl = '';
      byId('create-school-logo-preview').hidden = true;
      byId('create-school-logo-preview').removeAttribute('src');
      return;
    }
    try {
      createSchoolLogoDataUrl = await prepareSchoolLogo(file);
      const preview = byId('create-school-logo-preview');
      preview.src = createSchoolLogoDataUrl;
      preview.hidden = false;
    } catch (error) {
      createSchoolLogoDataUrl = '';
      event.currentTarget.value = '';
      byId('create-school-logo-preview').hidden = true;
      byId('create-school-logo-preview').removeAttribute('src');
      showToast(error.message, true);
    }
  });
  byId('create-form').addEventListener('submit', submitCreate);
  byId('payment-form').addEventListener('submit', submitPayment);
  byId('plan-form').addEventListener('submit', submitPlan);
  byId('customer-form').addEventListener('submit', submitCustomer);
  byId('archive-container').addEventListener('click', handleArchiveAction);
  byId('load-archive-button').addEventListener('click', () => loadArchive());
  byId('purge-form').addEventListener('submit', submitPurge);
  byId('load-audit-button').addEventListener('click', loadFullAudit);
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
}

async function boot() {
  bindEvents();
  const requested = window.location.pathname.replace(/^\/+/, '');
  if (['overview', 'clients', 'leads', 'plans', 'reports', 'archive', 'audit'].includes(requested)) setView(requested);
  // زرّا الرجوع والتقدّم في المتصفّح: بلا هذا يبقى العنوان يتغيّر والشاشة لا.
  window.addEventListener('popstate', () => {
    const back = window.location.pathname.replace(/^\/+/, '') || 'overview';
    if (['overview', 'clients', 'leads', 'plans', 'reports', 'archive', 'audit'].includes(back)) setView(back);
  });
  try {
    const session = await api('/api/session');
    state.csrf = session.csrf;
    showApp();
    await loadDashboard(true);
  } catch { showLogin(); }
}

boot();
