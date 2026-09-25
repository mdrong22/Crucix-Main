/**
 * store.mjs — Pending Trade-Proposal Persistence
 *
 * Backs the single-agent Accept/Deny model. Each cycle the Analyst may emit ONE proposal
 * (NEW_BUY or MAINTENANCE); it lands here as PENDING with an expiry. The user Accepts/Denies
 * from Telegram; expired proposals are swept out (and their Telegram card deleted by the caller).
 *
 * Output: runs/proposals.json — full history (all statuses kept for audit).
 *
 * Status lifecycle: PENDING → ACCEPTED | DENIED | EXPIRED | EXECUTED | FAILED
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR  = join(__dirname, '../../runs');
const STORE_PATH = join(RUNS_DIR, 'proposals.json');

const DEFAULT_TTL_MIN = parseInt(process.env.PROPOSAL_TTL_MINUTES || '120', 10);

function ensureDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

export function loadProposals() {
  ensureDir();
  if (!existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    console.error('[Proposals] Failed to parse proposals.json:', e.message);
    return [];
  }
}

function save(entries) {
  ensureDir();
  writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

/**
 * Persist a new proposal as PENDING. Returns the stored record (with id + expiresAt).
 * @param {object} p Analyst proposal fields (action/title/desc/ticker/side/order params/expiresInMinutes…)
 */
export function createProposal(p) {
  const entries = loadProposals();
  const now = Date.now();
  const ttlMin = Number.isFinite(p.expiresInMinutes) && p.expiresInMinutes > 0
    ? p.expiresInMinutes
    : DEFAULT_TTL_MIN;
  const record = {
    id:        randomUUID(),
    status:    'PENDING',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMin * 60 * 1000).toISOString(),
    telegramMessageId: null,
    ...p,
  };
  entries.push(record);
  save(entries);
  return record;
}

export function getProposal(id) {
  return loadProposals().find(e => e.id === id) || null;
}

export function getPending() {
  return loadProposals().filter(e => e.status === 'PENDING');
}

/** Update status (+ optional extra fields, e.g. telegramMessageId, orderId, error). */
export function setStatus(id, status, extra = {}) {
  const entries = loadProposals();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) { console.warn(`[Proposals] setStatus: id ${id} not found`); return false; }
  entries[idx] = { ...entries[idx], status, ...extra, updatedAt: new Date().toISOString() };
  save(entries);
  return true;
}

/** Convenience for storing the Telegram message id right after sending the card. */
export function attachMessageId(id, telegramMessageId) {
  return setStatus(id, 'PENDING', { telegramMessageId });
}

/**
 * Find PENDING proposals whose expiry has passed, mark them EXPIRED, and return them
 * (so the caller can delete their Telegram cards). Called once per sweep.
 */
export function expireStale() {
  const entries = loadProposals();
  const now = Date.now();
  const expired = [];
  let changed = false;
  for (const e of entries) {
    if (e.status === 'PENDING' && new Date(e.expiresAt).getTime() <= now) {
      e.status = 'EXPIRED';
      e.updatedAt = new Date().toISOString();
      expired.push({ ...e });
      changed = true;
    }
  }
  if (changed) save(entries);
  return expired;
}

/** True if a PENDING proposal already exists for this ticker (avoid duplicate open offers). */
export function hasPendingForTicker(ticker) {
  if (!ticker) return false;
  const t = String(ticker).toUpperCase();
  return getPending().some(e => String(e.ticker || '').toUpperCase() === t);
}
