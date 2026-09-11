/**
 * أرقام الجوّال الفلسطينية — نسخة المتصفّح.
 *
 * توأمُ `readPhone` في `src/lib.ts`. ولماذا نسختان: الـWorker يُحزَم من
 * `src/` ولا يخدم ملفاته، والمتصفّح لا يقرأ TypeScript. ويقابل النسختين
 * فحصٌ واحد بملف الحالات `tests/fixtures/palestinian-phones.json` — فهو
 * ما يمنع افتراقهما، لا الانضباط.
 *
 * وأداة المبيعات في مستودعٍ آخر لها نسخةٌ ثالثة تُقابَل بالملف نفسه.
 */

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/* الفواصل المستعملة فعلًا في بيانات الإنتاج. والشرطة ليست منها: تقع
   داخل الرقم (56-666-0005) لا بينه وبين غيره. */
const PHONE_SEPARATORS = /[\/|,،;؛\n\r]+|\s+-\s+|\s+و\s+|\s+أو\s+|\s+ext\.?\s*/gi;

const onlyDigits = (value) => String(value)
  .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) & 0x0f))
  .replace(/\D/g, '');

function nationalNumber(digits) {
  let rest = digits;
  if (rest.startsWith('00')) rest = rest.slice(2);
  if (rest.startsWith('970') || rest.startsWith('972')) return rest.slice(3);
  if (rest.startsWith('0')) return rest.slice(1);
  return rest;
}

function classify(nsn) {
  if (/^59\d{7}$/.test(nsn)) return 'jawwal';
  if (/^56\d{7}$/.test(nsn)) return 'ooredoo';
  if (/^5[0234578]\d{7}$/.test(nsn)) return 'israeli';
  if (/^[2489]\d{7}$/.test(nsn)) return 'landline';
  return 'unknown';
}

const RANK = { jawwal: 0, ooredoo: 0, israeli: 1, landline: 2, unknown: 3, none: 4 };

/**
 * يقرأ حقل الهاتف كما كُتب ويعيد رقم واتساب صالحًا.
 *
 * 059 و056 فلسطينيّان مهما كُتبت مقدّمتهما — تُصحَّح إلى 970. و050 و052
 * و054 مشغّلون إسرائيليّون فعلًا، فتبقى 972: تحويلها يعطي رقمًا لا وجود له.
 */
export function readPhone(raw) {
  const parts = String(raw ?? '')
    .split(PHONE_SEPARATORS)
    .map(onlyDigits)
    .filter(Boolean);

  if (!parts.length) return { number: '', mobile: false, kind: 'none', count: 0, all: [] };

  let best = null;
  const all = [];
  for (const part of parts) {
    const nsn = nationalNumber(part);
    const kind = classify(nsn);
    if (!best || RANK[kind] < RANK[best.kind]) best = { kind, nsn };
    /* كل الأرقام الصالحة لا الأوّل وحده: حقلٌ فيه ثلاثة، وواحدٌ منها بلا
       واتساب، يجعل العميل يبدو غير قابلٍ للوصول وهو قابل. */
    if (kind === 'jawwal' || kind === 'ooredoo') all.push('970' + nsn);
    else if (kind === 'israeli') all.push('972' + nsn);
  }

  const country = best.kind === 'jawwal' || best.kind === 'ooredoo' ? '970'
    : best.kind === 'israeli' ? '972'
      : '';

  return {
    number: country ? country + best.nsn : '',
    mobile: Boolean(country),
    kind: best.kind,
    count: parts.length,
    all,
  };
}

/** رابط واتساب جاهز، أو "" إن لم يصلح الرقم. */
export function whatsappUrl(raw, text = '') {
  const { number } = readPhone(raw);
  if (!number) return '';
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

/** الرقم كما يُقرأ بالعين: `+970 59 250 0015`. */
export function displayPhone(raw) {
  const { number, mobile } = readPhone(raw);
  if (!mobile) return String(raw ?? '').trim();
  const nsn = number.slice(3);
  return `+${number.slice(0, 3)} ${nsn.slice(0, 2)} ${nsn.slice(2, 5)} ${nsn.slice(5)}`;
}
