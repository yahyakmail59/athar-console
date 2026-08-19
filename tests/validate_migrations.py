"""Dependency-free smoke test for the D1 SQLite migrations."""

from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parents[1]


def apply(connection: sqlite3.Connection, migration: str) -> None:
    connection.executescript((ROOT / "migrations" / migration).read_text(encoding="utf-8"))


db = sqlite3.connect(":memory:")
apply(db, "0001_legacy_baseline.sql")
db.execute(
    """INSERT INTO clients
       (id, name, product, slug, plan, price_usd, paid_until, active, contact, notes, created_at)
       VALUES ('legacy-1', 'صيدلية قديمة', 'pharmacy', 'legacy-pharmacy', 'full', 40,
               '2026-12-31', 1, '0599000000', 'import test', '2026-01-01')"""
)
db.execute(
    """INSERT INTO payments (id, client_id, amount_usd, paid_on, method)
       VALUES ('legacy-pay-1', 'legacy-1', 40, '2026-01-02', 'cash')"""
)
apply(db, "0002_control_plane_v2.sql")

assert db.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 4
assert db.execute("SELECT COUNT(*) FROM plans").fetchone()[0] == 6
assert db.execute("SELECT COUNT(*) FROM brand_kits").fetchone()[0] == 4
assert db.execute("SELECT plan_id FROM tenants WHERE id = 'legacy-1'").fetchone()[0] == "pharmacy:standard"
assert db.execute("SELECT amount_minor FROM subscription_payments").fetchone()[0] == 4000
assert db.execute("PRAGMA foreign_key_check").fetchall() == []

print("D1 migrations: OK (schema, seeds, legacy import, foreign keys)")
