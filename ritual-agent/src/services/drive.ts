import { google } from 'googleapis';

let auth: ReturnType<typeof makeAuth> | null = null;
let driveClient: ReturnType<typeof google.drive> | null = null;
let docsClient: ReturnType<typeof google.docs> | null = null;

function makeAuth() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/documents.readonly',
    ],
  });
}

function getAuth() {
  if (auth) return auth;
  auth = makeAuth();
  return auth;
}

function getDriveClient(): ReturnType<typeof google.drive> {
  if (driveClient) return driveClient;
  driveClient = google.drive({ version: 'v3', auth: getAuth() });
  return driveClient;
}

function getDocsClient(): ReturnType<typeof google.docs> {
  if (docsClient) return docsClient;
  docsClient = google.docs({ version: 'v1', auth: getAuth() });
  return docsClient;
}

// Legacy whole-Doc reader via Drive's plain-text export. No callers in the
// agent today (the onboarding tool migrated to `readRitualDocTabsAsText`
// below). Kept as a small, unconditional fallback if a future surface needs
// "give me the whole Doc as text" without going through the Docs API.
// The doc must be link-shareable so the service account can read it.
export async function readGoogleDocAsText(documentId: string): Promise<string> {
  const drive = getDriveClient();
  const res = await drive.files.export(
    { fileId: documentId, mimeType: 'text/plain', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
}

// --- Tab-isolated reader (used by the onboarding agent's readGoogleDoc tool) ---
//
// Mirrors the helpers in samwise-backend/cloud-functions/functions/src/index.ts
// (the S4 work). Keeping the design agent's verification window aligned with
// the synthesis prompt's input window means: same three tabs, same exclusion
// of "Lapse Map" / "Possible origins" / "Ejemplo de ritual" / "Metadata".
// What the design agent confirmed during the call is exactly what
// registerNewRitual synthesizes afterwards. Tab name drift in one place
// without the other breaks that alignment.

const RITUAL_TAB_TITLES = ['Behavioural picture', 'Ritual', 'Ritual Call'];

function flattenDocToText(content: unknown[]): string {
  const lines: string[] = [];
  for (const el of content as Array<{
    paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
    table?: {
      tableRows?: Array<{ tableCells?: Array<{ content?: unknown[] }> }>;
    };
  }>) {
    if (el.paragraph?.elements) {
      const line = el.paragraph.elements
        .map((e) => e.textRun?.content ?? '')
        .join('');
      lines.push(line);
    } else if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          lines.push(flattenDocToText(cell.content ?? []));
        }
      }
    }
  }
  return lines.join('');
}

type DocTab = {
  tabProperties?: { title?: string | null } | null;
  documentTab?: { body?: { content?: unknown[] } } | null;
  childTabs?: unknown[];
};

function extractTabsAsText(
  tabs: DocTab[] | undefined | null,
  wantedTitles: string[],
): { found: Map<string, string>; missing: string[] } {
  const found = new Map<string, string>();
  const wanted = new Set(wantedTitles);
  const walk = (list: DocTab[] | undefined | null) => {
    if (!list) return;
    for (const t of list) {
      const title = t.tabProperties?.title?.trim();
      if (title && wanted.has(title) && !found.has(title)) {
        found.set(title, flattenDocToText(t.documentTab?.body?.content ?? []));
      }
      walk(t.childTabs as DocTab[] | undefined);
    }
  };
  walk(tabs);
  const missing = wantedTitles.filter((w) => !found.has(w));
  return { found, missing };
}

// Read the user's ritual Doc, scoped to the three ritual-relevant tabs. If
// any of the three is missing (the user's Doc hasn't been migrated to the
// tabbed template), log a warning and fall back to concatenating EVERY tab's
// text — so the agent still gets something useful, but operators see the
// drift in logs and can fix the Doc.
export async function readRitualDocTabsAsText(
  documentId: string,
): Promise<string> {
  const docs = getDocsClient();
  const doc = await docs.documents.get({
    documentId,
    includeTabsContent: true,
  });
  const tabs = (doc.data.tabs ?? undefined) as DocTab[] | undefined;
  const result = extractTabsAsText(tabs, RITUAL_TAB_TITLES);
  if (result.missing.length === 0) {
    return RITUAL_TAB_TITLES
      .map((t) => `# ${t}\n\n${result.found.get(t) ?? ''}`)
      .join('\n\n');
  }
  console.warn(
    `readRitualDocTabsAsText: missing tab(s) [${result.missing.join(', ')}] ` +
      `in doc ${documentId}; falling back to whole-Doc walk. ` +
      'The agent may see scratch / example / biographical content; ' +
      'fix by ensuring the Doc has tabs named exactly "Behavioural picture", ' +
      '"Ritual", and "Ritual Call".',
  );
  const chunks: string[] = [];
  const walk = (list: DocTab[] | undefined | null) => {
    if (!list) return;
    for (const t of list) {
      chunks.push(flattenDocToText(t.documentTab?.body?.content ?? []));
      walk(t.childTabs as DocTab[] | undefined);
    }
  };
  walk(tabs);
  return chunks.join('\n\n');
}
