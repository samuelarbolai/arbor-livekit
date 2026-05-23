import { google } from 'googleapis';

let driveClient: ReturnType<typeof google.drive> | null = null;

function getDriveClient(): ReturnType<typeof google.drive> {
  if (driveClient) return driveClient;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

// Fetches a Google Doc as plain text via the Drive export endpoint.
// The doc must be link-shareable so the service account can read it.
export async function readGoogleDocAsText(documentId: string): Promise<string> {
  const drive = getDriveClient();
  const res = await drive.files.export(
    { fileId: documentId, mimeType: 'text/plain', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
}
