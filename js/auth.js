// Accounts and passwords for this device.
//
// Several people can use one browser: each account has its own password and
// its own files. Only a PBKDF2-SHA256 hash with a random salt is stored, never
// the password itself. Nothing is remembered between visits — the password is
// asked for every time the page is opened.

import { db } from './db.js';

const USERS_KEY = 'users';
const LEGACY_KEY = 'account'; // the old single-account record
const LEGACY_ID = 'u_legacy';
const LEGACY_UNLOCK_KEY = 'dd.unlock';
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

async function readUsers() {
  const record = await db.getSetting(USERS_KEY);
  return record && Array.isArray(record.value) ? record.value : [];
}

async function writeUsers(users) {
  await db.putSetting(USERS_KEY, users);
}

export async function listUsers() {
  return readUsers();
}

export async function hasUsers() {
  const users = await readUsers();
  return users.length > 0;
}

export async function createUser(name, password) {
  const users = await readUsers();
  const clean = String(name || '').trim() || `User ${users.length + 1}`;

  if (users.some((user) => user.name.toLowerCase() === clean.toLowerCase())) {
    // Deliberately neutral: this screen must not confirm which names exist.
    throw new Error("That name can't be used here — choose another.");
  }

  const salt = randomHex(16);
  const hash = await derive(password, salt);
  const user = {
    id: `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    salt,
    hash,
    createdAt: Date.now(),
  };

  users.push(user);
  await writeUsers(users);
  return user;
}

export async function verifyUser(userId, password) {
  const users = await readUsers();
  const user = users.find((entry) => entry.id === userId);
  if (!user || !user.salt) return false;

  const hash = await derive(password, user.salt);
  return hash === user.hash;
}

export async function changePassword(userId, currentPassword, nextPassword) {
  if (!(await verifyUser(userId, currentPassword))) return false;

  const users = await readUsers();
  const user = users.find((entry) => entry.id === userId);
  if (!user) return false;

  user.salt = randomHex(16);
  user.hash = await derive(nextPassword, user.salt);
  user.updatedAt = Date.now();
  await writeUsers(users);
  return true;
}

export async function renameUser(userId, name) {
  const clean = String(name || '').trim();
  if (!clean) return false;

  const users = await readUsers();
  if (users.some((user) => user.id !== userId && user.name.toLowerCase() === clean.toLowerCase())) {
    return false;
  }
  const user = users.find((entry) => entry.id === userId);
  if (!user) return false;

  user.name = clean;
  await writeUsers(users);
  return true;
}

export async function removeUser(userId) {
  const users = await readUsers();
  await writeUsers(users.filter((user) => user.id !== userId));
}

// Upgrades the old single-account layout into an account called "My drive",
// so existing files and password keep working.
export async function migrateLegacyAccount() {
  const users = await readUsers();
  if (users.length) return users;

  const legacy = await db.getSetting(LEGACY_KEY);
  if (!legacy || !legacy.value || !legacy.value.hash) return users;

  const user = {
    id: LEGACY_ID,
    name: 'My drive',
    salt: legacy.value.salt,
    hash: legacy.value.hash,
    createdAt: legacy.value.createdAt || Date.now(),
  };

  await writeUsers([user]);
  await db.deleteSetting(LEGACY_KEY);
  return [user];
}

// The password is never remembered: clear any leftover "stay unlocked" token
// from older versions of the app.
export function forgetSession() {
  try {
    localStorage.removeItem(LEGACY_UNLOCK_KEY);
    localStorage.removeItem('dd.unlocked');
  } catch (error) {
    /* storage can be blocked; nothing to do */
  }
}
