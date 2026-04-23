/**
 * sectorCache.mjs — Persistent ticker → sector classification store
 *
 * Whenever Scout picks a stock it outputs "- Sector: [name]".
 * debate.mjs parses that tag and calls setSectorForTicker() here.
 * buildPortfolioComposition() in scout.mjs reads getSectorCacheMap()
 * to classify held tickers that aren't in the SECTOR_GROUPS seed list.
 *
 * This makes sector bias fully dynamic:
 *  • Known tickers → matched by SECTOR_GROUPS (bootstrap seed)
 *  • New / emergent tickers → classified by Scout at pick time, stored here
 *  • Unknown held tickers → shown as "Unclassified" until Scout picks them
 *
 * File: runs/sectorCache.json  { "AAPL": "tech", "KTOS": "defense", ... }
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const _dir      = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = join(_dir, '../../../../runs');
const CACHE_PATH = join(CACHE_DIR, 'sectorCache.json');

function _load() {
    if (!existsSync(CACHE_PATH)) return {};
    try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); }
    catch { return {}; }
}

function _save(cache) {
    try {
        if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.error('[SectorCache] Write failed:', e.message);
    }
}

/**
 * Returns the cached sector string for a ticker, or null if unknown.
 * @param {string} ticker
 * @returns {string|null}
 */
export function getSectorForTicker(ticker) {
    if (!ticker) return null;
    return _load()[ticker.toUpperCase()] || null;
}

/**
 * Persists a ticker → sector mapping learned from Scout's output.
 * Sector names are stored in lowercase for consistent grouping.
 * @param {string} ticker
 * @param {string} sector  — free-form name (Scout may coin new names for emergent sectors)
 */
export function setSectorForTicker(ticker, sector) {
    if (!ticker || !sector) return;
    const t = ticker.toUpperCase().trim();
    const s = sector.toLowerCase().trim();
    const cache = _load();
    if (cache[t] === s) return; // no-op if unchanged
    cache[t] = s;
    _save(cache);
    console.log(`[SectorCache] 📂 ${t} → "${s}" (learned from Scout pick)`);
}

/**
 * Returns the full cache map for batch lookups.
 * @returns {Record<string, string>}
 */
export function getSectorCacheMap() {
    return _load();
}
