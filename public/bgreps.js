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
 * @version 1.5.0
 * @license MIT - https://af.mit-license.org/
 */

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
         * Flatten a repeater object by adding legacy root-level fields alongside the nested structure.
         * This is a convenience for consumers still expecting old keys like mode_fm, freq_rx, net_echolink, dmr_* etc.
         * Does not mutate the original object by default.
         * @param {Object} repeater - Repeater as returned by the API
         * @param {Object} [opts]
         * @param {boolean} [opts.mutate=false] - If true, mutate the input object; otherwise return a shallow-cloned copy
         * @returns {Object} - Repeater with additional legacy root-level fields
         */
        static flatten(repeater, opts = {}) {
            if (!repeater || typeof repeater !== 'object') return repeater;
            const mutate = !!opts.mutate;
            const r = mutate ? repeater : { ...repeater };
            const m = r.modes || {};
            const f = r.freq || {};
            const net = r.internet || {};

            // Modes (numeric 1/0 like the old API). Support both boolean and object children.
            const enabled = (v) => (typeof v === 'object' && v !== null ? !!v.enabled : !!v);
            r.mode_fm = enabled(m.fm) ? 1 : 0;
            r.mode_am = enabled(m.am) ? 1 : 0;
            r.mode_usb = enabled(m.usb) ? 1 : 0;
            r.mode_lsb = enabled(m.lsb) ? 1 : 0;
            r.mode_dmr = enabled(m.dmr) ? 1 : 0;
            r.mode_dstar = enabled(m.dstar) ? 1 : 0;
            r.mode_fusion = enabled(m.fusion) ? 1 : 0;
            r.mode_nxdn = enabled(m.nxdn) ? 1 : 0;
            r.mode_parrot = enabled(m.parrot) ? 1 : 0;
            r.mode_beacon = enabled(m.beacon) ? 1 : 0;

            // Frequencies
            r.freq_rx = f.rx;
            r.freq_tx = f.tx;
            r.tone = f.tone;

            // Internet
            r.net_echolink = net.echolink;
            r.net_allstarlink = net.allstarlink;
            r.net_zello = net.zello;
            r.net_other = net.other;

            // Digital details now live under modes children
            const dmr = m.dmr || {};
            r.dmr_network = dmr.network;
            r.dmr_ts1_groups = dmr.ts1_groups;
            r.dmr_ts2_groups = dmr.ts2_groups;
            r.dmr_info = dmr.info;
            r.dmr_color_code = dmr.color_code;
            r.dmr_callid = dmr.callid;
            r.dmr_reflector = dmr.reflector;

            const dstar = m.dstar || {};
            r.dstar_reflector = dstar.reflector;
            r.dstar_info = dstar.info;
            r.dstar_module = dstar.module;
            r.dstar_gateway = dstar.gateway;

            const fusion = m.fusion || {};
            r.fusion_reflector = fusion.reflector;
            r.fusion_tg = fusion.tg;
            r.fusion_info = fusion.info;
            r.fusion_room = fusion.room;
            r.fusion_dgid = fusion.dgid;
            r.fusion_wiresx_node = fusion.wiresx_node;

            const nxdn = m.nxdn || {};
            r.nxdn_ran = nxdn.ran;
            r.nxdn_network = nxdn.network;

            return r;
        }

        /** Instance convenience wrapper around static flatten. */
        flatten(repeater, opts = {}) { return BGRepeaters.flatten(repeater, opts); }

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

    // Static version (class-level)
    BGRepeaters.VERSION = '1.5.0';

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
