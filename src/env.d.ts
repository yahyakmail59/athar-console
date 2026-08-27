interface Env {
  ADMIN_PASSWORD_HASH: string;
  SESSION_SECRET: string;
  ATHAR_ADAPTER_SECRET: string;
  // كل منتج له ربط خدمة في الإنتاج، ورابط HTTP اختياري للتطوير المحلي
  // حيث لا تتوفر Service Bindings بين عمليتي wrangler dev منفصلتين.
  PHARMA_ADAPTER: Fetcher;
  PHARMA_ADAPTER_URL?: string;
  SCHOOL_ADAPTER: Fetcher;
  SCHOOL_ADAPTER_URL?: string;
  RESTAURANT_ADAPTER: Fetcher;
  RESTAURANT_ADAPTER_URL?: string;
  // موقع أثر التعريفي: ليس محرك منتج، لكنه يُنادى بالتوقيع نفسه لسحب
  // العملاء المحتملين من نموذج التواصل.
  SITE_ADAPTER: Fetcher;
  SITE_ADAPTER_URL?: string;
}
