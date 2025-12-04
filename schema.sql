DROP TABLE IF EXISTS repeaters;

DROP TABLE IF EXISTS requests;

DROP TABLE IF EXISTS changelog;
DROP TABLE IF EXISTS users;

CREATE TABLE
    IF NOT EXISTS repeaters (
        callsign TEXT NOT NULL PRIMARY KEY,
        disabled INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        keeper TEXT NOT NULL,
        latitude NUMERIC(3, 8) NOT NULL,
        longitude NUMERIC(3, 8) NOT NULL,
        place TEXT NOT NULL,
        location TEXT,
        info TEXT,
        altitude INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        power INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_fm BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_am BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_usb BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_lsb BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_dmr BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_dstar BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_fusion BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_nxdn BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_parrot BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        mode_beacon BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        freq_rx INTEGER NOT NULL,
        freq_tx INTEGER NOT NULL,
        tone NUMERIC(3, 1) NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        net_echolink INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        net_allstarlink INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 0,
        net_zello TEXT,
        net_other TEXT,
        coverage_map_json TEXT,
        -- Digital mode details (optional text fields)
        dstar_reflector TEXT,
        dstar_info TEXT,
        fusion_reflector TEXT,
        fusion_tg TEXT,
        fusion_info TEXT,
        dmr_network TEXT,
        dmr_ts1_groups TEXT,
        dmr_ts2_groups TEXT,
        dmr_info TEXT,
    -- Additional digital metadata
    dmr_color_code TEXT,
    dmr_callid TEXT,
    dmr_reflector TEXT,
    dstar_module TEXT,
    dstar_gateway TEXT,
    fusion_room TEXT,
    fusion_dgid TEXT,
    fusion_wiresx_node TEXT,
    nxdn_ran TEXT,
    nxdn_network TEXT,
        created DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP,
        updated DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP
    );

CREATE TABLE
    requests (
        id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        contact TEXT NOT NULL,
        info TEXT NOT NULL,
        date DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP
    );

CREATE TABLE
    changelog (
        date DATETIME PRIMARY KEY NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP,
        who TEXT NOT NULL,
        info TEXT NOT NULL
    );

CREATE TABLE
    users (
        username TEXT PRIMARY KEY NOT NULL,
        password TEXT NOT NULL, -- store SHA-256 hash (hex)
        enabled BOOLEAN NOT NULL ON CONFLICT REPLACE DEFAULT 1,
                token_version INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 1,
                last_login DATETIME,
                last_login_device TEXT,
                last_login_ua TEXT,
        created DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP,
        updated DATETIME NOT NULL ON CONFLICT REPLACE DEFAULT CURRENT_TIMESTAMP
    );

-- SUPERADMIN credentials are managed via the SUPERADMIN_PW environment variable and are not stored in this table.
