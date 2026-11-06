-- Cortex database schema v5 fixture (DDL only, no data).
-- Generated from a real Cortex DB by recon/dump-schema.mjs; do not edit by hand.
PRAGMA foreign_keys = OFF;
PRAGMA user_version = 5;

CREATE TABLE assets (
        host_port TEXT PRIMARY KEY,
        host TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL,
        tech_stack TEXT NOT NULL DEFAULT '',
        auth_required INTEGER NOT NULL DEFAULT 0 CHECK (auth_required IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'Alive' CHECK (status IN ('Alive', 'Dead', 'WAF_Blocked')),
        interfaces TEXT NOT NULL DEFAULT '[]',
        interface_dir TEXT NOT NULL DEFAULT '[]',
        leaked_infos TEXT NOT NULL DEFAULT '[]',
        test_parameters TEXT NOT NULL DEFAULT '[]',
        related_vuln_ids TEXT NOT NULL DEFAULT '[]',
        last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
CREATE TABLE credential_trials (
        id            TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
        service_id    TEXT REFERENCES internal_services(id) ON DELETE SET NULL,
        action        TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'attempted'
                      CHECK (status IN ('attempted','success','failed','blocked')),
        notes         TEXT NOT NULL DEFAULT '',
        attempted_at  TEXT NOT NULL
      );
CREATE TABLE credentials (
        id            TEXT PRIMARY KEY,
        project_name  TEXT NOT NULL,
        type          TEXT NOT NULL
                      CHECK (type IN ('password','ntlm_hash','netntlmv2','kerberos_ticket','ssh_key','cert','api_key','other')),
        username      TEXT NOT NULL DEFAULT '',
        domain        TEXT NOT NULL DEFAULT '',
        secret        TEXT NOT NULL DEFAULT '',
        source        TEXT NOT NULL DEFAULT '',
        host_id       TEXT REFERENCES internal_hosts(id) ON DELETE SET NULL,
        service_id    TEXT REFERENCES internal_services(id) ON DELETE SET NULL,
        confidence    TEXT NOT NULL DEFAULT 'medium'
                      CHECK (confidence IN ('low','medium','high')),
        status        TEXT NOT NULL DEFAULT 'untested'
                      CHECK (status IN ('untested','valid','invalid','expired')),
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
CREATE TABLE foothold_hosts (
        foothold_id      TEXT NOT NULL REFERENCES footholds(id) ON DELETE CASCADE,
        internal_host_id TEXT NOT NULL REFERENCES internal_hosts(id) ON DELETE CASCADE,
        discovered_at    TEXT NOT NULL DEFAULT '',
        notes            TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (foothold_id, internal_host_id)
      );
CREATE TABLE footholds (
        id               TEXT PRIMARY KEY,
        project_name     TEXT NOT NULL,
        entry_host_port  TEXT NOT NULL,
        entry_vuln_id    TEXT NOT NULL DEFAULT '',
        access_type      TEXT NOT NULL
                         CHECK (access_type IN ('rce','webshell','ssrf_proxy','credential','vpn','other')),
        privilege_level  TEXT NOT NULL DEFAULT 'user'
                         CHECK (privilege_level IN ('user','admin','system','domain_admin','unknown')),
        status           TEXT NOT NULL DEFAULT 'established'
                         CHECK (status IN ('planned','established','degraded','lost')),
        evidence         TEXT NOT NULL DEFAULT '',
        notes            TEXT NOT NULL DEFAULT '',
        established_at   TEXT NOT NULL DEFAULT '',
        last_verified_at TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
CREATE TABLE internal_hosts (
        id            TEXT PRIMARY KEY,
        project_name  TEXT NOT NULL,
        ip            TEXT NOT NULL,
        hostname      TEXT NOT NULL DEFAULT '',
        os            TEXT NOT NULL DEFAULT '',
        subnet        TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (state IN ('unknown','alive','compromised','unreachable','firewalled')),
        source        TEXT NOT NULL DEFAULT '',
        confidence    TEXT NOT NULL DEFAULT 'medium'
                      CHECK (confidence IN ('low','medium','high')),
        last_seen     TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (project_name, ip)
      );
CREATE TABLE internal_services (
        id            TEXT PRIMARY KEY,
        project_name  TEXT NOT NULL,
        host_id       TEXT NOT NULL REFERENCES internal_hosts(id) ON DELETE CASCADE,
        port          INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        protocol      TEXT NOT NULL DEFAULT '',
        service       TEXT NOT NULL DEFAULT '',
        banner        TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL DEFAULT 'open'
                      CHECK (state IN ('open','closed','filtered','unknown')),
        source        TEXT NOT NULL DEFAULT '',
        last_seen     TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (host_id, port, protocol)
      );
CREATE TABLE loot_imports (
        id             TEXT PRIMARY KEY,
        project_name   TEXT NOT NULL,
        entry_host_port TEXT NOT NULL DEFAULT '',
        filename       TEXT NOT NULL,
        sha256         TEXT NOT NULL DEFAULT '',
        format         TEXT NOT NULL DEFAULT 'unknown',
        parser         TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'parsed'
                       CHECK (status IN ('queued','parsed','needs_review','failed')),
        summary_json   TEXT NOT NULL DEFAULT '{}',
        error          TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL
      );
CREATE TABLE pivot_hops (
        pivot_id      TEXT NOT NULL REFERENCES pivots(id) ON DELETE CASCADE,
        seq           INTEGER NOT NULL CHECK (seq >= 0),
        ref_kind      TEXT NOT NULL CHECK (ref_kind IN ('internal_host','internal_service')),
        ref_id        TEXT NOT NULL,
        label         TEXT NOT NULL DEFAULT '',
        via           TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (pivot_id, seq)
      );
CREATE TABLE pivot_reachability (
        pivot_id      TEXT NOT NULL REFERENCES pivots(id) ON DELETE CASCADE,
        cidr          TEXT NOT NULL,
        note          TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (pivot_id, cidr)
      );
CREATE TABLE pivots (
        id               TEXT PRIMARY KEY,
        project_name     TEXT NOT NULL,
        foothold_id      TEXT NOT NULL REFERENCES footholds(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL CHECK (kind IN ('chain','proxy')),
        local_host       TEXT NOT NULL DEFAULT '127.0.0.1',
        local_port       INTEGER NOT NULL DEFAULT 0 CHECK (local_port BETWEEN 0 AND 65535),
        local_protocol   TEXT NOT NULL DEFAULT '',
        tool             TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'planned'
                         CHECK (status IN ('planned','established','degraded','lost')),
        notes            TEXT NOT NULL DEFAULT '',
        established_at   TEXT NOT NULL DEFAULT '',
        last_verified_at TEXT NOT NULL DEFAULT '',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
CREATE TABLE snapshot_sessions (
        session_id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        target_hosts TEXT NOT NULL DEFAULT '[]',
        current_phase TEXT NOT NULL DEFAULT '',
        unfinished_tasks TEXT NOT NULL DEFAULT '[]',
        failed_paths TEXT NOT NULL DEFAULT '[]',
        tested_interfaces TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        related_vuln_ids TEXT NOT NULL DEFAULT '[]',
        next_steps TEXT NOT NULL DEFAULT '',
        previous_state TEXT,
        parent_session_id TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE vulnerabilities (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        entry_point TEXT NOT NULL DEFAULT '',
        vuln_name TEXT NOT NULL,
        vuln_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('Critical', 'High', 'Medium', 'Low', 'Info')),
        target_url TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        impact TEXT NOT NULL DEFAULT '',
        affected_interfaces TEXT NOT NULL DEFAULT '[]',
        reproduction_steps TEXT NOT NULL DEFAULT '',
        remediation TEXT NOT NULL DEFAULT '[]',
        crypto_details TEXT NOT NULL DEFAULT '',
        test_boundaries TEXT NOT NULL DEFAULT '',
        retest_results TEXT NOT NULL DEFAULT '[]',
        related_vuln_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'Confirmed' CHECK (status IN ('Confirmed', 'Inconclusive', 'Retest_Passed')),
        created_at TEXT NOT NULL
      , service_host TEXT NOT NULL DEFAULT '', realm TEXT NOT NULL DEFAULT 'web' CHECK (realm IN ('web','internal')), internal_service_id TEXT NOT NULL DEFAULT '');
CREATE INDEX idx_assets_host ON assets (host);
CREATE INDEX idx_assets_last_seen ON assets (last_seen DESC);
CREATE INDEX idx_assets_project ON assets (project_name);
CREATE INDEX idx_assets_status ON assets (status);
CREATE INDEX idx_credential_trials_credential
        ON credential_trials (credential_id);
CREATE INDEX idx_credentials_host ON credentials (host_id);
CREATE INDEX idx_credentials_project ON credentials (project_name);
CREATE INDEX idx_foothold_hosts_host ON foothold_hosts (internal_host_id);
CREATE INDEX idx_footholds_entry ON footholds (entry_host_port);
CREATE INDEX idx_footholds_project ON footholds (project_name);
CREATE INDEX idx_internal_hosts_project ON internal_hosts (project_name);
CREATE INDEX idx_internal_hosts_subnet ON internal_hosts (project_name, subnet);
CREATE INDEX idx_internal_services_host ON internal_services (host_id);
CREATE INDEX idx_internal_services_project ON internal_services (project_name);
CREATE INDEX idx_loot_imports_project ON loot_imports (project_name);
CREATE INDEX idx_pivots_foothold ON pivots (foothold_id);
CREATE INDEX idx_pivots_project ON pivots (project_name);
CREATE INDEX idx_snapshot_sessions_parent ON snapshot_sessions (parent_session_id);
CREATE INDEX idx_snapshot_sessions_project ON snapshot_sessions (project_name);
CREATE INDEX idx_snapshot_sessions_updated ON snapshot_sessions (updated_at DESC);
CREATE INDEX idx_vulnerabilities_created_at ON vulnerabilities (created_at DESC);
CREATE INDEX idx_vulnerabilities_host ON vulnerabilities (host);
CREATE INDEX idx_vulnerabilities_internal_service ON vulnerabilities (internal_service_id);
CREATE INDEX idx_vulnerabilities_realm ON vulnerabilities (realm);
CREATE INDEX idx_vulnerabilities_severity ON vulnerabilities (severity);
CREATE INDEX idx_vulnerabilities_status ON vulnerabilities (status);
