/**
 * store.mjs — Standing user directives for the agent.
 *
 * A directive is a general operating instruction the user gives via "Propose a Plan" /propose —
 * e.g. "prioritize quick flips with idle buying power", "focus on energy + defense", "be patient,
 * only A+ setups". Unlike a stance (which is per-stock) a directive shapes HOW the agent decides
 * across the board. Active directives are injected into the analyst context every sweep.
 *
 * Output: runs/directives.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR   = join(__dirname, '../../runs');
const PATH       = join(RUNS_DIR, 'directives.json');
const MAX        = parseInt(process.env.MAX_DIRECTIVES || '6', 10);

function ensureDir() { if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true }); }

export function getDirectives() {
  ensureDir();
  if (!existsSync(PATH)) return [];
  try {
    const arr = JSON.parse(readFileSync(PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.error('[Directives] parse failed:', e.message); return []; }
}

function save(list) {
  ensureDir();
  writeFileSync(PATH, JSON.stringify(list, null, 2), 'utf8');
}

/** Add a directive (newest first, capped at MAX, de-duplicated by text). Returns the new list. */
export function addDirective(text) {
  const t = String(text || '').trim().slice(0, 240);
  if (!t) return getDirectives();
  const list = getDirectives().filter(d => d.text.toLowerCase() !== t.toLowerCase());
  list.unshift({ id: randomUUID(), text: t, createdAt: new Date().toISOString() });
  const capped = list.slice(0, MAX);
  save(capped);
  return capped;
}

export function removeDirective(id) {
  const list = getDirectives().filter(d => d.id !== id);
  save(list);
  return list;
}

export function clearDirectives() { save([]); return []; }

/** Compact digest for the analyst context. */
export function formatDirectivesForLLM() {
  const list = getDirectives();
  if (!list.length) return 'none';
  return list.map(d => `- ${d.text}`).join('\n  ');
}
