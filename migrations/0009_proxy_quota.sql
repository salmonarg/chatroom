-- Migration number: 0009    2026-07-02T00:00:00.000Z
-- Proxy quota and usage tracking tables for dynamic nodes and shared pools

CREATE TABLE IF NOT EXISTS proxy_nodes (
    id            TEXT PRIMARY KEY,  -- e.g., 'oregon', 'salmon'
    name          TEXT NOT NULL,     -- display name
    type          TEXT NOT NULL,     -- 'static' or 'dynamic'
    server_ip     TEXT NOT NULL,
    server_port   INTEGER DEFAULT 443,
    server_name   TEXT NOT NULL,
    public_key    TEXT NOT NULL,
    short_id      TEXT NOT NULL,
    is_active     INTEGER DEFAULT 1,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_users (
    uid               TEXT PRIMARY KEY,
    xray_uuid         TEXT UNIQUE NOT NULL,
    sub_token         TEXT UNIQUE NOT NULL,
    
    static_quota      INTEGER DEFAULT 42949672960, -- 40GB
    static_used       INTEGER DEFAULT 0,
    static_is_blocked INTEGER DEFAULT 0,
    
    dynamic_used       INTEGER DEFAULT 0,
    dynamic_is_blocked INTEGER DEFAULT 0,
    
    token_created_at  INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    FOREIGN KEY (uid) REFERENCES users(uid)
);

CREATE TABLE IF NOT EXISTS proxy_checkins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uid        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (uid) REFERENCES proxy_users(uid)
);

CREATE TABLE IF NOT EXISTS proxy_usage_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    uid           TEXT NOT NULL,
    year          INTEGER NOT NULL,
    month         INTEGER NOT NULL,
    static_used   INTEGER NOT NULL,
    static_quota  INTEGER NOT NULL,
    dynamic_used  INTEGER NOT NULL,
    dynamic_quota INTEGER NOT NULL,
    archived_at   INTEGER NOT NULL,
    UNIQUE(uid, year, month)
);
