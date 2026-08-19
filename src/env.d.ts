interface Env {
  ADMIN_PASSWORD_HASH: string;
  SESSION_SECRET: string;
  ATHAR_ADAPTER_SECRET: string;
  PHARMA_ADAPTER: Fetcher;
  PHARMA_ADAPTER_URL?: string;
}
