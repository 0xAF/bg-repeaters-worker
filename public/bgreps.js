/**
 * BG Repeaters API Client (bgreps.js)
 *
 * A tiny, dependency-free client for https://api.varna.radio/v1
 *
 * Quick start (Browser):
 * <script src="/bgreps.js"></script>
 * <script>
 *   const api = new BGRepeaters({ baseURL: 'https://api.varna.radio/v1' })
 *   api.getRepeater('LZ0BOT').then(console.log)
 *   api.getRepeaters({ have_dmr: true, have_rx_from: 430000000, have_rx_to: 440000000 }).then(console.log)
 * </script>
 *
 * Quick start (Node):
 * const BGRepeaters = require('./bgreps')
 * const api = new BGRepeaters({ baseURL: 'https://api.varna.radio/v1' })
 * const one = await api.getRepeater('LZ0BOT')
 * const list = await api.getRepeaters({ callsign: 'LZ0BOT' })
 *
 * Write operations (use JWT sessions issued via Basic login):
 * api.setAuth('admin', 'password') // stored for login handshake
 * await api.createRepeater({ callsign: 'LZ0XXX', keeper: 'LZ1AA', latitude: 42.1, longitude: 24.7, place: 'София', altitude: 0, modes: { fm: true }, freq: { rx: 430000000, tx: 438000000 } })
 * await api.updateRepeater('LZ0XXX', { place: 'Нов град' })
 * await api.deleteRepeater('LZ0XXX')
 *
 * Endpoints covered:
 * - GET    /v1/                 -> getRepeaters(query?)
 * - GET    /v1/{callsign}       -> getRepeater(callsign)
 * - POST   /v1/                 -> createRepeater(data)
 * - PUT    /v1/{callsign}       -> updateRepeater(callsign, data)
 * - DELETE /v1/{callsign}       -> deleteRepeater(callsign)
 * - GET    /v1/changelog        -> getChangelog()
 * - GET    /v1/doc              -> getDoc()
 *
 * Auth: Provide username/password (via constructor or setAuth). The client exchanges them for a short-lived JWT and automatically
 *        refreshes it when the API issues a new token (X-New-JWT header). You can also inject an existing token via opts.token or setSessionToken().
 *
 * Notes:
 * - To fetch both enabled and disabled repeaters in one call, pass { include_disabled: true } to getRepeaters.
 *   Example: api.getRepeaters({ include_disabled: true })
 * - Convenience helper getAllRepeaters() wraps that flag.
 *
 * @version 2.0.0
 * @license MIT - https://af.mit-license.org/
 */

const BGREPEATERS_VERSION = '2.0.0';

