/**
 * يجعل عُقدة تقرأ مصادر TypeScript كما يقرأها المُجمِّع.
 *
 * الشيفرة تكتب `from './lib'` بلا امتداد لأن wrangler يحلّها هكذا. وعُقدة
 * لا تحلّها، فكان أعمق ما يُفحص وحدةً طرفيّة لا تستورد شيئًا — أي أن
 * `index.ts`، وفيه كلّ المسارات والحرّاس، لم يكن يُفحص أبدًا.
 *
 * هذا الخطّاف يضيف الامتداد عند الفشل فقط: ما يُحلّ عاديًّا لا يُمسّ.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return await next(specifier, context);
    } catch (error) {
      /* `./lib` بلا امتداد، و`./lib.js` الذي يقصد `lib.ts` — كلاهما مكتوب
         في هذه الشيفرة، والمُجمِّع يقبلهما. */
      const candidates = [
        `${specifier}.ts`,
        `${specifier}/index.ts`,
        specifier.replace(/\.js$/, '.ts'),
      ];
      for (const candidate of candidates) {
        if (candidate === specifier) continue;
        try {
          return await next(candidate, context);
        } catch { /* جرّب التالي */ }
      }
      throw error;
    }
  }
  return next(specifier, context);
}
