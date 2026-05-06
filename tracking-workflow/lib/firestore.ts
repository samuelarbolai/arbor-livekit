import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let initialized = false;

function init() {
  if (initialized) return;
  // Vercel can't mount JSON files, so the service account is a base64-encoded
  // env var. Decode → JSON.parse → cert. `getApps().length` guards against
  // double-init in dev hot-reload.
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
    initializeApp({
      credential: cert(JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))),
    });
  }
  initialized = true;
}

export function db() {
  init();
  return getFirestore();
}
