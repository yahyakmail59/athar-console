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
}
