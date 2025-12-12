-- NOTE: Remote D1 disallows explicit BEGIN/COMMIT; each statement runs atomically.
-- Run locally with sqlite3 if you need explicit transactions.

-- Clean up in case the script was partially run earlier
DROP TABLE IF EXISTS requests_legacy;

-- Preserve any existing submissions while we reshape the table
ALTER TABLE requests RENAME TO requests_legacy;

CREATE TABLE requests (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending',
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    contact_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    cf_ray TEXT,
    cf_country TEXT,
    created DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP,
    updated DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT,
    admin_notes TEXT
);

INSERT INTO requests (
    id,
    status,
    name,
    contact,
    contact_hash,
    payload_json,
    ip,
    user_agent,
    cf_ray,
    cf_country,
    created,
    updated,
    resolved_at,
    resolved_by,
    admin_notes
)
SELECT
    id,
    'pending' AS status,
    name,
    contact,
    'legacy_' || lower(hex(randomblob(16))) AS contact_hash,
    json_object('message', info) AS payload_json,
    NULL AS ip,
    NULL AS user_agent,
    NULL AS cf_ray,
    NULL AS cf_country,
    date AS created,
    date AS updated,
    NULL AS resolved_at,
    NULL AS resolved_by,
    NULL AS admin_notes
FROM requests_legacy;

DROP TABLE requests_legacy;

CREATE INDEX IF NOT EXISTS idx_requests_status_created ON requests (status, created DESC);
CREATE INDEX IF NOT EXISTS idx_requests_contact_hash ON requests (contact_hash);

CREATE TABLE IF NOT EXISTS request_rate_limits (
    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    contact_hash TEXT,
    ip TEXT,
    created DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_request_rate_limits_contact ON request_rate_limits (contact_hash, created DESC);
CREATE INDEX IF NOT EXISTS idx_request_rate_limits_ip ON request_rate_limits (ip, created DESC);

