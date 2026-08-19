-- Register the first concrete Product Adapter implementation.
UPDATE products
SET adapter_url = 'binding://PHARMA_ADAPTER', updated_at = datetime('now')
WHERE id = 'pharmacy';
