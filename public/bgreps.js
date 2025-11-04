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
 * Write operations (require Basic Auth):
 * api.setAuth('admin', 'password')
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
 * - GET    /v1/doc              -> getDoc()
 *
 * Auth: Basic auth is required for all non-GET endpoints. Provide username/password in options.
 *
 * @version 1.0.0
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
         * @param {string} [opts.username] Basic auth username for write operations
         * @param {string} [opts.password] Basic auth password for write operations
         * @param {number} [opts.timeout]  Request timeout in ms (default: 10000)
         * @param {boolean} [opts.debug]   Log debug info to console
         * @param {typeof fetch} [opts.fetch] Custom fetch implementation (optional)
         */
        constructor(opts = {}) {
            this.baseURL = (opts.baseURL || 'https://api.varna.radio/v1').replace(/\/$/, '');
            this.username = opts.username || undefined;
            this.password = opts.password || undefined;
            this.timeout = typeof opts.timeout === 'number' ? opts.timeout : 10000;
            this.debug = !!opts.debug;
            this._fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
            if (!this._fetch) throw new Error('fetch() not available. Provide opts.fetch or run in an environment with fetch.');
        }

        /** Library version (instance accessor) */
        get version() { return BGRepeaters.VERSION; }

        /** Set or update basic auth credentials. */
        setAuth(username, password) { this.username = username; this.password = password; return this; }

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

        /** Internal fetch wrapper with timeout and auth. */
        async _request(path, { method = 'GET', query, body, headers } = {}) {
            const url = this.baseURL + (path.startsWith('/') ? path : `/${path}`) + (query ? this._buildQuery(query) : '');
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
            const to = this.timeout > 0 && ctrl ? setTimeout(() => ctrl.abort(), this.timeout) : undefined;
            const h = new Headers(headers || {});
            if (!h.has('Accept')) h.set('Accept', 'application/json');
            if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
            if (this.username || this.password) {
                const token = btoa(`${this.username || ''}:${this.password || ''}`);
                h.set('Authorization', `Basic ${token}`);
            }
            const init = { method, headers: h, signal: ctrl ? ctrl.signal : undefined };
            if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
            if (this.debug) console.log('BGRepeaters request:', method, url, { headers: Object.fromEntries(h.entries()), body });

            let res;
            try {
                res = await this._fetch(url, init);
            } catch (err) {
                if (to) clearTimeout(to);
                if (this.debug) console.warn('BGRepeaters network error:', err);
                throw err;
            }
            if (to) clearTimeout(to);

            const contentType = res.headers.get('content-type') || '';
            const isJSON = contentType.includes('application/json');
            const payload = isJSON ? await res.json().catch(() => undefined) : await res.text().catch(() => undefined);

            if (!res.ok) {
                const error = new Error(`HTTP ${res.status} ${res.statusText}`);
                error.status = res.status;
                error.statusText = res.statusText;
                error.body = payload;
                if (this.debug) console.warn('BGRepeaters error response:', error);
                throw error;
            }
            return payload;
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
            // Allow calling without params: return all repeaters
            const hasQuery = query && Object.keys(query).length > 0;
            return await this._request('/', { method: 'GET', query: hasQuery ? query : undefined });
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
         * const created = await api.createRepeater({ callsign: 'LZ0XXX', keeper: 'LZ2SLL', latitude: 42.7, longitude: 23.3, place: 'София', altitude: 500, modes: { fm: true }, freq: { rx: 430700000, tx: 438300000, tone: 79.7 } })
         * @returns {Promise<Object>}
         */
        async createRepeater(data) {
            if (!data || typeof data !== 'object') throw new Error('createRepeater(data): data object is required');
            return await this._request('/', { method: 'POST', body: data });
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
            return await this._request(`/${encodeURIComponent(callsign)}`, { method: 'PUT', body: data });
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
            return await this._request(`/${encodeURIComponent(callsign)}`, { method: 'DELETE' });
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
    BGRepeaters.VERSION = '1.0.0';

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
