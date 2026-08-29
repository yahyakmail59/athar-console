SELECT t.id, t.product_id, t.display_name, t.short_name, t.public_url,
       t.demo_username, t.demo_password, t.demo_hint, t.demo_image, p.name_ar AS product_name
FROM tenants t JOIN products p ON p.id = t.product_id
WHERE t.is_showcase = 1 AND t.environment = 'demo' AND t.status = 'active' AND t.public_url <> ''
ORDER BY p.name_ar ASC, t.created_at ASC