(function (root, factory) {
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.BGRepeaters = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    class BGRepeaters {
        /**
         * @param {Object} [opts]
         * @param {string} [opts.baseURL] Base URL of the API (default: https://api.varna.radio/v1)
         * @param {string} [opts.username] Username stored for JWT login
         * @param {string} [opts.password] Password stored for JWT login
         * @param {string} [opts.token]    Existing JWT session token (skip login)
         * @param {string} [opts.deviceId] Optional device identifier sent to the API for auditing
         * @param {number} [opts.timeout]  Request timeout in ms (default: 10000)
         * @param {boolean} [opts.debug]   Log debug info to console
         * @param {typeof fetch} [opts.fetch] Custom fetch implementation (optional)
         */
        constructor(opts = {}) {
            this.baseURL = (opts.baseURL || 'https://api.varna.radio/v1').replace(/\/$/, '');
            this.username = opts.username || undefined;
            this.password = opts.password || undefined;
            this.deviceId = opts.deviceId || undefined;
            this.timeout = typeof opts.timeout === 'number' ? opts.timeout : 10000;
            this.debug = !!opts.debug;
            this._fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
            this._jwtToken = typeof opts.token === 'string' && opts.token.length ? opts.token : undefined;
            this._loginPromise = null;
            if (!this._fetch) throw new Error('fetch() not available. Provide opts.fetch or run in an environment with fetch.');
        }

        /** Library version (instance accessor) */
        get version() { return BGRepeaters.VERSION; }

        /**
         * Convert boolean modes into objects and merge digital details under the respective mode objects.
         * This does not remove the top-level `digital` object; it augments `modes` children to objects.
         * Schema per mode child:
         *  - Analog (fm, am, usb, lsb, parrot, beacon): { enabled: boolean }
         *  - Digital (dmr, dstar, fusion, nxdn): { enabled: boolean, ...details }
         * @param {Object} repeater - Repeater as returned by the API
         * @param {Object} [opts]
         * @param {boolean} [opts.mutate=false] - If true mutates input, else returns copy
         * @returns {Object}
         */
        static modesToObjects(repeater, opts = {}) {
            if (!repeater || typeof repeater !== 'object') return repeater;
            const mutate = !!opts.mutate;
            const r = mutate ? repeater : { ...repeater };
            const modes = { ...(r.modes || {}) };
            const digital = r.digital || {};

            const toObj = (val) => (typeof val === 'object' && val !== null ? val : { enabled: !!val });

            // Analog modes
            modes.fm = toObj(modes.fm);
            modes.am = toObj(modes.am);
            modes.usb = toObj(modes.usb);
            modes.lsb = toObj(modes.lsb);
            modes.parrot = toObj(modes.parrot);
            modes.beacon = toObj(modes.beacon);

            // Digital modes with details merged
            const dmr = digital.dmr || {};
            const dstar = digital.dstar || {};
            const fusion = digital.fusion || {};
            const nxdn = digital.nxdn || {};

            modes.dmr = { enabled: !!(r.modes && r.modes.dmr), ...dmr };
            modes.dstar = { enabled: !!(r.modes && r.modes.dstar), ...dstar };
            modes.fusion = { enabled: !!(r.modes && r.modes.fusion), ...fusion };
            modes.nxdn = { enabled: !!(r.modes && r.modes.nxdn), ...nxdn };

            r.modes = modes;
            return r;
        }

        /** Instance convenience wrapper for modesToObjects. */
        modesToObjects(repeater, opts = {}) { return BGRepeaters.modesToObjects(repeater, opts); }

        /** Build a CHIRP-compatible CSV payload from API repeaters (static usage requires opts.repeaters). */
        static buildChirpCsv(opts = {}) {
            if (!Array.isArray(opts.repeaters)) throw new Error('BGRepeaters.buildChirpCsv(opts) requires opts.repeaters when called statically.');
            return buildChirpPayloadFromRepeaters(opts.repeaters, opts);
        }

        /** Instance helper: fetch repeaters (unless provided) and build CHIRP CSV payload. */
        async buildChirpCsv(opts = {}) {
            if (Array.isArray(opts.repeaters)) {
                return buildChirpPayloadFromRepeaters(opts.repeaters, opts);
            }
            const query = { ...(opts.query || {}) };
            if (opts.includeDisabled) query.include_disabled = true;
            const hasQuery = Object.keys(query).length > 0;
            const list = await this.getRepeaters(hasQuery ? query : undefined);
            return buildChirpPayloadFromRepeaters(Array.isArray(list) ? list : [], opts);
        }

        /** Browser-only convenience: build + trigger download, returning the payload for further use. */
        static downloadChirpCsv(opts = {}) {
            const payload = BGRepeaters.buildChirpCsv(opts);
            triggerBrowserDownload(payload);
            return payload;
        }

        async downloadChirpCsv(opts = {}) {
            const payload = await this.buildChirpCsv(opts);
            triggerBrowserDownload(payload);
            return payload;
        }

        /** Store credentials used for JWT login (clears cached token). */
        setAuth(username, password) {
            this.username = username;
            this.password = password;
            this._jwtToken = undefined;
            this._loginPromise = null;
            return this;
        }

        /** Provide a device identifier sent with login + subsequent requests (for auditing). */
        setDeviceId(deviceId) {
            this.deviceId = deviceId || undefined;
            return this;
        }

        /** Manually set or override the current JWT token. */
        setSessionToken(token) {
            this._jwtToken = token || undefined;
            return this;
        }

        /** Clear any stored JWT token without touching credentials. */
        clearSessionToken() {
            this._jwtToken = undefined;
            return this;
        }

        /** Explicitly perform the login handshake and return the active JWT. */
        async login(deviceId) {
            if (deviceId) this.setDeviceId(deviceId);
            return await this._ensureBearerToken(true);
        }

        /** Build a query string from an object; booleans are serialized as 'true'/'false', arrays are repeated. */
        _buildQuery(params = {}) {
            const sp = new URLSearchParams();
            for (const [key, val] of Object.entries(params)) {
                if (val === undefined || val === null) continue;
                if (Array.isArray(val)) {
                    for (const v of val) sp.append(key, this._encodeQueryValue(v));
                } else {
                    sp.set(key, this._encodeQueryValue(val));
                }
            }
            const s = sp.toString();
            return s ? `?${s}` : '';
        }

        _encodeQueryValue(v) {
            if (typeof v === 'boolean') return v ? 'true' : 'false';
            if (typeof v === 'number') return String(v);
            if (typeof v === 'string') return v;
            // Fallback: JSON for complex values
            try { return JSON.stringify(v); } catch (_) { return String(v); }
        }

        _hasCredentials() {
            return typeof this.username === 'string' && this.username.length > 0 && typeof this.password === 'string';
        }

        async _ensureBearerToken(force = false) {
            if (!force && this._jwtToken) return this._jwtToken;
            if (!this._hasCredentials()) return undefined;
            if (this._loginPromise) return this._loginPromise;
            this._loginPromise = this._performLogin().finally(() => { this._loginPromise = null; });
            return await this._loginPromise;
        }

        async _performLogin() {
            const body = this.deviceId ? { deviceId: this.deviceId } : undefined;
            const response = await this._request('/admin/login', {
                method: 'POST',
                body,
                authMode: 'basic',
                requiresAuth: false,
                skipAuthRetry: true,
            });
            const token = response && typeof response === 'object' ? response.token : undefined;
            if (!token) throw new Error('Login failed: token missing in response.');
            this._jwtToken = token;
            return token;
        }

        _buildBasicHeader() {
            if (!this._hasCredentials()) return null;
            const user = typeof this.username === 'string' ? this.username : '';
            const pass = typeof this.password === 'string' ? this.password : '';
            if (typeof btoa === 'function') return `Basic ${btoa(`${user}:${pass}`)}`;
            if (typeof globalThis.Buffer !== 'undefined') {
                return `Basic ${globalThis.Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
            }
            throw new Error('No base64 encoder available for Basic auth.');
        }

        /** Internal fetch wrapper with timeout, automatic login, and token refresh. */
        async _request(path, { method = 'GET', query, body, headers, requiresAuth, authMode = 'auto', skipAuthRetry = false } = {}) {
            const methodUpper = (method || 'GET').toUpperCase();
            const needsAuth = typeof requiresAuth === 'boolean' ? requiresAuth : methodUpper !== 'GET';
            const url = this.baseURL + (path.startsWith('/') ? path : `/${path}`) + (query ? this._buildQuery(query) : '');
            const hasBody = body !== undefined;
            const serializedBody = typeof body === 'string' ? body : (hasBody ? JSON.stringify(body) : undefined);
            let attempt = 0;
            let lastError;

            while (attempt < 2) {
                const h = new Headers(headers || {});
                if (!h.has('Accept')) h.set('Accept', 'application/json');
                if (hasBody && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
                if (this.deviceId && !h.has('X-Device-Id')) h.set('X-Device-Id', this.deviceId);

                if (authMode === 'basic') {
                    const basic = this._buildBasicHeader();
                    if (!basic) throw new Error('Username/password required for basic authentication.');
                    h.set('Authorization', basic);
                } else if (needsAuth) {
                    if (!this._jwtToken && this._hasCredentials()) {
                        await this._ensureBearerToken(attempt > 0);
                    }
                    if (this._jwtToken) h.set('Authorization', `Bearer ${this._jwtToken}`);
                }

                const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
                const to = this.timeout > 0 && ctrl ? setTimeout(() => ctrl.abort(), this.timeout) : undefined;
                const init = { method: methodUpper, headers: h, signal: ctrl ? ctrl.signal : undefined };
                if (serializedBody !== undefined) init.body = serializedBody;
                if (this.debug) console.log('BGRepeaters request:', methodUpper, url, { headers: Object.fromEntries(h.entries()), body });

                let res;
                try {
                    res = await this._fetch(url, init);
                } catch (err) {
                    if (to) clearTimeout(to);
                    if (this.debug) console.warn('BGRepeaters network error:', err);
                    throw err;
                }
                if (to) clearTimeout(to);

                const headerJwt = res?.headers?.get?.('x-new-jwt') || res?.headers?.get?.('X-New-JWT');
                if (headerJwt) this._jwtToken = headerJwt;

                const contentType = res.headers?.get ? (res.headers.get('content-type') || '') : '';
                const isJSON = typeof contentType === 'string' && contentType.includes('application/json');
                const payload = isJSON ? await res.json().catch(() => undefined) : await res.text().catch(() => undefined);

                if (!res.ok) {
                    if (res.status === 401 && needsAuth && authMode !== 'basic' && attempt === 0 && !skipAuthRetry && this._hasCredentials()) {
                        this._jwtToken = undefined;
                        attempt++;
                        continue;
                    }
                    const error = new Error(`HTTP ${res.status} ${res.statusText}`);
                    error.status = res.status;
                    error.statusText = res.statusText;
                    error.body = payload;
                    lastError = error;
                    if (this.debug) console.warn('BGRepeaters error response:', error);
                    throw error;
                }

                return payload;
            }

            if (lastError) throw lastError;
            throw new Error('Request failed after retries.');
        }

        // ============= PUBLIC API METHODS =============

        /**
         * GET /v1/
         * Fetch repeaters by optional filters. Provide at least one property to avoid fetching everything.
         * Example: getRepeaters({ callsign: 'LZ0BOT' })
         * @param {Object} [query]
         * @example
         * const list = await api.getRepeaters({ callsign: 'LZ0BOT' })
         * const uhf = await api.getRepeaters({ have_rx_from: 430000000, have_rx_to: 440000000 })
         * const digital = await api.getRepeaters({ have_dmr: true, have_dstar: true })
         * @returns {Promise<Array<Object>>}
         */
        async getRepeaters(query = {}) {
            // Allow calling without params: return all enabled repeaters
            const hasQuery = query && Object.keys(query).length > 0;
            return await this._request('/', { method: 'GET', query: hasQuery ? query : undefined });
        }

        /** Fetch both enabled and disabled repeaters in one call. */
        async getAllRepeaters() {
            return await this.getRepeaters({ include_disabled: true });
        }

        /**
         * GET /v1/{callsign}
         * @param {string} callsign
         * @example
         * const r = await api.getRepeater('LZ0BOT')
         * @returns {Promise<Object>}
         */
        async getRepeater(callsign) {
            if (!callsign || typeof callsign !== 'string') throw new Error('getRepeater(callsign): callsign is required');
            return await this._request(`/${encodeURIComponent(callsign)}`, { method: 'GET' });
        }

        /**
         * POST /v1/
         * Create a repeater (requires basic auth)
         * @param {Object} data - Repeater object as defined by the API (RepeaterSchema)
         * @example
         * api.setAuth('admin','pw')
         * const created = await api.createRepeater({
         *   callsign: 'LZ0XXX', keeper: 'LZ2SLL', latitude: 42.7, longitude: 23.3, place: 'София', altitude: 500,
         *   modes: {
         *     fm: { enabled: true },
         *     dmr: { enabled: true, network: 'BrandMeister', color_code: '1', callid: '284040', reflector: 'XLX023 ipsc2', ts1_groups: '284,91', ts2_groups: '2840', info: 'Static 284 on TS1' },
         *     dstar: { enabled: true, reflector: 'XLX359 B', module: 'B', gateway: 'your-gw', info: 'Links on demand' },
         *     fusion: { enabled: true, reflector: 'YSF359', tg: '284', room: 'BG ROOM', dgid: '00', wiresx_node: '12345' },
         *     nxdn: { enabled: true, network: 'NXDNReflector', ran: '1' }
         *   },
         *   freq: { rx: 430700000, tx: 438300000, tone: 79.7 }
         * })
         * @returns {Promise<Object>}
         */
        async createRepeater(data) {
            if (!data || typeof data !== 'object') throw new Error('createRepeater(data): data object is required');
            return await this._request('/', { method: 'POST', body: data, requiresAuth: true });
        }

        /**
         * PUT /v1/{callsign}
         * Update a repeater (requires basic auth)
         * @param {string} callsign
         * @param {Object} data - Partial or full repeater object
         * @example
         * api.setAuth('admin','pw')
         * const updated = await api.updateRepeater('LZ0XXX', { place: 'Пловдив', modes: { fm: true, dmr: true } })
         * @returns {Promise<Object>}
         */
        async updateRepeater(callsign, data) {
            if (!callsign || typeof callsign !== 'string') throw new Error('updateRepeater(callsign, data): callsign is required');
            if (!data || typeof data !== 'object') throw new Error('updateRepeater(callsign, data): data object is required');
            return await this._request(`/${encodeURIComponent(callsign)}`, { method: 'PUT', body: data, requiresAuth: true });
        }

        /**
         * DELETE /v1/{callsign}
         * Remove a repeater (requires basic auth)
         * @param {string} callsign
         * @example
         * api.setAuth('admin','pw')
         * await api.deleteRepeater('LZ0XXX')
         * @returns {Promise<Object>}
         */
        async deleteRepeater(callsign) {
            if (!callsign || typeof callsign !== 'string') throw new Error('deleteRepeater(callsign): callsign is required');
            return await this._request(`/${encodeURIComponent(callsign)}`, { method: 'DELETE', requiresAuth: true });
        }

        /** POST /v1/admin/logout - bump token_version to force re-authentication everywhere. */
        async logout() {
            const res = await this._request('/admin/logout', { method: 'POST', requiresAuth: true });
            this._jwtToken = undefined;
            return res;
        }

        /**
         * GET /v1/changelog
         * Fetch changelog overview
         * @example
         * const { lastChanged, changes } = await api.getChangelog()
         * @returns {Promise<{ lastChanged: string|null, changes: Array<{date:string, who:string, info:string}> }>}
         */
        async getChangelog() {
            return await this._request('/changelog', { method: 'GET' });
        }

        /**
         * GET /v1/doc
         * Fetch OpenAPI definition
         * @example
         * const spec = await api.getDoc()
         * @returns {Promise<Object>}
         */
        async getDoc() {
            return await this._request('/doc', { method: 'GET' });
        }
    }

    // Internal CSV helper constants and functions
    const CSV_NEWLINE = '\r\n';
    const CSV_BOM = '\ufeff';
    const CSV_MIME_TYPE = 'text/csv';
    const CSV_FILENAME_PREFIX = 'CHIRP_repeaters';
    const DEFAULT_TONE = 79.7;
    const MAX_SIMPLE_OFFSET_MHZ = 8;
    const MODE_ALIAS = Object.freeze({
        fm: 'analog',
        fm_analog: 'analog',
        analog: 'analog',
        am: 'analog',
        usb: 'analog',
        lsb: 'analog',
        ssb: 'analog',
        simplex: 'analog',
        beacon: 'analog',
        parrot: 'parrot',
        dmr: 'dmr',
        dstar: 'dstar',
        fusion: 'fusion',
        ysf: 'fusion',
        c4fm: 'fusion',
        nxdn: 'nxdn',
    });
    const MODE_FILTERS = Object.freeze({
        all: () => true,
        analog: (map) => !!map.analog,
        dmr: (map) => !!map.dmr,
        dstar: (map) => !!map.dstar,
        fusion: (map) => !!map.fusion,
        nxdn: (map) => !!map.nxdn,
        parrot: (map) => !!map.parrot,
    });
    const CHIRP_COLUMNS = Object.freeze([
        { key: 'Location', header: 'Location' },
        { key: 'Name', header: 'Name' },
        { key: 'Frequency', header: 'Frequency' },
        { key: 'Duplex', header: 'Duplex' },
        { key: 'Offset', header: 'Offset' },
        { key: 'Tone', header: 'Tone' },
        { key: 'rToneFreq', header: 'rToneFreq' },
        { key: 'cToneFreq', header: 'cToneFreq' },
        { key: 'Mode', header: 'Mode' },
        { key: 'Comment', header: 'Comment' },
    ]);

    function resolveMode(mode) {
        const key = typeof mode === 'string' && mode.trim().length ? mode.trim().toLowerCase() : 'all';
        if (!MODE_FILTERS[key]) throw new Error(`Unsupported CHIRP export mode: ${mode}`);
        return key;
    }

    function hzToMHz(value) {
        if (value === undefined || value === null) return undefined;
        const num = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(num)) return undefined;
        if (Math.abs(num) > 1000) return num / 1e6;
        return num;
    }

    function normalizeInfoLines(info) {
        if (Array.isArray(info)) {
            return info.map(stripHtml).map(trimString).filter(Boolean);
        }
        if (info === undefined || info === null) return [];
        return [stripHtml(info)].map(trimString).filter(Boolean);
    }

    function stripHtml(value) {
        return String(value === undefined || value === null ? '' : value).replace(/<[^>]+>/g, '');
    }

    function trimString(value) {
        return String(value).trim();
    }

    function extractTone(freq = {}) {
        const candidates = [freq.tone, freq.ctcss];
        for (const candidate of candidates) {
            const num = toNumber(candidate);
            if (Number.isFinite(num)) return num;
        }
        return undefined;
    }

    function toNumber(value) {
        if (value === undefined || value === null) return undefined;
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && value.trim().length) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    function isModeEnabled(value) {
        if (value === undefined || value === null) return false;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') return value.trim().length > 0;
        if (typeof value === 'object') {
            if (Object.prototype.hasOwnProperty.call(value, 'enabled')) return !!value.enabled;
            return Object.values(value).some((v) => isModeEnabled(v));
        }
        return false;
    }

    function collectModeTags(modes) {
        const out = {};
        if (!modes || typeof modes !== 'object') return out;
        Object.keys(modes).forEach((key) => {
            const alias = MODE_ALIAS[key.toLowerCase()] || key.toLowerCase();
            if (isModeEnabled(modes[key])) out[alias] = true;
        });
        return out;
    }

    function buildLocationLabel(place, extra) {
        const base = typeof place === 'string' ? place.trim() : (place ? String(place).trim() : '');
        const extraPart = typeof extra === 'string' && extra.trim().length ? ` - ${extra.trim()}` : '';
        return (base || extraPart) ? `${base}${extraPart}` : '';
    }

    function getChannelFromMHz(rxMHz) {
        if (!Number.isFinite(rxMHz)) return 'N/A';
        const f = Math.round(rxMHz * 10000);
        let chan = 'N/A';
        if (f >= 1452000 && f < 1454000 && (f - 1452000) % 250 === 0) {
            chan = 'R' + parseInt(((f - 1452000) / 250) + 8, 10);
        } else if (f >= 1456000 && f < 1460000 && (f - 1456000) % 250 === 0) {
            chan = 'R' + parseInt((f - 1456000) / 250, 10);
        } else if (f >= 4300000 && f < 4400000 && (f - 4300000) % 125 === 0) {
            const idx = ((f - 4300000) / 125).toFixed(0);
            chan = 'RU' + idx.padStart(3, '0');
        }
        if (f >= 1450000 && f < 1460000 && (f - 1450000) % 125 === 0) {
            const rv = ((f - 1450000) / 125).toFixed(0).padStart(2, '0');
            chan = (chan === 'N/A' ? '' : `${chan}, `) + `RV${rv}`;
        }
        return chan;
    }

    function normalizeRepeaterForCsv(repeater) {
        if (!repeater || typeof repeater !== 'object') return null;
        if (!repeater.callsign) return null;
        const freq = repeater.freq || {};
        const rxMHz = hzToMHz(freq.tx);
        const txMHz = hzToMHz(freq.rx);
        if (!Number.isFinite(rxMHz) || !Number.isFinite(txMHz)) return null;
        const channel = typeof freq.channel === 'string' && freq.channel.trim().length ? freq.channel.trim() : getChannelFromMHz(rxMHz);
        const tone = extractTone(freq);
        const infoLines = normalizeInfoLines(repeater.info);
        const locationLabel = buildLocationLabel(repeater.place, repeater.location);
        const modesMap = collectModeTags(repeater.modes || {});
        const modesList = Object.keys(modesMap).sort();
        return {
            callsign: String(repeater.callsign),
            rxMHz,
            txMHz,
            tone,
            channel: channel || 'N/A',
            infoLines,
            locationLabel,
            modesMap,
            modesList,
        };
    }

    function formatNumber(value, digits) {
        return Number.isFinite(value) ? Number(value).toFixed(digits) : '';
    }

    function formatFrequencyValue(value) {
        if (!Number.isFinite(value)) return '';
        const str = Number(value).toFixed(6);
        return str.replace(/(\.\d{3})000$/, '$1');
    }

    function sanitizeComment(value) {
        if (!value) return '';
        return String(value).replace(/\r?\n/g, ', ').replace(/,?\s*$/, '');
    }

    function buildCommentParts(data) {
        const parts = [];
        if (data.channel && data.channel !== 'N/A') parts.push(`Chan: ${data.channel}`);
        const modesLabel = data.modesList.length ? data.modesList.join('+') : 'n/a';
        parts.push(`Modes: ${modesLabel}`);
        if (data.locationLabel) parts.push(data.locationLabel);
        if (data.infoLines.length) parts.push(data.infoLines.join(', '));
        return parts;
    }

    function buildChirpRow(data, index) {
        const delta = data.txMHz - data.rxMHz;
        let duplex = '';
        if (Number.isFinite(delta)) {
            if (delta < 0) duplex = '-';
            else if (delta > 0) duplex = '+';
        }
        let offset = Math.abs(delta);
        if (!Number.isFinite(offset)) offset = 0;
        if (offset > MAX_SIMPLE_OFFSET_MHZ) {
            duplex = 'split';
            offset = data.txMHz;
        }
        const toneValue = Number.isFinite(data.tone) && data.tone > 0 ? data.tone : undefined;
        const toneLabel = toneValue !== undefined ? 'TSQL' : '';
        const toneFreq = toneValue !== undefined ? toneValue : DEFAULT_TONE;
        const csvMode = data.modesMap.analog || data.modesMap.parrot ? 'FM' : (data.modesMap.dmr ? 'DMR' : 'Auto');
        const comment = sanitizeComment(buildCommentParts(data).join('\r\n'));
        return {
            Location: String(index),
            Name: data.callsign || '',
            Frequency: formatFrequencyValue(data.rxMHz),
            Duplex: duplex,
            Offset: formatFrequencyValue(offset),
            Tone: toneLabel,
            rToneFreq: formatNumber(toneFreq, 1),
            cToneFreq: formatNumber(toneFreq, 1),
            Mode: csvMode,
            Comment: comment,
        };
    }

    function csvEscape(value) {
        const str = value === undefined || value === null ? '' : String(value);
        if (/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
        return str;
    }

    function buildCsvText(rows) {
        const header = CHIRP_COLUMNS.map((col) => col.header).join(',');
        const body = rows.map((row) => CHIRP_COLUMNS.map((col) => csvEscape(row[col.key])).join(',')).join(CSV_NEWLINE);
        const content = body.length ? `${header}${CSV_NEWLINE}${body}` : header;
        return `${CSV_BOM}${content}${CSV_NEWLINE}`;
    }

    function stringToUint8(str) {
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(str);
        }
        if (typeof Buffer !== 'undefined') {
            return Uint8Array.from(Buffer.from(str, 'utf8'));
        }
        throw new Error('TextEncoder is not available; please provide a polyfill before using buildChirpCsv.');
    }

    function buildChirpPayloadFromRepeaters(repeaters, opts = {}) {
        if (!Array.isArray(repeaters)) throw new Error('buildChirpCsv requires a repeaters array.');
        const mode = resolveMode(opts.mode);
        const predicate = MODE_FILTERS[mode] || MODE_FILTERS.all;
        const normalized = repeaters.map(normalizeRepeaterForCsv).filter(Boolean);
        const filtered = normalized.filter((item) => predicate(item.modesMap || {}));
        const rows = filtered.map((item, idx) => buildChirpRow(item, idx));
        const csvText = buildCsvText(rows);
        const filename = `${CSV_FILENAME_PREFIX}_${mode}.csv`;
        return {
            mode,
            filename,
            mimeType: CSV_MIME_TYPE,
            rowCount: rows.length,
            bytes: stringToUint8(csvText),
            csvText,
        };
    }

    function ensureBrowserEnvironment() {
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            throw new Error('downloadChirpCsv() is only available in browser environments.');
        }
    }

    function triggerBrowserDownload(payload) {
        ensureBrowserEnvironment();
        if (!payload || !(payload.bytes instanceof Uint8Array)) throw new Error('Invalid CSV payload provided for download.');
        const blob = new Blob([payload.bytes], { type: payload.mimeType || CSV_MIME_TYPE });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = payload.filename || `${CSV_FILENAME_PREFIX}.csv`;
        link.style.position = 'fixed';
        link.style.left = '-9999px';
        document.body.appendChild(link);
        try {
            link.click();
        } finally {
            setTimeout(() => {
                URL.revokeObjectURL(link.href);
                link.remove();
            }, 1000);
        }
    }

    // Static version (class-level)
    BGRepeaters.VERSION = BGREPEATERS_VERSION;

    // JSDoc quick examples
    /**
     * Example usage:
     *
     * const api = new BGRepeaters({ baseURL: 'https://api.varna.radio/v1', debug: false });
     * const one = await api.getRepeater('LZ0BOT');
     * const list = await api.getRepeaters({ have_dmr: true, have_rx_from: 430000000, have_rx_to: 440000000 });
     *
     * // version
     * console.log(BGRepeaters.VERSION) // e.g. '1.0.0'
     * console.log(api.version)         // e.g. '1.0.0'
     *
     * // write ops:
     * api.setAuth('admin', 'password');
     * await api.createRepeater({ callsign: 'LZ0XXX', ... });
     * await api.updateRepeater('LZ0XXX', { place: 'New place' });
     * await api.deleteRepeater('LZ0XXX');
     */

    return BGRepeaters;
});
