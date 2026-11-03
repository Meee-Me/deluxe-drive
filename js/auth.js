// Password handling. The password itself is never stored: a PBKDF2-SHA256 hash
// with a random salt lives in IndexedDB, and "keep me unlocked on this device"
// remembers that hash in localStorage. Changing the password changes the hash,
// which also invalidates a remembered unlock.

import { db } from './db.js';

const ACCOUNT_KEY = 'account';
const UNLOCK_KEY = 'dd.unlock';
const ITERATIONS = 120000;

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const clean = String(hex || '');
  if (clean.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(byteLength) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function derive(password, saltHex) {
  if (!window.crypto || !crypto.subtle) {
    throw new Error('This browser cannot hash passwords securely. Open the drive over https.');
  }
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function readAccount() {
  const record = await db.getSetting(ACCOUNT_KEY);
  return record && record.value ? record.value : null;
}

export async function hasAccount() {
  const account = await readAccount();
  return Boolean(account && account.hash && account.salt);
}

export async function createAccount(password) {
  const salt = randomHex(16);
  const hash = await derive(password, salt);
  await db.putSetting(ACCOUNT_KEY, { salt, hash, createdAt: Date.now() });
  return hash;
}

export async function verify(password) {
  const account = await readAccount();
  if (!account || !account.salt) return false;
  const hash = await derive(password, account.salt);
  return hash === account.hash;
}

export async function changePassword(currentPassword, nextPassword) {
  if (!(await verify(currentPassword))) return false;
  const salt = randomHex(16);
  const hash = await derive(nextPassword, salt);
  await db.putSetting(ACCOUNT_KEY, { salt, hash, createdAt: Date.now() });
  if (wasRemembered()) localStorage.setItem(UNLOCK_KEY, hash);
  return true;
}

export async function remember(enabled) {
  const account = await readAccount();
  if (enabled && account) localStorage.setItem(UNLOCK_KEY, account.hash);
  else localStorage.removeItem(UNLOCK_KEY);
}

export function wasRemembered() {
  return Boolean(localStorage.getItem(UNLOCK_KEY));
}

export async function tryRestore() {
  const stored = localStorage.getItem(UNLOCK_KEY);
  if (!stored) return false;
  const account = await readAccount();
  if (!account || account.hash !== stored) {
    localStorage.removeItem(UNLOCK_KEY);
    return false;
  }
  return true;
}

export function forget() {
  localStorage.removeItem(UNLOCK_KEY);
}

export async function destroyAccount() {
  await db.deleteSetting(ACCOUNT_KEY);
  localStorage.removeItem(UNLOCK_KEY);
}
