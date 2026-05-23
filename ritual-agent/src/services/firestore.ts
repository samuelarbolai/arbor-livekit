import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let initialized = false;

function initFirebase(): void {
  if (initialized || getApps().length > 0) {
    initialized = true;
    return;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  initializeApp({ credential: cert(JSON.parse(raw)) });
  initialized = true;
}

export async function setFallbackActive(
  reason: string,
  userID: string,
  status: boolean,
): Promise<void> {
  initFirebase();
  console.log(`Setting fallback to ${status} for user ${userID} (${reason})`);
  const db = getFirestore();
  const snapshot = await db.collection('rituals').where('userID', '==', userID).get();
  if (snapshot.empty) {
    console.warn(`No ritual found for user ${userID}; skipping fallback update`);
    return;
  }
  await snapshot.docs[0]!.ref.update({ fallback_active: status });
}
