/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {initializeApp} from "firebase-admin/app";
import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {randomBytes} from "crypto";
import * as fs from "fs";
import * as path from "path";
import {google} from "googleapis";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

/**
 * Reads an environment variable and throws if it is missing or empty.
 * @param {string} name The env var name.
 * @return {string} The env var value.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// =============================================================================
// Overview
// =============================================================================
// This module exposes three Cloud Functions that together drive the ritual
// product loop:
//
//   1. registerNewRitual      (HTTP, called by the frontend)
//      Reads a Google Doc, asks Gemini to extract structured ritual data,
//      and stores or updates a `rituals` document in Firestore. The Google
//      Doc is the source of truth a user edits to manage one of their
//      rituals; one doc == one ritual.
//
//   2. checkUsersRituals      (Scheduled — one cron per supported timezone)
//      Every 30 min, builds a `DAY_HH:MM` key for "now" in its timezone and
//      looks up rituals whose `schedules` array contains that key. Hands
//      the resulting userIDs off to makeCallsBatchFunction over HTTP.
//
//   3. makeCallsBatchFunction (HTTP, called by checkUsersRituals)
//      Given a list of userIDs, loads each user's ritual config from
//      Firestore and dispatches a LiveKit voice agent to place an
//      outbound SIP call.
//
// Firestore `rituals` document shape (one per Google Doc):
//   - userID:            canonical user identity (a user may own many rituals)
//   - googleDocsLink:    canonical `/edit` URL — dedup key for update vs create
//   - schedules:         ["MON_21:30", "WED_07:00", ...]
//   - fallbackSchedules: alternate slots, only fire when fallback_active=true
//   - fallback_active:   boolean
//   - timeZone:          e.g. "America/Bogota"
//   - agentConfig:       { phoneNumber, userInputs, voiceID, language }
// =============================================================================

export const helloWorld = onRequest((request, response) => {
  logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});

// The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
initializeApp();
const db = getFirestore();
import "dotenv/config";
import {AgentDispatchClient} from "livekit-server-sdk";

/**
 * makeCallsBatchFunction (HTTP)
 *
 * Body: a JSON array of userIDs, e.g. ["pZX1S3F…", "Abc123…"].
 *
 * For each userID, loads the matching ritual document from Firestore,
 * builds a LiveKit dispatch metadata blob, and creates one dispatch per
 * ritual. The dispatched LiveKit agent ("my-agent") is responsible for
 * actually placing the outbound SIP call to the user's phone.
 *
 * Failures inside individual makeCall() invocations are caught and logged
 * so one bad call does not abort the rest of the batch.
 */
export const makeCallsBatchFunction = onRequest(async (req, res) => {
  // Note: this AgentConfig is the dispatch-time shape (camelCase voiceId,
  // single userInput string). It is NOT the same as the Firestore
  // agentConfig field, which uses voiceID / userInputs. The mapping
  // happens below where we read the ritual docs.
  interface AgentConfig {
    userID: string;
    userInput: string;
    language?: string;
    voiceId?: string;
    phoneNumber: string;
  }

  const batchPayload = <AgentConfig[]>[];

  const LIVEKIT_URL = requireEnv("LIVEKIT_URL");
  const LIVEKIT_API_KEY = requireEnv("LIVEKIT_API_KEY");
  const LIVEKIT_API_SECRET = requireEnv("LIVEKIT_API_SECRET");

  const agentDispatchClient = new AgentDispatchClient(
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET
  );

  const agentName = "ritual-agent";

  /**
   * Initiates a single outbound SIP call with agent dispatch.
   * @param {AgentConfig} agentConfig - The call configuration and user data.
   * @return {Promise<void>}
   */
  async function makeCall({
    userID,
    userInput,
    language = "en",
    voiceId = "03496517-369a-4db1-8236-3d3ae459ddf7",
    phoneNumber,
  }: AgentConfig): Promise<void> {
    if (!phoneNumber) throw new Error("Missing phone number");
    if (!userID) throw new Error("Missing user ID");

    const roomName =
      `room-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const metadataContents = {
      user_id: userID,
      phone_number: phoneNumber,
      user_input: userInput,
      language: language,
      voice_id: voiceId,
      room_name: roomName,
    };

    const dispatch = await agentDispatchClient.createDispatch(
      roomName,
      agentName,
      {
        metadata: JSON.stringify(metadataContents),
      }
    );
    console.log("created dispatch", dispatch);
  }

  /**
   * Initiates multiple outbound SIP calls concurrently.
   * @param {AgentConfig[]} batchContexts - Array of call configurations.
   * @return {Promise<void>}
   */
  async function startBatch(batchContexts: AgentConfig[]): Promise<void> {
    await Promise.all(
      batchContexts.map((ctx) => makeCall(ctx).catch(console.error))
    );
  }

  // ----------------------- Example usage ------------------

  const idsReceived = req.body as string[];
  /* To test locally, uncomment:
  * const idsReceived = ["pZX1S3FySfgre88oHxHu09JqMGz1"];
  */

  console.log("IDs received in request body:", idsReceived);

  // Firestore caps `where ... in` at 30 values per query. If a single tick
  // ever needs to dispatch more than 30 users, this needs to be batched.
  const querySnapshot =
    await db.collection("rituals")
      .where("userID", "in", idsReceived)
      .get();

  querySnapshot.forEach((doc) => {
    console.log(doc.id, " => ", doc.data());
  });

  batchPayload.push(...querySnapshot.docs.map((doc) => {
    const data = doc.data();
    const agentConfig = data.agentConfig;
    return {
      userID: data.userID,
      userInput: agentConfig.userInputs,
      voiceId: agentConfig.voiceID,
      language: agentConfig.language,
      phoneNumber: agentConfig.phoneNumber,
    } as AgentConfig;
  }));

  console.log("Batch payload constructed:", batchPayload);

  try {
    await startBatch(batchPayload);
    res.status(200).send("Batch calls initiated successfully.");
  } catch (error) {
    console.error("Error initiating batch calls:", error);
    res.status(500).send("Error initiating batch calls.");
  }
});

/* eslint-disable max-len */
//   const userInputRaw = `

//     <user-details>
//         Name: "Samuel"
//         Language: ""
//         Goal: "Never go to bed late. Always got to bed before 11 pm."
//         Ritual: "Pray the Psalm 91 every night at 9:30 pm".
//         Context: "Despite not yet finding a therapist, Samuel feels confident in his path forward — returning to the nightly practice of praying the Psalm with more discipline, as it has helped him before."
//     </user-details>


//     <THE STOP>
//         <Self-affirmation>
//             "No matter what, I must keep and grow my confidence in myself — I am valuable, and my ultimate goal is to self-advocate, just like Jacob wrestling the angel."
//         </Self-affirmation>
//         <appreciation-of-little-things>
//             "I am alive, and I have a problem to solve — that opportunity alone is the source of all goodness, and like Jacob, I will be blessed through it."
//         </appreciation-of-little-things>
//     </THE STOP>


//     <THE CONSCIENCE>
//         <benefits-hoping-to-gain>
//             I want to give my fullest every day, feel strong and good, complete full weeks of work, and build an unbreakable confidence in my capacity to adapt and change.
//         </benefits-hoping-to-gain>
//         <what-do-i-want-to-nurture-?>
//             I want to nurture my care for my own professional performance and my resilience by consistently showing up and performing well through difficult situations.
//         </what-do-i-want-to-nurture-?>
//     </THE CONSCIENCE>


//     <THE INTENTION>
//     </THE INTENTION>


//     <THE COMMITMENT>
//     </THE COMMITMENT>


//     <symbolic help>
//         <type>
//         </type>
//         <tradition>
//         </tradition>
//         <symbolic invocation>
//         </symbolic invocation>
//         Judaism. The myth of Jacob, especially.
//         The Lord of The Rings. The metaphors related to real life, temptation, goodness, and resilience. Deep admiration for Tolkien and how the hardships in his life and academic knowledge of culture shaped the wonderful metaphors in the lord of the rings tale.
//     </symbolic help>

//     <social help>
//     </social help>
//   `;
/* eslint-enable max-len */

//   const payload1 = {
//     userInput: userInputRaw,
//     language: "en",
//     voiceId: "03496517-369a-4db1-8236-3d3ae459ddf7",
//     phoneNumber: "+573168248411",
//   } as AgentConfig;

//   const payload2 = {
//     userInput: userInputRaw,
//     language: "en",
//     voiceId: "03496517-369a-4db1-8236-3d3ae459ddf7",
//     phoneNumber: "+573147415116",
//   } as AgentConfig;

/**
 * checkUsersRituals (Scheduled)
 *
 * Fires every 30 min on the hour and half-hour, in America/Bogota local time.
 *
 * Each tick:
 *   1. Builds a schedule key for "now" in this cron's timezone,
 *      e.g. "MON_21:30".
 *   2. Looks up rituals whose `schedules` array contains that key.
 *   3. Also looks up rituals whose `fallbackSchedules` matches AND have
 *      `fallback_active === true` (used when a primary schedule is paused
 *      and the user wants a backup window to still trigger).
 *   4. POSTs the resulting userIDs to makeCallsBatchFunction.
 *
 * The scheduler-level `timeZone` only affects WHEN the cron fires;
 * we still have to format `now` in that timezone to build the schedule key.
 */
// For Colombia Central users
// Cron Syntax: "0,30 * * * *" (every 30 mins, on the hour and half hour)
export const checkUsersRituals = onSchedule({
  schedule: "0,30 * * * *",
  timeZone: "America/Bogota",
}, async () => {
  /*
  NOTE FOR FUTURE SELF:
  When we got a user from another timezone,
  just make a new cron job for their timezone.
  Don't try to do timezone calculations here, it is not worth the effort.
  */

  logger.info("Checking users' rituals...");

  const db = getFirestore();

  const now = new Date();

  // Snap `now` to the half-hour boundary so the formatted time matches the
  // exact slot keys stored on rituals (e.g. "21:30", never "21:32").
  const roundedMinutes = now.getMinutes() >= 30 ? 30 : 0;
  const roundedNow = new Date(now);
  roundedNow.setMinutes(roundedMinutes, 0, 0); // zero out seconds/ms

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const cleanTime = formatter.format(roundedNow);

  const dayName = new Intl
    .DateTimeFormat("en-US", {weekday: "short", timeZone: "America/Bogota"})
    .format(now);

  console.log("Current time:", cleanTime);

  logger.info(`Checking rituals scheduled at range ${now.toISOString()}`);

  const ritualsRef = db.collection("rituals");

  const snapshotForCount = await ritualsRef.count().get();

  const totalCount = snapshotForCount.data().count;
  logger.info(`Found ${totalCount} rituals in DB`);

  // Schedule key format: "MON_21:30". Rituals store their slots in this
  // exact format so we can use Firestore's array-contains query directly,
  // no fan-out queries per slot.
  const scheduleKey = `${dayName.toUpperCase()}_${cleanTime}`;
  logger.log("Schedule key:", scheduleKey);

  const schedulesSnapshot = await ritualsRef
    .where("schedules", "array-contains", scheduleKey)
    .get();

  const fallbackSnapshot = await ritualsRef
    .where("fallbackSchedules", "array-contains", scheduleKey)
    .where("fallback_active", "==", true)
    .get();

  logger.info(`Found ${schedulesSnapshot.size} 
    scheduled rituals in the next 15 mins`);

  logger.info(`Found ${fallbackSnapshot.size} 
    fallback rituals in the next 15 mins`);

  const scheduledUserIds = schedulesSnapshot.docs.map((doc) =>
    doc.data().userID);

  const fallbackUserIds = fallbackSnapshot.docs.map((doc) =>
    doc.data().userID);

  logger.info("Scheduled rituals to trigger:", scheduledUserIds);

  logger.info(`Found ${scheduledUserIds.length}
    scheduled rituals. Passing to LiveKit Dispatcher`);

  try {
    if (scheduledUserIds.length > 0) {
      const response = await fetch(
        "https://makecallsbatchfunction-b6fhjlgejq-uc.a.run.app",
        {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(scheduledUserIds),
        }
      );
      const result = await response.text();
      logger.info(result);
    } else {
      const response = "No rituals to trigger, skipping call to dispatcher.";
      logger.info(response);
    }
  } catch (error) {
    logger.error("Failed to hand off scheduled rituals to dispatcher:", error);
  }

  try {
    if (fallbackUserIds.length > 0) {
      const response = await fetch(
        "https://makecallsbatchfunction-b6fhjlgejq-uc.a.run.app",
        {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(fallbackUserIds),
        }
      );
      const result = await response.text();
      logger.info(result);
    } else {
      const response =
        "No fallback rituals to trigger, skipping call to dispatcher.";
      logger.info(response);
    }
  } catch (error) {
    logger.error(
      "Failed to hand off fallback rituals to dispatcher:",
      error
    );
  }
});

// -----------------------------------------------------------------------------
// Cloud Function for Ritual Registration
// -----------------------------------------------------------------------------


import {GoogleGenerativeAI} from "@google/generative-ai";
import cors = require("cors");

const corsHandler = cors({origin: true});

// Hardcoded synthesis prompt used by registerNewRitual. The body of this
// prompt (Rules 1-8, the worked example, Rule 7 tag-by-tag semantics) is
// the canonical spec, kept in ritual_synthesis_prompt.txt so it can be
// edited (and managed by the ritual-synthesis-prompt skill) without
// touching code. Only Rule 9 has been adapted to a JSON envelope to fit
// Gemini's responseMimeType: "application/json" mode, and Rule 10 was
// added to make schedule extraction deterministic for the
// checkUsersRituals cron's array-contains query. The build script copies
// the .txt file into lib/ so __dirname resolution works at runtime.
const SYNTHESIS_PROMPT = fs.readFileSync(
  path.join(__dirname, "ritual_synthesis_prompt.txt"),
  "utf-8"
);

// Extraction prompt used by extractQualification. Same loading pattern.
// Reads a qualification-call transcript (Nova ↔ prospect) and emits the
// structured QualificationPayload as JSON. Sits at the "scribe" end of
// the agent/scribe split: the qualification agent (in ritual-agent's
// flows/qualification/) just converses and takes live notes, then the
// worker POSTs the transcript here at end-of-call or on disconnect.
const QUALIFICATION_EXTRACTION_PROMPT = fs.readFileSync(
  path.join(__dirname, "extraction_qualification_prompt.txt"),
  "utf-8"
);

// Extraction prompt used by extractQualificationTherapist — the therapist
// audience's mirror. Reads a Nova ↔ therapist transcript and emits the four
// therapist variables as JSON.
const QUALIFICATION_THERAPIST_EXTRACTION_PROMPT = fs.readFileSync(
  path.join(__dirname, "extraction_qualification_therapist_prompt.txt"),
  "utf-8"
);

// Extraction prompt used by extractTrackingKpis. Same loading pattern.
// Reads a tracking-call transcript (tracking-agent ↔ user) and emits a
// TrackingState JSON object — one KpiBundle per ritual, keyed by
// googleDocId. Sits at the "scribe" end of the agent/scribe split:
// tracking-agent (in samwise-backend/tracking-agent/) just converses,
// then its worker POSTs the transcript here at end-of-call. Mirrors the
// converse → extract pattern of extractQualification.
const TRACKING_EXTRACTION_PROMPT = fs.readFileSync(
  path.join(__dirname, "extraction_tracking_prompt.txt"),
  "utf-8"
);

// Lazy-singleton Google APIs auth + clients. Scopes:
//   - drive: registerNewRitual reads the doc title; createRitualDoc
//     copies the canonical template into the shared folder.
//   - documents: createRitualDoc patches the new copy's Metadata
//     section via documents.batchUpdate (replaceAllText).
// Auth flows through GOOGLE_APPLICATION_CREDENTIALS (same service
// account as firebase-admin); both Drive and Docs APIs must be enabled
// in the GCP project. One auth instance shared across both clients
// avoids re-initialising the JWT exchange.
let googleAuth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
let driveClient: ReturnType<typeof google.drive> | null = null;
let docsClient: ReturnType<typeof google.docs> | null = null;

/**
 * Lazy-singleton accessor for the shared GoogleAuth instance.
 * @return {object} A cached GoogleAuth scoped for Drive + Docs.
 */
function getGoogleAuth(): InstanceType<typeof google.auth.GoogleAuth> {
  if (googleAuth) return googleAuth;
  googleAuth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
  return googleAuth;
}

/**
 * Lazy-singleton accessor for the Google Drive v3 client.
 * @return {object} A cached drive client with read+write scope.
 */
function getDriveClient(): ReturnType<typeof google.drive> {
  if (driveClient) return driveClient;
  driveClient = google.drive({version: "v3", auth: getGoogleAuth()});
  return driveClient;
}

/**
 * Lazy-singleton accessor for the Google Docs v1 client.
 * @return {object} A cached docs client.
 */
function getDocsClient(): ReturnType<typeof google.docs> {
  if (docsClient) return docsClient;
  docsClient = google.docs({version: "v1", auth: getGoogleAuth()});
  return docsClient;
}

/**
 * registerNewRitual (HTTP)
 *
 * Body: { googleDocLink: string }
 *
 * One Google Doc represents one ritual. Each doc has three tabs (see
 * google-doc-template.md): "Problem - Solution", "Coach Call", and
 * "Metadata". The frontend POSTs the doc link and this function:
 *
 *   1. Extracts the Google Doc ID from the URL. The ID is the dedup key —
 *      invariant to URL formatting (?tab=, #heading=, ?usp=sharing, etc.)
 *      so any URL pointing at the same doc collapses to one ritual.
 *   2. Fetches the doc body via Google's plain-text export endpoint
 *      (returns content from all tabs concatenated; no auth — the doc
 *      must be link-shareable).
 *   3. Parses the Metadata tab in-process: regex on five required keys
 *      (userID, voiceID, language, phoneNumber, timeZone). Missing key
 *      -> 400 with the missing key name.
 *   4. Calls Gemini once with the hardcoded synthesis prompt
 *      (SYNTHESIS_PROMPT). Gemini returns JSON: { userInputs, schedules,
 *      fallbackSchedules } where userInputs holds the filled <user-inputs>
 *      XML plus the UNMAPPED MATERIAL section per Rule 6.
 *   5. Builds RitualData from metadata + Gemini output (fallbackActive is
 *      hardcoded to false; flip it later via direct Firestore edit).
 *   6. Looks up an existing ritual by googleDocId:
 *        - hit  -> UPDATE that ritual (preserving its userID).
 *        - miss -> CREATE a new ritual. A user may own many rituals
 *                  (one per Google Doc), so we still create even when
 *                  this user already exists. The userID/phone lookup in
 *                  the create branch is purely for canonicalizing
 *                  identity, not for deduping rituals.
 *
 * `googleDocsLink` is also stored, but only as a display field (the
 * as-received URL so a human browsing Firestore can click through). It is
 * NOT used for dedup.
 */
export const registerNewRitual = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    interface RegisterRequest {
      googleDocLink: string;
    }

    interface AgentConfig {
      language: string;
      phoneNumber: string;
      userInputs: string;
      voiceID: string;
      userID: string;
    }

    interface RitualData {
      agentConfig: AgentConfig;
      fallbackSchedules: string[];
      fallbackActive: boolean;
      schedules: string[];
      timeZone: string;
      userID: string;
      googleDocId: string;
      googleDocsLink: string;
      label: string;
      // Short, conversational name for the underlying behaviour
      // (e.g. "morning meditation", "drinking less"). Produced by the
      // synthesis prompt — Gemini reads the user's raw inputs and
      // distills a 1-3 word handle the tracking agent will say aloud.
      // Persisted on the ritual doc and mirrored into
      // users/{userID}.behaviorLabels[googleDocId]. Falls back to the
      // Google Doc title if Gemini's response omits it (so older
      // prompt versions keep working).
      behaviorLabel: string;
    }

    // Mirror user-level fields from the ritual into a top-level
    // users/{userID} doc, with this ritual's googleDocId -> label entry
    // merged into the ritualLabels map. Idempotent: re-registering the
    // same doc overwrites that map key in place; registering a new doc
    // for the same user adds a new key without disturbing the others.
    // The other fields (phone, language, voice, timezone) are
    // last-write-wins. tracking-workflow consumes this doc as the single
    // source of truth for dispatch metadata.
    /**
     * Upserts the canonical users/{userID} doc from a ritual.
     * @param {RitualData} r - The ritual whose user-level fields and
     *   {googleDocId -> label} entry are merged into users/{userID}.
     * @return {Promise<void>}
     */
    async function upsertUserDoc(r: RitualData): Promise<void> {
      await db.collection("users").doc(r.userID).set(
        {
          userID: r.userID,
          phoneNumber: r.agentConfig.phoneNumber,
          language: r.agentConfig.language,
          voiceID: r.agentConfig.voiceID,
          timeZone: r.timeZone,
          ritualLabels: {[r.googleDocId]: r.label},
          behaviorLabels: {[r.googleDocId]: r.behaviorLabel},
          updatedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
    }

    try {
      const {googleDocLink} = req.body as RegisterRequest;

      if (!googleDocLink) {
        res.status(400).send({error: "Missing googleDocLink"});
        return;
      }

      // Extract Google Doc ID from the link
      const docIdMatch = googleDocLink.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (!docIdMatch || !docIdMatch[1]) {
        res.status(400).send({error: "Invalid Google Doc Link"});
        return;
      }
      const documentId = docIdMatch[1];

      // Read the Google Doc via the Docs API with includeTabsContent. We
      // need TWO views of the same Doc:
      //   - METADATA TEXT (`docContent`): the text from which the five
      //     required Metadata keys are regex-parsed. Sourced from the
      //     "Metadata" tab; falls back to the whole-Doc body if that tab is
      //     missing (legacy untabbed Docs).
      //   - SYNTHESIS TEXT (`synthesisText`): the text passed to Gemini as
      //     the raw material the synthesis prompt fills the XML template
      //     from. Sourced from the "Behavioural picture" + "Ritual" +
      //     "Ritual Call" tabs concatenated; falls back to the whole-Doc
      //     body if any of those tabs are missing.
      //
      // The fallback path logs a BIG warning. Untabbed Docs (or Docs whose
      // therapist forgot to name a tab correctly) leak ALL tabs to Gemini —
      // including any "Ejemplo de ritual" example or "Possible origins"
      // biographical material — which risks splicing the example user's
      // name/phone or another user's trauma into the synthesized output.
      // S4 is the deterministic isolation; the fallback is backstop only.
      const SYNTHESIS_TAB_TITLES = [
        "Behavioural picture",
        "Ritual",
        "Ritual Call",
      ];
      const METADATA_TAB_TITLE = "Metadata";
      let docContent = "";
      let synthesisText = "";
      try {
        const docs = getDocsClient();
        const doc = await docs.documents.get({
          documentId,
          includeTabsContent: true,
        });
        const tabs = doc.data.tabs;
        // Whole-Doc fallback: concatenate text from EVERY tab (recursive over
        // childTabs). `doc.data.body` is intentionally EMPTY when the Docs
        // API is called with `includeTabsContent: true` (the API moves all
        // content into `tabs`), so the legacy `body.content` path returns
        // "" for any tabbed Doc. Walking the tabs is the right "everything"
        // fallback for both tabbed and legacy single-tab Docs.
        const wholeDocFallback = (): string => {
          const chunks: string[] = [];
          const walk = (list: typeof tabs) => {
            if (!list) return;
            for (const t of list) {
              chunks.push(flattenDocToText(t.documentTab?.body?.content ?? []));
              walk(t.childTabs as typeof tabs);
            }
          };
          walk(tabs);
          return chunks.join("\n\n");
        };

        // Synthesis side.
        const synth = extractTabsAsText(tabs, SYNTHESIS_TAB_TITLES);
        if (synth.missing.length === 0) {
          synthesisText = SYNTHESIS_TAB_TITLES
            .map((t) => `# ${t}\n\n${synth.found.get(t) ?? ""}`)
            .join("\n\n");
        } else {
          logger.warn(
            "==================================================================\n" +
            "REGISTER_NEW_RITUAL: SYNTHESIS-FEEDABLE TABS MISSING.\n" +
            `Doc ${documentId} is missing tab(s): ` +
            `${synth.missing.join(", ")}.\n` +
            "Falling back to whole-Doc content. The synthesis prompt will\n" +
            "see EVERY tab in the Doc, including any 'Ejemplo de ritual'\n" +
            "example and any biographical 'Lapse Map' / 'Possible origins'\n" +
            "material. This risks leaking another user's name, phone\n" +
            "number, or trauma into the synthesized userInputs.\n" +
            "Fix the Doc: ensure tabs named exactly 'Behavioural picture',\n" +
            "'Ritual', and 'Ritual Call' exist at the top level.\n" +
            "=================================================================="
          );
          synthesisText = wholeDocFallback();
        }

        // Metadata side.
        const metadataResult = extractTabsAsText(tabs, [METADATA_TAB_TITLE]);
        if (metadataResult.missing.length === 0) {
          docContent = metadataResult.found.get(METADATA_TAB_TITLE) ?? "";
        } else {
          logger.warn(
            `REGISTER_NEW_RITUAL: '${METADATA_TAB_TITLE}' tab missing from ` +
            `Doc ${documentId}; parsing metadata keys from whole-Doc.`
          );
          docContent = wholeDocFallback();
        }
      } catch (error) {
        logger.error("Failed to read Google Doc via Docs API:", error);
        res.status(500).send({error: "Failed to read Google Doc."});
        return;
      }

      // Fetch the doc title via Drive API. The title is the human-readable
      // ritual label used by tracking-agent so the user recognizes which
      // ritual is being asked about ("Did you fulfill <title> today?").
      // Auth: service-account creds (GOOGLE_APPLICATION_CREDENTIALS); the
      // doc must be link-shareable so the service account can read it.
      let ritualLabel = "Untitled ritual";
      try {
        const drive = getDriveClient();
        const meta = await drive.files.get({
          fileId: documentId,
          fields: "name",
          supportsAllDrives: true,
        });
        if (meta.data.name) {
          ritualLabel = meta.data.name;
        }
      } catch (error) {
        // Title is non-blocking — fall back to "Untitled ritual" so
        // registration still succeeds. Tracking-agent can refer to the
        // ritual by the fallback if Drive is misconfigured; the user will
        // notice and can re-share the doc.
        logger.warn(
          `Failed to fetch Google Doc title for ${documentId}; ` +
          "using fallback label.",
          error
        );
      }

      // Parse the Metadata tab. Strict on the five required keys; values
      // may be quoted or unquoted but must live on a single line of the
      // form `key: "value"` or `key: value`. Anything else in the doc is
      // ignored here — it is the synthesis prompt's job to read the rest.
      interface Metadata {
        userID: string;
        voiceID: string;
        language: string;
        phoneNumber: string;
        timeZone: string;
      }
      const requiredMetadataKeys: (keyof Metadata)[] = [
        "userID",
        "voiceID",
        "language",
        "phoneNumber",
        "timeZone",
      ];
      const metadata: Partial<Metadata> = {};
      const missingMetadataKeys: string[] = [];
      // Strip surrounding straight or smart quotes (Google Docs auto-
      // converts " to U+201C/U+201D), plus stray whitespace.
      const stripQuotes = (s: string) =>
        s.replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, "");
      for (const key of requiredMetadataKeys) {
        const re = new RegExp(
          `^\\s*${key}\\s*:\\s*(.+?)\\s*$`,
          "m"
        );
        const match = docContent.match(re);
        const value = match && match[1] ? stripQuotes(match[1]) : "";
        if (value) {
          metadata[key] = value;
        } else {
          missingMetadataKeys.push(key);
        }
      }
      if (missingMetadataKeys.length > 0) {
        logger.error(
          "Missing required metadata key(s) in Google Doc: " +
          missingMetadataKeys.join(", ")
        );
        res.status(400).send({
          error:
            "Missing required metadata key(s) in Google Doc: " +
            missingMetadataKeys.join(", "),
        });
        return;
      }
      const meta = metadata as Metadata;

      // Inject the metadata language as an explicit statement at the end
      // of the raw material — matches the worked example's pattern so the
      // synthesis prompt's Rule 1 treats it as the canonical call language.
      // Source is `synthesisText` (the three synthesis tabs concatenated,
      // or whole-Doc on fallback) — NOT `docContent` (which only carries
      // the Metadata tab text used for key regex parsing).
      const enrichedDocContent =
        `${synthesisText}\n\n` +
        "[NOTE: The user has separately specified they want the call " +
        `conducted entirely in ${meta.language}.]`;

      // Use a function replacement so any `$` chars in the doc content
      // do not get interpreted as JS replacement patterns ($1, $&, etc.).
      const fullPrompt = SYNTHESIS_PROMPT.replace(
        "[INSERT RAW USER INPUT HERE]",
        () => enrichedDocContent
      );

      const GEMINI_KEY = requireEnv("GEMINI_KEY");
      const genAI = new GoogleGenerativeAI(GEMINI_KEY);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      logger.info("Calling Gemini API...");
      interface SynthesisResult {
        userInputs: string;
        schedules: string[];
        fallbackSchedules: string[];
        // Short, conversational name for the underlying behaviour
        // (1-3 words, e.g. "drinking less", "morning meditation").
        // Optional only because the synthesis-prompt update may lag
        // this code change; once the prompt is updated it will always
        // be present. Falls back to the Google Doc title.
        behaviorLabel?: string;
        userID: string;
      }
      let synthesis: SynthesisResult;
      try {
        const result = await model.generateContent(fullPrompt);
        const responseText = result.response.text();
        synthesis = JSON.parse(responseText) as SynthesisResult;
      } catch (error) {
        logger.error("Failed to parse Gemini response:", error);
        res.status(500).send({error: "Failed to parse Gemini response."});
        return;
      }

      // Build RitualData: metadata fields are canonical from the doc's
      // Metadata tab; userInputs/schedules/fallbackSchedules come from
      // Gemini; fallbackActive is hardcoded false (flip later via a
      // direct Firestore edit if ever needed).
      const ritualData: RitualData = {
        agentConfig: {
          language: meta.language,
          phoneNumber: meta.phoneNumber,
          userInputs: synthesis.userInputs,
          voiceID: meta.voiceID,
          userID: meta.userID,
        },
        fallbackSchedules: synthesis.fallbackSchedules ?? [],
        fallbackActive: false,
        schedules: synthesis.schedules ?? [],
        timeZone: meta.timeZone,
        userID: meta.userID,
        googleDocId: documentId,
        googleDocsLink: googleDocLink,
        label: ritualLabel,
        // Fall back to the Google Doc title if Gemini's synthesis
        // response doesn't yet include behaviorLabel — keeps
        // registration working while the synthesis prompt is being
        // updated to produce the new field.
        behaviorLabel: synthesis.behaviorLabel ?? ritualLabel,
      };

      const ritualsRef = db.collection("rituals");

      // 1. Check if ritual already exists by googleDocId
      logger.info(
        `Checking existing ritual for googleDocId: ${documentId}`
      );
      const docIdSnapshot = await ritualsRef
        .where("googleDocId", "==", documentId)
        .limit(1)
        .get();

      if (!docIdSnapshot.empty) {
        // UPDATE existing ritual
        const existingDoc = docIdSnapshot.docs[0];
        const existingData = existingDoc.data();

        // Preserve existing userID on both top-level and agentConfig so
        // dispatch metadata stays in sync with the canonical identity.
        ritualData.userID = existingData.userID;
        ritualData.agentConfig.userID = existingData.userID;

        logger.info(
          `Updating existing ritual with ID: ${existingDoc.id} ` +
          `for user: ${ritualData.userID}`
        );
        await existingDoc.ref.set(ritualData, {merge: true});
        await upsertUserDoc(ritualData);

        res.status(200).send({
          message: "Ritual updated successfully",
          documentId: existingDoc.id,
          userID: ritualData.userID,
          userInputs: ritualData.agentConfig.userInputs,
        });
        return;
      }

      // 2. CREATE new ritual: Lookup for user ID / phone deduplication.
      //
      // Why both queries? Gemini may have invented a userID, or the user may
      // have signed up under a different phone, etc. We try userID first,
      // then phone, to attach this new ritual to an existing user identity
      // if one already exists. If neither matches, this is a brand-new user
      // and we keep the values Gemini produced.
      //
      // Note: this only canonicalizes IDENTITY. We always create a new
      // ritual document here — a single user is allowed to own many
      // rituals (one per Google Doc).
      logger.info(
        `Checking existing user for userID: ${ritualData.userID} ` +
        `or phoneNumber: ${ritualData.agentConfig.phoneNumber}`
      );
      // in v1 admin without composite indexes or multiple requests
      const idSnapshot = await ritualsRef
        .where("userID", "==", ritualData.userID)
        .limit(1)
        .get();

      const phoneSnapshot = await ritualsRef
        .where(
          "agentConfig.phoneNumber",
          "==",
          ritualData.agentConfig.phoneNumber
        )
        .limit(1)
        .get();

      let canonicalUserId = ritualData.userID;
      let canonicalPhoneNumber = ritualData.agentConfig.phoneNumber;

      if (!idSnapshot.empty) {
        // Existing user found by ID: adopt their userID + phone. Note this
        // overwrites any new phone number from Gemini with the stored one,
        // so phone changes need to flow through some other path.
        canonicalUserId = idSnapshot.docs[0].data().userID;
        const data = idSnapshot.docs[0].data();
        canonicalPhoneNumber = data.agentConfig.phoneNumber;
        logger.info(`Matched existing user by ID: ${canonicalUserId}`);
      } else if (!phoneSnapshot.empty) {
        // Fallback: same phone, different/unknown userID. Adopt the
        // existing user's identity so this ritual attaches to them.
        canonicalUserId = phoneSnapshot.docs[0].data().userID;
        canonicalPhoneNumber = phoneSnapshot.docs[0].data()
          .agentConfig.phoneNumber;
        logger.info(
          `Matched existing user by Phone Number: ${canonicalPhoneNumber}`
        );
      }

      ritualData.userID = canonicalUserId;
      ritualData.agentConfig.userID = canonicalUserId;
      ritualData.agentConfig.phoneNumber = canonicalPhoneNumber;

      // Save to Firestore
      // Creates a new document with an auto-generated ID
      const newDocRef = ritualsRef.doc();
      await newDocRef.set(ritualData);
      await upsertUserDoc(ritualData);
      logger.info(
        `Registered new ritual with ID: ${newDocRef.id} ` +
        `for user: ${canonicalUserId}`
      );

      res.status(200).send({
        message: "Ritual registered successfully",
        documentId: newDocRef.id,
        userID: canonicalUserId,
        userInputs: ritualData.agentConfig.userInputs,
      });
    } catch (error) {
      logger.error("Unexpected error in registerNewRitual:", error);
      res.status(500).send({error: "Internal Server Error."});
    }
  });
});

/**
 * createRitualDoc (HTTP)
 *
 * Body: {
 *   name: string, voiceID: string, language: string,
 *   phoneNumber: string, timeZone: string, title?: string
 * }
 *
 * Generates a fresh ritual Google Doc from the canonical template
 * with the Metadata section pre-filled. The userID is generated
 * server-side as a 28-char base62 string (Firebase-Auth-UID-shaped)
 * — the operator only supplies a human-readable `name`, used in the
 * doc title for findability.
 *
 * Three steps:
 *   1. drive.files.copy — copy RITUAL_TEMPLATE_DOC_ID into
 *      RITUAL_PARENT_FOLDER_ID. The service account is OWNER; the
 *      operator already has access because they own the parent
 *      folder (no email-share needed in v2 of this function).
 *   2. docs.documents.batchUpdate — replaceAllText for each of the
 *      five metadata keys, swapping the empty curly-quote placeholder
 *      ("") for the supplied value wrapped in straight quotes (which
 *      is what registerNewRitual's regex parser expects). userID is
 *      the freshly generated random ID; the others are from the body.
 *   3. Return { documentId, documentUrl, userID }.
 *
 * No Firestore writes here. The operator opens the returned URL,
 * fills in the Problem-Solution and Ritual Call sections, copies the
 * URL back into the "Register New Ritual" form on samwise-app, and
 * registerNewRitual takes over from there.
 *
 * Why curly-to-straight quote substitution: the canonical template
 * was authored in Google Docs which auto-converts straight quotes to
 * smart/curly. The Docs API insertion path bypasses that conversion,
 * so we can deliberately write straight quotes back in. Without this
 * the registration regex (which uses straight " in its character
 * class) would capture the curly quotes as part of the value and
 * corrupt all five fields downstream.
 *
 * Required env vars (set in cloud-functions/.env):
 *   RITUAL_TEMPLATE_DOC_ID  — Google Doc ID of the canonical template.
 *                             Must be shared with the service account
 *                             email as Reader.
 *   RITUAL_PARENT_FOLDER_ID — Drive folder ID where new docs land.
 *                             Must be shared with the service account
 *                             email as Editor. Operator owns it.
 */
/**
 * Generate a random 28-character base62 userID. Shape mirrors a
 * real Firebase Auth UID (28 chars, alphanumeric) so the rest of the
 * stack — Firestore doc IDs, dispatch metadata, log lines — looks
 * uniform across operator-created and Auth-issued users. Modulo bias
 * is negligible for this use case (a tiny lean toward A–H); entropy
 * is still well over 100 bits.
 * @return {string} 28-character base62 string.
 */
function generateUserId(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(28);
  let result = "";
  for (let i = 0; i < 28; i++) {
    result += alphabet[bytes[i] % 62];
  }
  return result;
}

export const createRitualDoc = onRequest((req, res) => {
  corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).send({error: "Method Not Allowed"});
      return;
    }

    interface CreateDocRequest {
      name: string;
      voiceID: string;
      language: string;
      phoneNumber: string;
      timeZone: string;
      title?: string;
    }

    try {
      const body = req.body as CreateDocRequest;

      // Validate the five required input fields. `userID` is no
      // longer in this list — it's generated server-side below.
      const required: Array<keyof CreateDocRequest> = [
        "name",
        "voiceID",
        "language",
        "phoneNumber",
        "timeZone",
      ];
      const missing = required.filter(
        (k) => !body?.[k] || typeof body[k] !== "string" ||
          (body[k] as string).trim() === ""
      );
      if (missing.length > 0) {
        res.status(400).send({
          error: `Missing required field(s): ${missing.join(", ")}`,
        });
        return;
      }

      // E.164 sanity check on phone — registerNewRitual eventually
      // hands this to the LiveKit SIP path which is strict about it.
      const phoneE164 = /^\+[1-9]\d{6,14}$/;
      if (!phoneE164.test(body.phoneNumber.trim())) {
        res.status(400).send({
          error: "phoneNumber must be E.164, e.g. +573168248411",
        });
        return;
      }

      const templateId = process.env.RITUAL_TEMPLATE_DOC_ID;
      const parentFolderId = process.env.RITUAL_PARENT_FOLDER_ID;
      if (!templateId || !parentFolderId) {
        logger.error(
          "createRitualDoc: missing RITUAL_TEMPLATE_DOC_ID or " +
          "RITUAL_PARENT_FOLDER_ID env vars"
        );
        res.status(500).send({error: "Server misconfigured"});
        return;
      }

      const userID = generateUserId();
      const name = body.name.trim();
      const voiceID = body.voiceID.trim();
      const language = body.language.trim();
      const phoneNumber = body.phoneNumber.trim();
      const timeZone = body.timeZone.trim();

      // Default title makes the doc findable in Drive — name + date
      // is human-readable and stable enough that re-running for the
      // same user on a later day produces a distinct title without
      // colliding visually with the previous run.
      const docTitle =
        body.title?.trim() ||
        `Samwise Ritual — ${name} — ` +
        new Date().toISOString().slice(0, 10);

      const drive = getDriveClient();
      const docs = getDocsClient();

      // 1. Copy the template into the parent folder. `parents` here
      //    moves the new file into our owned folder rather than the
      //    service account's root.
      const copyResp = await drive.files.copy({
        fileId: templateId,
        requestBody: {
          name: docTitle,
          parents: [parentFolderId],
        },
        supportsAllDrives: true,
        fields: "id, webViewLink",
      });

      const documentId = copyResp.data.id;
      const documentUrl =
        copyResp.data.webViewLink ??
        `https://docs.google.com/document/d/${documentId}/edit`;

      if (!documentId) {
        logger.error("createRitualDoc: Drive copy returned no id");
        res.status(500).send({error: "Failed to create doc"});
        return;
      }

      // 2. Pre-fill Metadata section. The template ships with empty
      //    curly-quote placeholders authored in Google Docs (e.g.
      //    `userID: ""` with U+201C/U+201D). We match those literals
      //    and replace with straight-quote values that the
      //    registration regex parses cleanly. matchCase=true is
      //    defensive — these keys are case-sensitive identifiers.
      const LCURLY = "“"; // "
      const RCURLY = "”"; // "
      const fields: Array<[string, string]> = [
        ["userID", userID],
        ["voiceID", voiceID],
        ["language", language],
        ["phoneNumber", phoneNumber],
        ["timeZone", timeZone],
      ];
      const replaceRequests = fields.map(([key, value]) => ({
        replaceAllText: {
          containsText: {
            text: `${key}: ${LCURLY}${RCURLY}`,
            matchCase: true,
          },
          replaceText: `${key}: "${value}"`,
        },
      }));
      const batchResp = await docs.documents.batchUpdate({
        documentId,
        requestBody: {requests: replaceRequests},
      });
      // Each replaceAllText reply has occurrencesChanged. If any are
      // 0 the placeholder didn't match — almost always means the
      // template has been edited (different quote chars, missing
      // line). Log so the operator can fix the template; don't fail
      // the request because the doc is already created.
      const replies = batchResp.data.replies ?? [];
      replies.forEach((reply, i) => {
        const changed = reply.replaceAllText?.occurrencesChanged ?? 0;
        if (changed === 0) {
          logger.warn(
            `createRitualDoc: ${fields[i][0]} placeholder not ` +
            "matched in template — operator should fill manually"
          );
        }
      });

      logger.info(
        `createRitualDoc: created ${documentId} for ${name} ` +
        `(userID ${userID})`
      );
      res.status(200).send({
        message: "Ritual doc created",
        documentId,
        documentUrl,
        userID,
      });
    } catch (error) {
      logger.error("createRitualDoc: unexpected error", error);
      res.status(500).send({error: "Internal Server Error"});
    }
  });
});

// =============================================================================
// Session-copilot (Demo Call) HTTP functions
// -----------------------------------------------------------------------------
// Three small functions that back the /copilot route in samwise-app:
//
//   1. loadCallScript      — fetches a script Google Doc, asks Gemini to
//                            parse it into {scriptType, phases[]}.
//   2. cleanVariable       — per-field denoising of a rep's raw mid-call
//                            note. Stateless. Falls back to rawValue on any
//                            error so the frontend never blocks on cleaning.
//   3. appendDemoCallRow   — appends one row to the funnel sheet's "Comp
//                            call" tab via the Sheets API.
//
// All three reuse the lazy-singleton Google auth declared above; the
// spreadsheets scope was added there. The frontend ships under
// samwise-app/app/copilot/ and samwise-app/lib/copilot/. The frontend's
// FUNNEL_SHEET_COLUMNS and this file's DEMO_CALL_COLUMNS must stay in
// sync — drift will land cells in wrong columns.
// =============================================================================

/**
 * Extracts the Google Doc ID from any /document/d/<ID>/... URL form.
 * @param {string} url Doc URL.
 * @return {string} The Doc ID.
 */
function extractDocId(url: string): string {
  const m = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error(`Could not extract Doc ID from: ${url}`);
  return m[1];
}

/**
 * Flattens a Google Doc body's `content` array to plain text. Headings,
 * paragraphs, and table cells are concatenated with line breaks.
 * @param {Array} content Doc structural elements.
 * @return {string} Flat plain-text representation.
 */
function flattenDocToText(content: Array<unknown>): string {
  const lines: string[] = [];
  for (const el of content as Array<{
    paragraph?: {elements?: Array<{textRun?: {content?: string}}>};
    table?: {
      tableRows?: Array<{tableCells?: Array<{content?: Array<unknown>}>}>;
    };
  }>) {
    if (el.paragraph?.elements) {
      const line = el.paragraph.elements
        .map((e) => e.textRun?.content ?? "")
        .join("");
      lines.push(line);
    } else if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          lines.push(flattenDocToText(cell.content ?? []));
        }
      }
    }
  }
  return lines.join("");
}

/**
 * extractTabsAsText
 *
 * Walks a Google Docs API `tabs` array (and any nested `childTabs`) and
 * returns the flattened plain text of each tab whose title matches one of
 * `wantedTitles`. Match is exact (titles are trimmed). First match per title
 * wins — duplicate-titled tabs after the first are ignored.
 *
 * Used by `registerNewRitual` to isolate the synthesis-feedable tabs
 * ("Behavioural picture", "Ritual", "Ritual Call") from scratch / example
 * tabs ("Lapse Map", "Possible origins", "Ejemplo de ritual") in the same
 * Doc. The Doc's "Metadata" tab is extracted the same way for key parsing.
 *
 * @param {Array} tabs The `doc.data.tabs` array from `docs.documents.get`
 *   called with `includeTabsContent: true`. May be `undefined` / `null` /
 *   empty (legacy Docs without the tabs feature).
 * @param {string[]} wantedTitles Tab titles to extract.
 * @return {{found: Map<string, string>, missing: string[]}} `found` maps
 *   each matched title to its flattened text. `missing` lists requested
 *   titles that were not found anywhere in the tab tree.
 */
function extractTabsAsText(
  tabs:
    | Array<{
        tabProperties?: {title?: string | null} | null;
        documentTab?: {body?: {content?: Array<unknown>}} | null;
        childTabs?: Array<unknown>;
      }>
    | undefined
    | null,
  wantedTitles: string[]
): {found: Map<string, string>; missing: string[]} {
  const found = new Map<string, string>();
  const wanted = new Set(wantedTitles);
  const walk = (list: typeof tabs) => {
    if (!list) return;
    for (const t of list) {
      const title = t.tabProperties?.title?.trim();
      if (title && wanted.has(title) && !found.has(title)) {
        const text = flattenDocToText(t.documentTab?.body?.content ?? []);
        found.set(title, text);
      }
      walk(t.childTabs as typeof tabs);
    }
  };
  walk(tabs);
  const missing = wantedTitles.filter((w) => !found.has(w));
  return {found, missing};
}

/* eslint-disable max-len */
/**
 * parseScript — deterministic Doc-text → {scriptType, phases} parser.
 *
 * Replaces the Gemini-backed parse loadCallScript used through 2026-05-26.
 * The Doc uses three explicit conventions that make this a pure string job:
 *
 *   - `[TYPE: demo|onboarding|call_design]` — optional standalone line near
 *     the top of the Doc. When present, authoritative. Falls back to
 *     title/content keyword matching.
 *
 *   - Phase headings — `Phase N — title` or `Phase N.M — title` (em-dash,
 *     en-dash, or hyphen). Decimal phases keep string form ("1.5", "8.5");
 *     integers emit as number. `Pre-call …` / `After the call …` /
 *     `Post-call …` open the special "pre-call" / "post-call" phases.
 *     Phases are emitted in DOCUMENT order, not numeric order (the Demo
 *     Doc puts "After the call" between Phase 12 and Phase 13).
 *
 *   - Body blocks — split on `[SAY]` / `[/SAY]` text tokens. Inside = "say",
 *     outside = "note". `[CONDITION: var=value]` lines stay inside note
 *     blocks; the frontend filters them per-line in script-pane.tsx.
 */
type ScriptType = "demo" | "onboarding" | "call_design" | "unknown";
type ParsedBlock = {kind: "say" | "note"; text: string};
type ParsedPhase = {
  number: number | string;
  title: string;
  blocks: ParsedBlock[];
};

const TYPE_MARKER_RE = /\[TYPE:\s*(demo|onboarding|call_design)\s*\]/i;
const VERSION_MARKER_RE = /\[VERSION:\s*([^\]]+?)\s*\]/i;
// Phase headings require whitespace on BOTH sides of the separator. This
// distinguishes real headings like "Phase 1 — Set validations" from range
// notation in meta lists like "Phase 5–8: thoughts_during_relapse, ...".
const PHASE_RE = /^\s*Phase\s+(\d+(?:\.\d+)?)\s+[—–-]\s+(.+?)\s*$/;
// Negative lookahead `(?!:)` rejects colon-followed forms like
// "Pre-call: prospect_name, …" / "Post-call: outcome, …" that appear in
// variable-reference meta sections. Real phase headings use a dash
// separator or have no immediate colon ("After the call (fill within …)").
const PRECALL_RE = /^\s*Pre-?call\b(?!:).*$/i;
const POSTCALL_RE = /^\s*(?:After the call|Post-?call)\b(?!:).*$/i;
// Standalone "[END]" line — terminates the renderable script. Anything
// after (variable references, changelog, internal notes) is dropped.
const END_MARKER_RE = /^\s*\[END\]\s*$/i;
// Split on both straight and full-width brackets — Google Docs sometimes
// autocorrects `[` to `［`.
const SAY_SPLIT_RE = /(\[\/?SAY\]|［\/?SAY］)/;

/**
 * Detects scriptType from the `[TYPE: ...]` marker (authoritative) with a
 * keyword fallback against title + first 500 chars of content.
 * @param {string} title Doc title.
 * @param {string} content Flattened Doc text.
 * @return {ScriptType} demo / onboarding / call_design / unknown.
 */
function detectScriptType(title: string, content: string): ScriptType {
  const head = content.slice(0, 500);
  const m = head.match(TYPE_MARKER_RE) ?? title.match(TYPE_MARKER_RE);
  if (m) {
    const v = m[1].toLowerCase();
    if (v === "demo" || v === "onboarding" || v === "call_design") return v;
  }
  const haystack = `${title}\n${head}`.toLowerCase();
  if (/demo call|compatibility & welcome/.test(haystack)) return "demo";
  if (/dra\.\s*ana\s*mar[ií]a|onboarding/.test(haystack)) return "onboarding";
  if (/call\s+design|ritual\s+design/.test(haystack)) return "call_design";
  return "unknown";
}

/**
 * Splits a phase body into alternating say/note blocks using [SAY]/[/SAY]
 * text markers as the deterministic boundary.
 * @param {string} body Flat phase body text.
 * @return {ParsedBlock[]} Ordered blocks; empty blocks dropped.
 */
function splitPhaseBody(body: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let mode: "say" | "note" = "note";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("").trim();
    if (text) blocks.push({kind: mode, text});
    buf = [];
  };
  for (const part of body.split(SAY_SPLIT_RE)) {
    if (!part) continue;
    const norm = part.replace("［", "[").replace("］", "]");
    if (norm === "[SAY]") {
      flush();
      mode = "say";
    } else if (norm === "[/SAY]") {
      flush();
      mode = "note";
    } else {
      buf.push(part);
    }
  }
  flush();
  // Merge consecutive same-kind blocks (defensive — empty [SAY][/SAY]
  // pairs could leave gaps).
  const merged: ParsedBlock[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.kind === b.kind) {
      last.text = `${last.text}\n${b.text}`.trim();
    } else {
      merged.push({...b});
    }
  }
  return merged;
}

interface PhaseHeading {
  number: number | string;
  title: string;
}

/**
 * Returns the parsed heading for a phase-opening line, or null if the line
 * does not start a phase. Accepts "Phase N — title", "Phase N.M — title",
 * "Pre-call …", "After the call …", and "Post-call …".
 * @param {string} line One line of the flattened Doc.
 * @return {PhaseHeading | null} Heading shape or null.
 */
function matchPhaseHeading(line: string): PhaseHeading | null {
  const m = PHASE_RE.exec(line);
  if (m) {
    const numStr = m[1];
    const number: number | string = numStr.includes(".") ?
      numStr :
      parseInt(numStr, 10);
    return {number, title: m[2].trim()};
  }
  if (PRECALL_RE.test(line)) {
    return {number: "pre-call", title: line.trim()};
  }
  if (POSTCALL_RE.test(line)) {
    return {number: "post-call", title: line.trim()};
  }
  return null;
}

/**
 * Detects the optional `[VERSION: x.y]` marker near the top of the Doc.
 * @param {string} content Flattened Doc text.
 * @return {string | undefined} The version string (whitespace-trimmed) or
 *   undefined if the marker is absent.
 */
function detectVersion(content: string): string | undefined {
  const m = content.slice(0, 500).match(VERSION_MARKER_RE);
  return m ? m[1].trim() : undefined;
}

/**
 * Parses a Samwise call-script Doc into {scriptType, version, phases}.
 * Pure function; no I/O. See the parseScript banner comment above for the
 * conventions this relies on. `version` is omitted when the Doc has no
 * `[VERSION: ...]` marker.
 * @param {string} title Doc title from docs.documents.get → data.title.
 * @param {string} content Flattened Doc text from flattenDocToText.
 * @return {object} { scriptType, version?, phases }.
 */
export function parseScript(
  title: string,
  content: string,
): {scriptType: ScriptType; version?: string; phases: ParsedPhase[]} {
  const scriptType = detectScriptType(title, content);
  const version = detectVersion(content);

  const lines = content.split(/\r?\n/);
  type Bucket = PhaseHeading & {bodyLines: string[]};
  const buckets: Bucket[] = [];
  let current: Bucket | null = null;

  for (const line of lines) {
    if (END_MARKER_RE.test(line)) break;
    const heading = matchPhaseHeading(line);
    if (heading) {
      current = {...heading, bodyLines: []};
      buckets.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    }
    // Lines before the first heading are dropped (preamble).
  }

  const phases: ParsedPhase[] = buckets
    .map((b) => ({
      number: b.number,
      title: b.title,
      blocks: splitPhaseBody(b.bodyLines.join("\n")),
    }))
    .filter((p) => p.blocks.length > 0);

  return version ? {scriptType, version, phases} : {scriptType, phases};
}
/* eslint-enable max-len */

/**
 * loadCallScript (HTTP)
 *
 * Body: { googleDocLink: string }
 *
 * Reads the Doc via the Google Docs API, then parses it deterministically
 * via parseScript() into { scriptType, phases }. The Doc uses [SAY]/[/SAY]
 * text markers around spoken lines and "Phase N — title" headings — see
 * parseScript() above. No LLM in the loop; the previous Gemini parse was
 * removed 2026-05-26 once the marker convention made it redundant.
 *
 * Used by samwise-app/app/copilot/ at session start.
 */
export const loadCallScript = onRequest(
  {cors: true},
  async (req, res) => {
    // Never cache: the therapist/rep must always get the live Google
    // Doc. Set before any branch so it covers success AND error paths.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    interface LoadCallScriptBody {
      googleDocLink: string;
    }

    try {
      const {googleDocLink} = req.body as LoadCallScriptBody;
      if (!googleDocLink) {
        res.status(400).json({error: "googleDocLink required"});
        return;
      }

      const docId = extractDocId(googleDocLink);
      const docs = getDocsClient();
      const doc = await docs.documents.get({documentId: docId});

      const title = doc.data.title ?? "";
      const content = flattenDocToText(doc.data.body?.content ?? []);

      const parsed = parseScript(title, content);
      res.status(200).json(parsed);
    } catch (err) {
      logger.error("loadCallScript failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  },
);

/* eslint-disable max-len */
/**
 * Builds the script-context-aware cleaning prompt for cleanVariable.
 * The cleaner's job is to produce a phrase that fits naturally into the
 * specific script slots where this variable is substituted — not a
 * generic canonical form. When no script slots exist (e.g. post-call
 * variables that never appear in spoken text), the prompt falls back
 * to a "produce a clean version" instruction.
 * @param {object} body Cleaning request body.
 * @return {string} The full prompt to send to Gemini.
 */
function buildCleanVariablePrompt(body: {
  name: string;
  rawValue: string;
  frameworkSemantics?: string;
  scriptContexts?: string[];
  otherVariables?: Record<string, string>;
}): string {
  const semantics = body.frameworkSemantics?.trim() ||
    "A free-text variable captured by the rep. Produce a concise, " +
    "grammatical, substitutable version in the language the rep typed.";

  const contexts = body.scriptContexts ?? [];
  const contextBlock = contexts.length > 0 ?
    `SCRIPT SLOTS where {{${body.name}}} appears (the rep reads these aloud):
${contexts.map((c) => `  - "${c}"`).join("\n")}

Your output MUST fit naturally into ALL these slots. Mentally substitute it into each and check that it reads grammatically and conversationally. The output language is the language of the slots above; if the rep typed in a different language, translate.` :
    "This variable does NOT appear in any spoken script slot. Produce a clean, concise version in the language the rep typed. No need to optimize for grammatical fit.";

  // Cross-variable context for disambiguation. If the rep's raw note
  // contains a word with multiple senses (e.g. "defaulting" = settling-
  // for-default vs. breaching), other captured variables usually
  // disambiguate (e.g. core_motivation mentioning relationships → pick
  // the romantic sense, not the financial-breach sense).
  const others = body.otherVariables ?? {};
  const filteredOthers = Object.entries(others)
    .filter(([k, v]) => k !== body.name && typeof v === "string" && v.trim())
    .slice(0, 30); // hard cap
  const otherBlock = filteredOthers.length > 0 ?
    `
OTHER VARIABLES ALREADY CAPTURED FOR THIS PROSPECT (use ONLY to disambiguate the rep's words — what world is the prospect in, what's at stake for them, what's the register of their language? Do NOT pull content from these into your output for ${body.name}; that content belongs to those other variables):
${filteredOthers.map(([k, v]) => `  - ${k}: ${v}`).join("\n")}
` :
    "";

  return `You are cleaning a rep's raw mid-call note into a phrase that will populate variable {{${body.name}}} in a Samwise call script. The rep reads the script aloud right now — your output's job is to be the right thing to SAY in this specific call.

WHAT THIS VARIABLE CAPTURES:
${semantics}

${contextBlock}
${otherBlock}
RAW REP NOTE:
"""
${body.rawValue}
"""

RULES:
- SYNTHESIZE — DO NOT PARAPHRASE. The rep's raw note is a brain dump: long, redundant, conflated, mid-thought. Your job is to extract the tightest noun or verb phrase that fits ALL the script slots above and drop everything else. If the raw note is 30 words and the slot calls for a 4-word phrase, return 4 words. The slot-fit test is the size budget — your output must read cleanly when the rep says the slot sentence aloud, with no padding or rewinds. A paraphrase that is roughly the same length as the raw note is a FAILURE.
- Extract ONLY content relevant to THIS variable. The rep's note may conflate multiple variables — strip anything that belongs elsewhere. Example: if the rep mixes the behaviour, biographical context, and the life-stakes reason, and this variable is core_motivation, output only the life-stakes reason.
- Preserve the prospect's voice and their chosen framing. Tightening the phrase is REQUIRED; replacing the prospect's specific words with a generic clinical noun is NOT. If the prospect said "salir con mujeres mediocres", output "salir con mujeres mediocres" — NEVER collapse to "incumplimiento" or "conformismo". If the prospect described their problem as "mi enemigo", "the bleeding", "my disease", "la enfermedad", keep that detachment metaphor verbatim. NEVER substitute clinical terms ("addiction", "depression", "anxiety", "ADHD") into the output. You may reason clinically internally; the output protects the prospect's chosen framing because the rep reads it aloud to them.
- Use the OTHER VARIABLES block above ONLY to disambiguate ambiguous wording in the rep's note (e.g. "defaulting" — financial breach? settling-for-default option?). NEVER pull content from other variables into your output; that content belongs to those other variables.
- If the raw note does not contain content for THIS variable (the rep typed into the wrong field), return the raw note unchanged. NEVER fabricate. NEVER infer from other variables.
- Return ONLY the cleaned phrase. No labels, no JSON, no commentary, no surrounding quotes.

CLEANED PHRASE:`;
}
/* eslint-enable max-len */

/**
 * cleanVariable (HTTP)
 *
 * Body: { name, rawValue, frameworkSemantics?, scriptContexts? }
 * Response: { cleaned }
 *
 * Script-context-aware cleaning. The rep's raw mid-call note is shaped
 * into a phrase that fits the actual script slots where this variable
 * appears. Stateless. Falls back to returning rawValue unchanged on any
 * error so the frontend never blocks the rep on a failed cleaning call.
 */
export const cleanVariable = onRequest({cors: true}, async (req, res) => {
  interface CleanVariableBody {
    name: string;
    rawValue: string;
    frameworkSemantics?: string;
    scriptContexts?: string[];
    // Other captured variables for cross-context disambiguation. The
    // cleaner uses these to resolve ambiguity in the rep's raw note
    // (e.g. "defaulting" — financial breach? settling-for-default
    // option?) but does NOT pull content from them into the output.
    otherVariables?: Record<string, string>;
  }

  let rawValue = "";
  try {
    const body = req.body as CleanVariableBody;
    rawValue = body.rawValue ?? "";
    if (!rawValue.trim()) {
      res.status(200).json({cleaned: ""});
      return;
    }

    const prompt = buildCleanVariablePrompt(body);
    const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
    const model = gemini.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {temperature: 0.2},
    });
    const result = await model.generateContent(prompt);
    const cleaned = result.response.text().trim();

    // Trim wrapping quotes if Gemini decided to wrap the output.
    const stripped = cleaned.replace(/^["'`]|["'`]$/g, "").trim();
    res.status(200).json({cleaned: stripped || rawValue});
  } catch (err) {
    logger.error("cleanVariable failed", err);
    res.status(200).json({cleaned: rawValue});
  }
});

/* eslint-disable max-len */
/**
 * SuggestTechnique
 *
 * The set of in-call rep-line generation techniques the Demo Call uses.
 * Each technique produces ONE Spanish SAY line tuned to the prospect's
 * context. See buildSuggestRepLinePrompt for the per-technique prompt.
 */
type SuggestTechnique =
  | "phase_1_5_worldview_confirmation"
  | "phase_10_alternatives_failure_reflection"
  | "ifs_reframe"
  | "amplification_two_poles"
  | "synthesis_offer"
  | "trajectory_push";

/**
 * Builds the per-technique prompt for suggestRepLine. The frontend passes
 * the technique + the captured-so-far state; the prompt is dispatched on
 * technique with state values inlined as plain text.
 * @param {object} args Suggestion request body.
 * @return {string} The full prompt to send to Gemini.
 */
function buildSuggestRepLinePrompt(args: {
  technique: SuggestTechnique;
  state: Record<string, string>;
  language?: "es" | "en";
}): string {
  const s = args.state;
  const get = (k: string): string => (s[k] ?? "").trim();
  const has = (k: string): boolean => get(k).length > 0;
  // Pre-call context block used by most techniques. Only includes vars
  // that are non-empty so Gemini doesn't see "X: " noise.
  const lines: string[] = [];
  const push = (k: string, label?: string) => {
    if (has(k)) lines.push(`- ${label ?? k}: ${get(k)}`);
  };
  push("behaviour_to_change");
  push("core_motivation");
  push("life_stage_context");
  push("problem_duration_self_reported");
  push("symbolic_anchor_type");
  push("symbolic_anchor_description");
  push("alternatives_tried");
  push("why_alternatives_failed");
  // Phase 5b in-flight captures (may be empty depending on which step
  // the rep is at).
  push("feelings_during_relapse");
  push("intention_behind_action");
  push("thoughts_during_relapse");
  push("self_talk_after_relapse");
  push("view_of_their_life_in_that_moment");
  const contextBlock = lines.length > 0 ?
    `PROSPECT CONTEXT (only non-empty fields shown):
${lines.join("\n")}` :
    "PROSPECT CONTEXT: (none — nothing captured yet)";

  const persona = "PERSONA: The rep speaks in the voice of an expensive, centered, self-aware female clinician — Carolina Borrero reference. Calm, never desperate, mirrors the prospect's register. Never uses clinical-coded vocabulary in spoken output (no \"paciente\", no \"comportamiento autodestructivo\", no \"recaída\", no \"clínico/clínicamente\"). Spanish uses the vos register (Argentine). Lines are short — the rep is going to say this aloud.";

  const common = `\n\n${contextBlock}\n\n${persona}\n\nReturn ONLY the SAY line — no labels, no JSON, no surrounding quotes, no preamble.\n\nSAY LINE:`;

  switch (args.technique) {
  case "phase_1_5_worldview_confirmation": {
    const anchorType = get("symbolic_anchor_type");
    if (!anchorType || anchorType === "none" || anchorType === "unknown") {
      // Caller should not even invoke this technique in this case;
      // return an empty marker the frontend can detect.
      return "__SKIP__:no symbolic anchor on file";
    }
    return `You are helping a sales rep at a behavior-change company prepare a SAY line for the opening reflection (Phase 1.5) of a Demo Call. The rep is about to play back what the prospect shared in the Fit Assessment. THIS specific line is a one-sentence worldview confirmation — a reflection of HOW the prospect sees the world (philosophical, religious, hyper-rational, etc.) that signals the rep was paying attention to their register, not just their facts.

TECHNIQUE: Use the prospect's exact tradition/philosophy by name where they used a specific one. If they mentioned Stoicism → say "estoicismo". If Catholic prayer → "la oración católica". If a specific philosopher or book → name it. If "hyper-rational" → signal that register without naming a tradition. NEVER generalize to "spirituality" or "religion" — that's the failure mode.

SHAPE: "Y también veo que [reflection of their worldview in their language, 1–2 short clauses, max 25 words]."${common}`;
  }

  case "phase_10_alternatives_failure_reflection": {
    const why = get("why_alternatives_failed");
    const alts = get("alternatives_tried");
    if (!why || why === "none" || why === "unknown" ||
        !alts || alts === "none" || alts === "unknown") {
      // Caller should not even invoke this technique in this case;
      // return an empty marker the frontend can detect.
      return "__SKIP__:no alternatives data on file";
    }
    return `You are helping a sales rep at a behavior-change company prepare a SAY line for Phase 10 (Eliminate perception of risk, just before Price) of a Demo Call. This is the line that bridges the rep's setup ("Antes de hablar de inversión, quiero dejarte algo claro.") and the one-month money-back guarantee. It reflects empathically why the prospect's prior alternatives didn't work, anchoring the guarantee in something specific to THIS prospect rather than abstract.

TECHNIQUE: Take what the prospect captured in the Fit Assessment about their tried alternatives (alternatives_tried) and why they failed (why_alternatives_failed). The raw values are rep notes — often verbatim, possibly ungrammatical, possibly long. Produce ONE clean Spanish sentence that:
- Names their specific alternatives by short reference (e.g. "la terapia individual", "los retiros y la meditación", "los libros y los videos"), NOT a generic "todo lo que has probado"
- Reflects the why-it-failed cleanly — rephrase as smooth prose, do not paste the raw value
- Ends with a short empathic validation clause that the failure makes sense given who they are

SHAPE: "Vos ya me contaste que lo que no terminó de servirte de [specific alternatives, short] fue [cleaned reason], y eso tiene sentido [optional half-clause tying to their situation]."

GOOD examples (the shape — specific, empathic, smoothly phrased):
- "Vos ya me contaste que lo que no terminó de servirte de la terapia individual fue que no aterrizaba en acciones concretas, y eso tiene sentido — necesitabas algo que te empuje, no solo que te escuche."
- "Vos ya me contaste que con la meditación y los retiros, lo que faltó fue continuidad — funcionaba esos días y después se diluía."

BAD examples (avoid — generic, vague, or just pasted-through):
- "Sé que has probado muchas cosas y nada funcionó."
- "Las alternativas que probaste no te dieron resultados."
- (pasting the raw why_alternatives_failed value verbatim)

Keep the line under 35 words.${common}`;
  }

  case "ifs_reframe": {
    return `You are helping a sales rep at a behavior-change company prepare a SAY line for Step 5 of Phase 5b in a Demo Call. The technique is the IFS (Internal Family Systems) reframe — the rep frames the prospect's relapse-action as a "part" of them trying to do something for them, rather than as a moral failure. This is the load-bearing move of Phase 5b: it creates desidentification distance EARLY so the steps that follow (thoughts, self-talk) can surface honestly without ego defense.

TECHNIQUE: Weave the prospect's action (from behaviour_to_change, in past tense, third-person — "esa parte tuya que [VERB-PHRASE]") and their feelings (echoed naturally) into the IFS opening. End with the three-part question: "¿qué estaba tratando de hacer por vos? ¿De qué te estaba sacando? ¿O hacia qué te estaba llevando?"

SHAPE: "Esa parte tuya que [verb-phrase from behaviour_to_change, past tense third-person] — sintiendo [echo of feelings, brief, in their words] — ¿qué estaba tratando de hacer por vos? ¿De qué te estaba sacando? ¿O hacia qué te estaba llevando?"

Adapt the verb-phrase grammatically (must read clean in third person). If feelings_during_relapse is empty, drop the feelings echo and just use the action. Keep the whole line under 40 words.${common}`;
  }

  case "amplification_two_poles": {
    // We don't know which variable is being filled — frontend tells
    // us via state-keys present. If thoughts is empty but we're being
    // asked for amplification, it's for thoughts (Step 6). If thoughts
    // is filled but self-talk is empty, it's for self-talk (Step 7).
    const isSelfTalk = has("thoughts_during_relapse");
    const target = isSelfTalk ? "self-talk AFTER the relapse" :
      "thoughts DURING the relapse";
    const targetVar = isSelfTalk ?
      "self_talk_after_relapse" : "thoughts_during_relapse";
    const targetVarLabel = isSelfTalk ?
      "verbatim things the prospect TOLD THEMSELVES after the relapse was over (e.g. \"qué mierda, otra vez perdí la tarde\", \"bueno, mañana sí\")" :
      "thoughts the prospect was HAVING DURING the relapse moment (e.g. \"cinco minutos y vuelvo\", \"esto no importa, mañana arranco\")";

    return `You are helping a sales rep at a behavior-change company prepare a SAY line for ${isSelfTalk ? "Step 7" : "Step 6"} of Phase 5b in a Demo Call. The technique is two-pole amplification — the rep proposes TWO DELIBERATELY OPPOSED options the prospect might have ${isSelfTalk ? "said to themselves" : "thought"}, plus an "algo más feo" escape-hatch tail. The contrast between the two options is LOAD-BEARING — if both options are similar in tone, the technique fails because the prospect just nods.

TARGET: ${target} — i.e., the variable {{${targetVar}}}. Concretely: ${targetVarLabel}.

POLE DEFINITIONS (this is critical):
- OPTION A = minimizing / self-permissive / kicking the can ("mañana sí", "no fue para tanto", "cinco minutos más")
- OPTION B = self-blaming / harsh / shame-driven ("soy un desastre", "qué mierda, otra vez", "siempre lo mismo")
- Option A and Option B MUST sit on opposite poles. If you can't tell which is which, you're not making them opposed enough.

SHAPE: "¿Algo como '[OPTION A — short verbatim-style quote, ≤10 words, in their voice]'? ¿O era más '[OPTION B — short verbatim-style quote, ≤10 words, in their voice]'? ¿O algo más feo que eso?"

Adapt each option to THIS prospect's vocabulary and life-stage (use core_motivation, life_stage_context, prior captured Phase 5b values to pick words that sound like THEM, not like a generic prospect).${common}`;
  }

  case "synthesis_offer": {
    return `You are helping a sales rep at a behavior-change company prepare a SAY line for Step 8 of Phase 5b in a Demo Call. The technique is synthesis amplification — the rep takes everything captured so far in Phase 5b (feelings, intention, thoughts, self-talk) and offers a SINGLE synthesis of how the prospect saw their LIFE in that moment, for the prospect to confirm/correct/refine. A WRONG synthesis is still a successful move because the prospect's correction is the highest-fidelity data point of the phase. The synthesis must be CONCRETE and VIVID — a metaphor or image, NOT an abstract noun phrase.

TECHNIQUE: First, echo briefly what they shared in steps 4–7 (one short clause stringing feelings + thoughts + self-talk together). Then offer the synthesis as a metaphor or vivid image. End by inviting confirmation or correction.

GOOD synthesis examples (these are the SHAPE you want — vivid, concrete, reactable):
- "una rueda de la que no podés salir"
- "algo que ya no te pertenece"
- "una pelea perdida que seguís peleando"
- "un sótano del que no encontrás la escalera"
- "estar viviendo la vida de otro"

BAD synthesis examples (these are the shape you want to AVOID — abstract, generic, unreactable):
- "una vida difícil"
- "un estado de tristeza"
- "una situación complicada"
- "algo que no podés controlar"

SHAPE: "Por cómo me lo describís — [eco breve uniendo feelings + thoughts + self-talk en una sola frase corta] — suena como que en ese momento tu vida se veía como [síntesis vívida — metáfora o imagen concreta]. ¿Se parece a eso? ¿O era distinto?"

Keep the whole line under 50 words. Adapt the metaphor to this prospect's life context and vocabulary.${common}`;
  }

  case "trajectory_push": {
    const duration = get("problem_duration_self_reported");
    const durationHint = duration ?
      `The prospect has been struggling with this for: "${duration}". Pick time horizons that feel pointed against that — if they've been at it for years already, "seis meses más" + "al año" feels heavier than "diez años más".` :
      "No duration on file; use generic horizons (\"seis meses más\" / \"al año\").";

    return `You are helping a sales rep at a behavior-change company prepare a SAY line for Step 9 (consequences) of Phase 5b in a Demo Call. The technique is trajectory-push — when the prospect minimizes the consequences ("tampoco es para tanto"), the rep reframes into a FUTURE trajectory to surface the cost they're denying in the present. Future losses are easier to admit than present ones.

TECHNIQUE: Reference the time scale of their existing struggle, then ask where they'll be at one short horizon and one longer one. ${durationHint}

SHAPE: "Si esto sigue igual [SHORT horizon — e.g. 'seis meses más'], ¿dónde estás? ¿Y [LONGER horizon — e.g. 'al año'/'a los dos años']?"

Keep it tight — under 25 words.${common}`;
  }

  default:
    // Exhaustiveness guard. If a new technique is added to the union,
    // TS will complain here.
    return `__SKIP__:unknown technique "${args.technique}"`;
  }
}
/* eslint-enable max-len */

/**
 * suggestRepLine (HTTP)
 *
 * Body: {
 *   technique: SuggestTechnique,
 *   state: Record<string, string>,  // captured variables (raw or cleaned)
 *   language?: "es" | "en"
 * }
 * Response: { line: string }
 *
 * Generates ONE Spanish (or English) SAY line tuned to the prospect's
 * context using the named technique. Used by /copilot's pre-generation
 * mechanism: when a triggering variable is captured, the frontend calls
 * suggestRepLine with the current state and caches the result for the
 * rep to reveal on demand during the step the line belongs to.
 *
 * Stateless. Falls back to returning a small marker string on any
 * error so the frontend never blocks on a failed call.
 */
export const suggestRepLine = onRequest(
  {cors: true, timeoutSeconds: 60},
  async (req, res) => {
    interface SuggestBody {
      technique: SuggestTechnique;
      state?: Record<string, string>;
      language?: "es" | "en";
    }

    try {
      const body = req.body as SuggestBody;
      if (!body || !body.technique) {
        res.status(400).json({error: "technique required"});
        return;
      }

      const prompt = buildSuggestRepLinePrompt({
        technique: body.technique,
        state: body.state ?? {},
        language: body.language,
      });

      // Skip marker — the prompt builder decided generation is not
      // applicable (e.g., no symbolic anchor for Phase 1.5 line).
      if (prompt.startsWith("__SKIP__")) {
        res.status(200).json({line: ""});
        return;
      }

      const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
      const model = gemini.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {temperature: 0.7},
      });
      const result = await model.generateContent(prompt);
      const line = result.response.text().trim();

      // Trim wrapping quotes if Gemini decided to wrap the line.
      const stripped = line.replace(/^["'`]|["'`]$/g, "").trim();
      res.status(200).json({line: stripped});
    } catch (err) {
      logger.error("suggestRepLine failed", err);
      // Soft-fail: frontend shows a "no suggestion available" state.
      res.status(200).json({line: ""});
    }
  }
);

/**
 * appendDemoCallRow (HTTP)
 *
 * Body: { raw, cleaned, qualificationProspectKey? }
 * Response: { ok: true, docId: string, prospectKey: string }
 *
 * Persists a completed Demo Call to the `demoCalls` Firestore
 * collection. Doc ID: `${prospectKey}-${Date.now()}` (mirrors the
 * submitQualification pattern). prospectKey prefers the body's
 * `qualificationProspectKey` (forwarded by the frontend when a
 * qualification was loaded into the session) to preserve linkage
 * between the qualifications + demoCalls collections; falls back to
 * deriving from cleaned.prospect_name using the same normalization
 * submitQualification uses (lowercase, non-alphanum → hyphen, trim
 * hyphens).
 *
 * Note: the function name is legacy from a sheet-based version. It no
 * longer appends a row; it writes a Firestore doc. Frontend URL
 * constant is unchanged.
 */
export const appendDemoCallRow = onRequest(
  {cors: true},
  async (req, res) => {
    interface SaveBody {
      raw: Record<string, string>;
      cleaned: Record<string, string>;
      // Optional: forwarded from the frontend when the rep loaded a
      // qualification doc into this session. Preserves prospectKey
      // continuity between qualifications + demoCalls collections.
      qualificationProspectKey?: string;
    }

    try {
      const body = req.body as SaveBody;
      if (!body || typeof body !== "object" || !body.cleaned) {
        res.status(400).json({error: "cleaned required"});
        return;
      }

      const cleaned = body.cleaned;
      const raw = body.raw ?? {};
      const prospectName = (cleaned.prospect_name ?? "").trim();
      if (!prospectName && !body.qualificationProspectKey) {
        res.status(400).json({
          error: "prospect_name or qualificationProspectKey required",
        });
        return;
      }

      const prospectKey = body.qualificationProspectKey ||
        prospectName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");

      const db = getFirestore();
      const docId = `${prospectKey}-${Date.now()}`;
      await db.collection("demoCalls").doc(docId).set({
        raw,
        cleaned,
        prospectKey,
        repName: cleaned.rep_name ?? "",
        outcome: cleaned.outcome ?? "",
        createdAt: FieldValue.serverTimestamp(),
      });

      res.status(200).json({ok: true, docId, prospectKey});
      return;
    } catch (err) {
      logger.error("appendDemoCallRow failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
      return;
    }
  }
);

// =============================================================================
// extractDemoCall — UNIFIED demo-call persistence (replaces appendDemoCallRow)
// =============================================================================
// One canonical write path for the Demo Call, used by BOTH:
//   - the autonomous demo-call agent (ritual-agent flows/demo-call): POSTs the
//     full transcript + its live-captured state → we re-extract the variable
//     set with Gemini (the more complete record), keep the agent's in-call
//     judgments authoritative, and store the transcript for backfill.
//   - the human /copilot "Save call" button (rep_state mode): same shape the
//     old appendDemoCallRow wrote — kept working so the migration is a no-risk
//     swap of the URL on the client.
// Always writes the SAME demoCalls/{prospectKey}-{ts} doc shape (raw, cleaned,
// prospectKey, repName, outcome, createdAt) so downstream readers don't change.
//
// NOTE: DEMO_EXTRACTION_PROMPT below is a v1 — solid coverage of the variable
// set, but the per-variable extraction nuance (self-talk verbatim, the
// view-of-life correction signal, the fit_state read) should be refined against
// real transcripts + the samwise-script-work / synthesis-prompt rules before we
// lean on it for analytics.
/* eslint-disable max-len */
const DEMO_EXTRACTION_PROMPT = `You are extracting structured data from a transcript of a Samwise "Demo Call" — a ~50-minute Spanish-language diagnostic + sales call between a rep ("Asesora") and a prospect ("Prospecto"). Read the full transcript and output a SINGLE JSON object with EXACTLY the keys listed below. Use "" for anything genuinely not covered in the transcript. Output values in the prospect's own language. Do NOT invent content that is not in the transcript.

RULES:
- Preserve the prospect's own words and metaphors. Do NOT relabel their problem with clinical terms (never "adicción", "depresión", "ansiedad", "TDAH", "trauma"). This is data, not a diagnosis.
- self_talk_after_relapse: VERBATIM — the prospect's exact words about what they say to themselves after a setback, in their language. Do not paraphrase, translate, or clean it.
- For the judgment/select fields, use ONLY one of the listed options.

KEYS:
- referral (string): why they came / who recommended them.
- expectation (string): what they said they expect from the program, in their words.
- feelings_during_relapse (string): what they felt in the moment, their words.
- intention_behind_action (string): what the part of them that acted was trying to do for them (escape, soothe, seek) — surfaced via the rep's reframe.
- thoughts_during_relapse (string): what went through their head in the moment.
- self_talk_after_relapse (string): VERBATIM quote of what they tell themselves afterward.
- view_of_their_life_in_that_moment (string): how they see their life or themselves in that moment; preserve the emotional charge, do not soften.
- consequences_for_them (string): the cost in their life — relationships, work, health, dignity.
- grado_de_identificacion (one of: "low" | "medium" | "high" | ""): how identified the prospect is with the problem. Best signal: how precisely they corrected the rep's synthesis of their view-of-life (a precise correction = high; bland acceptance = low).
- biologic_symbolic_analogy (one of: "flu" | "cold" | "allergy" | "diabetes" | "cancer" | "other" | ""): the illness analogy used to build the desidentification frame.
- clinical_picture_description (string): the short externalised description used in the prospect's mantra ("Estoy enfermo con ___") — phrased as something they HAVE, in their voice.
- fit_state (one of: "qualified" | "still_disqualified"): after the desidentification work, did the prospect see THEMSELVES in the problem now (qualified) or see the value but as valid for someone else (still_disqualified)? Default "qualified" if the call closed normally and the prospect engaged with the frame as their own.
- time_spent_in_alternatives (string): how long they have spent on prior solutions.
- total_money_spent_in_alternatives (string): rough total they have spent on prior solutions.
- monthly_budget_willingness (string): what they would be willing to invest monthly.
- outcome (one of: "closed" | "follow-up" | "disqualified" | "no" | ""): how the call ended.
- next_step (string): the concrete next action agreed.
- rep_notes (string): anything notable for the clinician handoff. Include any referral names surfaced in the rebound, with the prospect's connection to each.

TRANSCRIPT:
[INSERT TRANSCRIPT HERE]`;
/* eslint-enable max-len */

/**
 * extractDemoCall (HTTP, CORS-enabled). See the section comment above.
 * Body (transcript mode): { mode?: "transcript", transcript, liveState?,
 *   prospect_name?, prospect_email?, language? }.
 * Body (rep_state mode):  { mode: "rep_state", raw?, cleaned,
 *   qualificationProspectKey? }.
 * Response: { ok: true, docId, prospectKey }.
 */
export const extractDemoCall = onRequest(
  {cors: true, timeoutSeconds: 120},
  async (req, res) => {
    interface TranscriptTurn {
      role: "user" | "assistant";
      content: string;
    }
    interface ExtractDemoBody {
      mode?: "transcript" | "rep_state";
      // transcript mode (agent / any transcribed demo)
      transcript?: TranscriptTurn[];
      liveState?: Record<string, string>;
      prospect_name?: string;
      prospect_email?: string;
      language?: "es" | "en";
      // rep_state mode (human /copilot Save button — migrated from
      // appendDemoCallRow)
      raw?: Record<string, string>;
      cleaned?: Record<string, string>;
      qualificationProspectKey?: string;
    }

    /**
     * prospectKey from a raw identity string — same algorithm as
     * appendDemoCallRow / extractQualification so lookups stay stable.
     * @param {string} identity Email or name.
     * @return {string} Normalized prospect key.
     */
    function toProspectKey(identity: string): string {
      return identity
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    }

    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method Not Allowed"});
        return;
      }
      const body = req.body as ExtractDemoBody;
      const db = getFirestore();

      // ── rep_state mode: identical contract to the old appendDemoCallRow ──
      if (
        body.mode === "rep_state" ||
        (!body.mode && body.cleaned && !body.transcript)
      ) {
        const cleaned = body.cleaned ?? {};
        const raw = body.raw ?? {};
        const prospectName = (cleaned.prospect_name ?? "").trim();
        if (!prospectName && !body.qualificationProspectKey) {
          res.status(400).json({
            error: "prospect_name or qualificationProspectKey required",
          });
          return;
        }
        const prospectKey =
          body.qualificationProspectKey || toProspectKey(prospectName);
        const docId = `${prospectKey}-${Date.now()}`;
        await db.collection("demoCalls").doc(docId).set({
          raw,
          cleaned,
          prospectKey,
          repName: cleaned.rep_name ?? "",
          outcome: cleaned.outcome ?? "",
          source: "rep_state",
          createdAt: FieldValue.serverTimestamp(),
        });
        res.status(200).json({ok: true, docId, prospectKey});
        return;
      }

      // ── transcript mode: agent (or any transcribed demo) ──
      const transcript = body.transcript;
      const language = body.language ?? "es";
      const liveState = body.liveState ?? {};
      const prospectName = (
        body.prospect_name ?? liveState.prospect_name ?? ""
      ).trim();
      if (!Array.isArray(transcript) || transcript.length === 0) {
        res.status(400).json({error: "transcript required (non-empty array)"});
        return;
      }

      const speakerLabels = language === "es" ?
        {user: "Prospecto", assistant: "Asesora"} :
        {user: "Prospect", assistant: "Advisor"};
      const rendered = transcript
        .map((t) => `${speakerLabels[t.role]}: ${t.content}`)
        .join("\n\n");
      const filledPrompt = DEMO_EXTRACTION_PROMPT.replace(
        "[INSERT TRANSCRIPT HERE]",
        () => rendered
      );

      const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
      const model = gemini.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {responseMimeType: "application/json"},
      });

      let extracted: Record<string, string> = {};
      try {
        const result = await model.generateContent(filledPrompt);
        const text = result.response.text();
        extracted = JSON.parse(text) as Record<string, string>;
      } catch (err) {
        // Don't lose the call — fall back to the agent's live state.
        logger.error("extractDemoCall: extraction failed", err);
        extracted = {};
      }

      // Merge: the transcript extraction is the more complete record, but
      // the agent's in-call JUDGMENTS (fit_state, grado_de_identificacion)
      // drove the actual call, so they stay authoritative. liveState
      // backfills anything the extractor left blank.
      const extractedNonEmpty = Object.fromEntries(
        Object.entries(extracted).filter(
          ([, v]) => typeof v === "string" && v.trim().length > 0
        )
      );
      const cleaned: Record<string, string> = {
        ...liveState,
        ...extractedNonEmpty,
      };
      for (const k of ["fit_state", "grado_de_identificacion"]) {
        if (liveState[k]) cleaned[k] = liveState[k];
      }
      if (prospectName) cleaned.prospect_name = prospectName;

      const identityRaw =
        body.prospect_email || prospectName || liveState.prospect_name || "";
      const prospectKey = toProspectKey(identityRaw);
      const docId = `${prospectKey}-${Date.now()}`;
      await db.collection("demoCalls").doc(docId).set({
        raw: liveState,
        cleaned,
        prospectKey,
        repName: liveState.rep_name ?? "Samwise Agent",
        outcome: cleaned.outcome ?? "",
        contact_email: body.prospect_email ?? "",
        language,
        source: "extractDemoCall",
        transcript,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.status(200).json({
        ok: true,
        docId,
        prospectKey,
        fit_state: cleaned.fit_state ?? "",
      });
    } catch (err) {
      logger.error("extractDemoCall failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  }
);

// =============================================================================
// Qualification Agent (web first-touch Fit Assessment)
// =============================================================================
// Two functions back the qualification agent that lives at
// samwise-landing/app/qualify:
//
//   - submitQualification: receives the payload from the agent's
//     submit-tool (voice or text), evaluates the rubric server-side
//     (qualified / disqualified), and writes a doc
//     to the `qualifications` collection.
//
//   - loadQualification: reads the latest qualification doc by a
//     prospect identifier (phone, email, or name). Consumed by
//     samwise-app/app/copilot when the rep starts a demo call.
//
// Rubric (mirrors the Fit Assessment Call Google Doc
// id=1pcE3Y7BZB_xUBFHK3der_CEvgaKazHZabV2utFZfCKM):
//   Priority 1 gates (all three must pass to qualify):
//     - decision_taken === "Y"
//     - behaviour_clarity === "clear"
//     - motivation_clarity === "clear"
// =============================================================================

/**
 * submitQualification (HTTP, CORS-enabled)
 *
 * Body: full QualificationPayload (see samwise-landing/lib/qualify/schema.ts).
 * Response: { ok: true, docId, outcome, prospectKey }
 *
 * Evaluates the rubric server-side. Always writes the doc, even for
 * disqualified or safety-flagged sessions — we want the data either way.
 */
export const submitQualification = onRequest(
  {cors: true},
  async (req, res) => {
    interface SubmitQualificationBody {
      // identifiers
      prospect_name: string;
      contact_email?: string;
      contact_phone?: string;
      language: "es" | "en";

      // Priority 1 — disqualification gates
      decision_taken: "Y" | "N";
      behaviour_clarity: "clear" | "vague";
      motivation_clarity: "clear" | "vague";

      // Priority 2 — captured iff Priority 1 passes (else absent)
      behaviour_to_change?: string;
      behaviour_example?: string;
      core_motivation?: string;
      problem_duration_self_reported?: string;
      life_stage_context?: string;
      /*
      symbolic_anchor_type?:
        | "religious"
        | "philosophical"
        | "esoteric"
        | "hyper-rational"
        | "none";
      symbolic_anchor_description?: string;
      alternatives_tried?: string;
      why_alternatives_failed?: string;
      alternatives_exhaustion_level?: "low" | "medium" | "high";
      */
    }

    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method Not Allowed"});
        return;
      }

      const payload = req.body as SubmitQualificationBody;

      if (!payload.prospect_name || !payload.language) {
        res.status(400).json({error: "prospect_name and language required"});
        return;
      }

      const qualified =
        payload.decision_taken === "Y" &&
        payload.behaviour_clarity === "clear" &&
        payload.motivation_clarity === "clear";

      const outcome: "qualified" | "disqualified" =
        qualified ? "qualified" : "disqualified";

      const identityRaw =
        payload.contact_phone ||
        payload.contact_email ||
        payload.prospect_name;

      const prospectKey = identityRaw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const db = getFirestore();
      const docId = `${prospectKey}-${Date.now()}`;
      await db.collection("qualifications").doc(docId).set({
        ...payload,
        outcome,
        qualified,
        prospectKey,
        createdAt: FieldValue.serverTimestamp(),
      });

      res.status(200).json({ok: true, docId, outcome, prospectKey});
    } catch (err) {
      logger.error("submitQualification failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  }
);

/**
 * loadQualification (HTTP, CORS-enabled)
 *
 * Body: { identifier: string }  — phone, email, or prospect name.
 * Response:
 *   { ok: true, qualification: <doc data> }
 *   { ok: false, reason: "not_found" }
 *
 * Returns the most recent qualification doc whose prospectKey matches
 * the normalized identifier. Consumed by samwise-app/app/copilot to
 * pre-fill demo-call variables.
 *
 * Note: requires a composite index on (prospectKey ASC, createdAt DESC)
 * in the `qualifications` collection. Firestore returns an
 * index-creation link in the error message on the first call.
 */
export const loadQualification = onRequest(
  {cors: true},
  async (req, res) => {
    interface LoadQualificationBody {
      identifier: string;
    }

    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method Not Allowed"});
        return;
      }

      const {identifier} = req.body as LoadQualificationBody;
      if (!identifier || typeof identifier !== "string") {
        res.status(400).json({error: "identifier required"});
        return;
      }

      const normalized = identifier
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const db = getFirestore();
      const snap = await db
        .collection("qualifications")
        .where("prospectKey", "==", normalized)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (snap.empty) {
        res.status(200).json({ok: false, reason: "not_found"});
        return;
      }

      res.status(200).json({ok: true, qualification: snap.docs[0].data()});
    } catch (err) {
      logger.error("loadQualification failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  }
);

/**
 * extractQualification (HTTP, CORS-enabled) — A4 of the
 * converse → extract redesign.
 *
 * The qualification agent (in ritual-agent's flows/qualification/) no
 * longer fills schemas during the call — it just converses and takes
 * live notes. At end-of-call (endCall tool OR participantDisconnected
 * OR idle_timeout), the worker POSTs the transcript here. This function:
 *   1. Runs Gemini 2.5 Flash with QUALIFICATION_EXTRACTION_PROMPT to turn
 *      the transcript into a QualificationPayload-shaped JSON.
 *   2. Computes outcome (qualified vs disqualified) from the three gate
 *      fields. Same rubric as the legacy submitQualification.
 *   3. Writes qualifications/{prospectKey}-{ts} doc (same shape +
 *      identity-chain as submitQualification).
 *   4. Writes a mail/ doc to trigger the Firebase Trigger Email
 *      extension (Gmail SMTP) — post-call confirmation email to the
 *      prospect, reply-to Samuel's gmail.
 *
 * Body: {
 *   transcript: Array<{ role: "user" | "assistant", content: string }>,
 *   prospect_name: string,
 *   prospect_email?: string,
 *   language: "es" | "en"
 * }
 * Response: { ok: true, docId, outcome, prospectKey }
 *
 * NOTE: idempotency is enforced on the worker side via a per-call
 * `submitted` flag — see ritual-agent/src/flows/qualification/index.ts.
 * If a misbehaving caller invokes this twice, two timestamped docs
 * land in Firestore. Acceptable for v1; revisit if it becomes noisy.
 */
export const extractQualification = onRequest(
  {cors: true, timeoutSeconds: 120},
  async (req, res) => {
    interface TranscriptTurn {
      role: "user" | "assistant";
      content: string;
    }
    interface ExtractQualificationBody {
      transcript: TranscriptTurn[];
      prospect_name: string;
      prospect_email?: string;
      language: "es" | "en";
    }
    interface ExtractedPayload {
      decision_taken: "Y" | "N" | "unknown";
      behaviour_clarity: "clear" | "vague" | "unknown";
      motivation_clarity: "clear" | "vague" | "unknown";
      behaviour_to_change: string;
      // Full grounded incident description (WHEN/WHERE/ACTIVITY/ACTION as
      // a noun-phrase). Used as Phase 5b Step 1's moment-anchor in the
      // Demo Call. See extraction prompt for the exact shape.
      behaviour_example: string;
      core_motivation: string;
      problem_duration_self_reported: string;
      life_stage_context: string;
      /*
      symbolic_anchor_type:
        | "religious"
        | "philosophical"
        | "esoteric"
        | "hyper-rational"
        | "none"
        | "unknown";
      symbolic_anchor_description: string;
      alternatives_tried: string;
      why_alternatives_failed: string;
      alternatives_exhaustion_level: "low" | "medium" | "high" | "unknown";
      */
    }

    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method Not Allowed"});
        return;
      }

      const body = req.body as ExtractQualificationBody;

      if (!body.prospect_name || !body.language) {
        res.status(400).json({error: "prospect_name and language required"});
        return;
      }
      if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
        res.status(400).json({error: "transcript required (non-empty array)"});
        return;
      }

      // Render the transcript as plain dialog for the extraction prompt.
      // Speaker labels are language-aware so the LLM doesn't get confused
      // about who said what when the conversation is in Spanish.
      const speakerLabels = body.language === "es" ?
        {user: "Prospecto", assistant: "Nova"} :
        {user: "Prospect", assistant: "Nova"};
      const renderedTranscript = body.transcript
        .map((t) => `${speakerLabels[t.role]}: ${t.content}`)
        .join("\n\n");

      const filledPrompt = QUALIFICATION_EXTRACTION_PROMPT.replace(
        "[INSERT TRANSCRIPT HERE]",
        () => renderedTranscript
      );

      const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
      const model = gemini.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {responseMimeType: "application/json"},
      });

      let extracted: ExtractedPayload;
      try {
        const result = await model.generateContent(filledPrompt);
        const text = result.response.text();
        extracted = JSON.parse(text) as ExtractedPayload;
      } catch (err) {
        logger.error("extractQualification: Gemini parse failed", err);
        res.status(502).json({error: "extraction LLM failed"});
        return;
      }

      // Outcome rubric — identical to submitQualification's. "unknown" on
      // any gate field counts as a non-pass (conservative). This matters
      // for: if the conversation ended abruptly (disconnect, idle), we
      // don't want to mark someone "qualified" off a half-conversation.
      const qualified =
        extracted.decision_taken === "Y" &&
        extracted.behaviour_clarity === "clear" &&
        extracted.motivation_clarity === "clear";
      const outcome: "qualified" | "disqualified" =
        qualified ? "qualified" : "disqualified";

      // prospectKey — same algorithm as submitQualification so /copilot's
      // loadQualification (keyed on prospectKey ASC, createdAt DESC) keeps
      // working without changes. Phone > email > name fallback chain.
      const identityRaw =
        body.prospect_email || body.prospect_name;
      const prospectKey = identityRaw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const db = getFirestore();
      const docId = `${prospectKey}-${Date.now()}`;
      await db.collection("qualifications").doc(docId).set({
        ...extracted,
        prospect_name: body.prospect_name,
        contact_email: body.prospect_email ?? "",
        language: body.language,
        outcome,
        qualified,
        prospectKey,
        source: "extractQualification",
        // Persist the full conversation transcript alongside the extracted
        // payload. The transcript was previously discarded after extraction,
        // making backfills + future re-extractions impossible. Storing it
        // here is the source-of-truth for any downstream need that wants
        // the raw conversation (re-extraction with a new prompt, richer
        // /copilot generations that consume source material directly, etc.).
        transcript: body.transcript,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Mail dispatch via Firebase Trigger Email extension (A5).
      // Skipped if the prospect didn't provide an email on the landing.
      if (body.prospect_email) {
        try {
          const firstName =
            body.prospect_name.split(/\s+/)[0] || body.prospect_name;
          await db.collection("mail").add(
            buildPostCallEmailDoc({
              to: body.prospect_email,
              language: body.language,
              firstName,
              extracted,
            })
          );
        } catch (err) {
          logger.error(
            "extractQualification: mail dispatch failed (continuing)",
            err
          );
          // Email is best-effort. Doc is already written; we don't fail
          // the call on email failure.
        }
      } else {
        logger.info(
          "extractQualification: no prospect_email, skipping mail dispatch",
          {prospectKey}
        );
      }

      res.status(200).json({ok: true, docId, outcome, prospectKey});
    } catch (err) {
      logger.error("extractQualification failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  }
);

/**
 * extractQualificationTherapist (HTTP, CORS-enabled) — the THERAPIST mirror of
 * extractQualification. The therapist qualification flow (in ritual-agent's
 * flows/qualification-therapist/) just converses and asks the four questions;
 * at end-of-call the worker POSTs the transcript here. This function:
 *   1. Runs Gemini 2.5 Flash with the therapist extraction prompt to turn the
 *      transcript into the four-field therapist payload.
 *   2. Always returns outcome "qualified" — the therapist call has NO gate
 *      (every therapist who answers is invited to book the 50-min demo).
 *   3. Writes qualifications/{prospectKey}-{ts} (same collection + identity
 *      chain as extractQualification, tagged audience: "therapist").
 *
 * Body + response shape are identical to extractQualification, so the worker's
 * submit path is byte-identical.
 */
export const extractQualificationTherapist = onRequest(
  {cors: true, timeoutSeconds: 120},
  async (req, res) => {
    interface TranscriptTurn {
      role: "user" | "assistant";
      content: string;
    }
    interface ExtractQualificationTherapistBody {
      transcript: TranscriptTurn[];
      prospect_name: string;
      prospect_email?: string;
      language: "es" | "en";
    }
    interface ExtractedPayload {
      patient_addiction_type: string;
      last_patient_occurrence: string;
      helped_patient_attempts: string;
      why_attempts_failed: string;
    }

    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method Not Allowed"});
        return;
      }

      const body = req.body as ExtractQualificationTherapistBody;
      if (!body.prospect_name || !body.language) {
        res.status(400).json({error: "prospect_name and language required"});
        return;
      }
      if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
        res.status(400).json({error: "transcript required (non-empty array)"});
        return;
      }

      const speakerLabels = body.language === "es" ?
        {user: "Terapeuta", assistant: "Nova"} :
        {user: "Therapist", assistant: "Nova"};
      const renderedTranscript = body.transcript
        .map((t) => `${speakerLabels[t.role]}: ${t.content}`)
        .join("\n\n");

      const filledPrompt = QUALIFICATION_THERAPIST_EXTRACTION_PROMPT.replace(
        "[INSERT TRANSCRIPT HERE]",
        () => renderedTranscript
      );

      const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
      const model = gemini.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {responseMimeType: "application/json"},
      });

      let extracted: ExtractedPayload;
      try {
        const result = await model.generateContent(filledPrompt);
        const text = result.response.text();
        extracted = JSON.parse(text) as ExtractedPayload;
      } catch (err) {
        logger.error("extractQualificationTherapist: Gemini parse failed", err);
        res.status(502).json({error: "extraction LLM failed"});
        return;
      }

      // No gate — every therapist who answers is invited to book the
      // 50-minute demo. Always qualified.
      const outcome: "qualified" | "disqualified" = "qualified";

      // prospectKey — same algorithm as extractQualification so /copilot's
      // loadQualification (keyed on prospectKey ASC, createdAt DESC) keeps
      // working without changes. Phone > email > name fallback chain.
      const identityRaw = body.prospect_email || body.prospect_name;
      const prospectKey = identityRaw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const db = getFirestore();
      const docId = `${prospectKey}-${Date.now()}`;
      await db.collection("qualifications").doc(docId).set({
        ...extracted,
        audience: "therapist",
        prospect_name: body.prospect_name,
        contact_email: body.prospect_email ?? "",
        language: body.language,
        outcome,
        qualified: true,
        prospectKey,
        source: "extractQualificationTherapist",
        // Persist the full conversation transcript alongside the extracted
        // payload (same rationale as extractQualification — re-extraction
        // with a new prompt becomes possible).
        transcript: body.transcript,
        createdAt: FieldValue.serverTimestamp(),
      });

      // NOTE: extractQualification dispatches a post-call confirmation email
      // here via the Firebase Trigger Email extension (buildPostCallEmailDoc).
      // Intentionally omitted for the therapist flow until we decide on the
      // therapist confirmation copy (the FinalScreen booking link already
      // takes the therapist into /book?type=therapist-demo, which has its
      // own confirmation email; a second "thanks for the call" email here
      // would be duplicative). Add a buildTherapistConfirmationEmailDoc and
      // dispatch here if we decide to send one.

      res.status(200).json({ok: true, docId, outcome, prospectKey});
    } catch (err) {
      logger.error("extractQualificationTherapist failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  }
);

/**
 * extractTrackingKpis (HTTP, CORS-enabled) — sister of extractQualification
 * for the tracking-agent converse → extract redesign.
 *
 * tracking-agent no longer fires tools during the call. It walks through
 * each behaviour conversationally; at end-of-call (endCall tool OR
 * SIP participant disconnect OR idle handler OR hard wall-clock cap),
 * the worker POSTs the full transcript here. This function:
 *   1. Renders BEHAVIOURS + TRANSCRIPT into TRACKING_EXTRACTION_PROMPT.
 *   2. Runs Gemini 2.5 Flash with responseMimeType: application/json.
 *   3. Returns the populated TrackingState (Record<googleDocId, KpiBundle>)
 *      back to the worker, which then POSTs it to tracking-workflow's
 *      tracking-callback as the `ritualKpis` field.
 *
 * Unlike extractQualification this function does NOT write to Firestore
 * and does NOT send any email — persistence lives in tracking-workflow's
 * callback, mirroring the existing contract.
 *
 * Body: {
 *   transcript: Array<{ role: "user" | "assistant", content: string }>,
 *   rituals: Array<{ googleDocId: string, name: string }>,
 *   language: "es" | "en"
 * }
 * Response: { ok: true, ritualKpis: Record<googleDocId, KpiBundle> }
 */
export const extractTrackingKpis = onRequest(
  {cors: true, timeoutSeconds: 120},
  async (req, res) => {
    interface TranscriptTurn {
      role: "user" | "assistant";
      content: string;
    }
    interface RitualInput {
      googleDocId: string;
      name: string;
    }
    interface ExtractTrackingBody {
      transcript: TranscriptTurn[];
      rituals: RitualInput[];
      language: "es" | "en";
    }
    interface KpiBundle {
      relapse: boolean | null;
      ritualFulfilled: boolean | null;
      answeredCall: boolean | null;
      ritualUsedOut: boolean;
    }
    type TrackingState = Record<string, KpiBundle>;

    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method Not Allowed"});
        return;
      }

      const body = req.body as ExtractTrackingBody;

      if (!body.language) {
        res.status(400).json({error: "language required"});
        return;
      }
      if (!Array.isArray(body.rituals) || body.rituals.length === 0) {
        res.status(400).json({error: "rituals required (non-empty array)"});
        return;
      }
      if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
        res.status(400).json({error: "transcript required (non-empty array)"});
        return;
      }

      // Render the transcript with language-aware speaker labels so the
      // extractor never has to guess who said what.
      const speakerLabels = body.language === "es" ?
        {user: "Usuario", assistant: "Agente"} :
        {user: "User", assistant: "Agent"};
      const renderedTranscript = body.transcript
        .map((t) => `${speakerLabels[t.role]}: ${t.content}`)
        .join("\n\n");

      // Behaviours block — one line per ritual so the extractor can map
      // user mentions back to the right googleDocId.
      const renderedBehaviours = body.rituals
        .map(
          (r, i) =>
            `  ${i + 1}. "${r.name}" (googleDocId: ${r.googleDocId})`
        )
        .join("\n");

      const filledPrompt = TRACKING_EXTRACTION_PROMPT
        .replace("[INSERT BEHAVIOURS HERE]", () => renderedBehaviours)
        .replace("[INSERT TRANSCRIPT HERE]", () => renderedTranscript);

      const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
      const model = gemini.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: {responseMimeType: "application/json"},
      });

      let extracted: TrackingState;
      try {
        const result = await model.generateContent(filledPrompt);
        const text = result.response.text();
        extracted = JSON.parse(text) as TrackingState;
      } catch (err) {
        logger.error("extractTrackingKpis: Gemini parse failed", err);
        res.status(502).json({error: "extraction LLM failed"});
        return;
      }

      // Defensive shape-check: ensure every requested ritual has a bundle
      // in the output, with sensible defaults if the model omitted one.
      // The downstream tracking-callback contract requires every ritual
      // key to be present.
      const ritualKpis: TrackingState = {};
      for (const r of body.rituals) {
        const raw = extracted[r.googleDocId];
        ritualKpis[r.googleDocId] = {
          relapse: typeof raw?.relapse === "boolean" ? raw.relapse : null,
          ritualFulfilled:
            typeof raw?.ritualFulfilled === "boolean" ?
              raw.ritualFulfilled :
              null,
          answeredCall:
            typeof raw?.answeredCall === "boolean" ? raw.answeredCall : null,
          ritualUsedOut: raw?.ritualUsedOut === true,
        };
      }

      res.status(200).json({ok: true, ritualKpis});
    } catch (err) {
      logger.error("extractTrackingKpis failed", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({error: message});
    }
  }
);

/* eslint-disable max-len */
/**
 * Build the document for the Firebase Trigger Email extension. The
 * extension watches the `mail/` collection and sends each doc via the
 * configured SMTP (Gmail in our case).
 *
 * Visual register mirrors the in-call <VariablesPanel> on /qualify:
 * editorial brand layout, small-caps Manrope-stack label, Fraunces-stack
 * italic verbatim quote, gold ✦ next to the wordmark, generous vertical
 * space. Table-based layout (not flexbox/grid) because email clients are
 * inconsistent — Outlook in particular collapses non-table layouts. All
 * styles are inline (no <style> block) so Outlook doesn't strip them.
 * Web fonts aren't loadable in many email clients, so the stack falls
 * back to system serif (Georgia) and system sans (Helvetica/Arial) —
 * the visual register is preserved even without Fraunces/Manrope.
 *
 * max-len disabled for the body because inline HTML/CSS attributes and
 * the bilingual copy strings are inherently long and read more clearly
 * as single lines.
 *
 * @param {object} params Inputs for the email body.
 * @param {string} params.to Recipient email address.
 * @param {"es"|"en"} params.language Language of the email body.
 * @param {string} params.firstName Recipient's first name for the greeting.
 * @param {object} params.extracted The structured fields from the extraction
 *   LLM. Empty strings for fields the conversation didn't surface.
 * @return {object} A Firestore document for the `mail/` collection,
 *   shaped for the Firebase Trigger Email extension.
 */
function buildPostCallEmailDoc(params: {
  to: string;
  language: "es" | "en";
  firstName: string;
  extracted: {
    behaviour_to_change: string;
    core_motivation: string;
    problem_duration_self_reported: string;
    life_stage_context: string;
    /*
    symbolic_anchor_description: string;
    alternatives_tried: string;
    why_alternatives_failed: string;
    */
  };
}): {
  to: string;
  replyTo: string;
  message: {subject: string; text: string; html: string};
} {
  const {to, language, firstName, extracted} = params;

  // ─── Copy ────────────────────────────────────────────────────────────────
  // Label pairs mirror samwise-landing's <VariablesPanel>.
  const labels = language === "es" ? {
    behaviour_to_change: "El comportamiento",
    core_motivation: "Por qué importa",
    problem_duration_self_reported: "Cuánto lleva",
    life_stage_context: "Dónde estás",
    /*
    symbolic_anchor_description: "De dónde sacas fuerza",
    alternatives_tried: "Lo que has intentado",
    why_alternatives_failed: "Lo que faltó",
    */
  } : {
    behaviour_to_change: "The behaviour",
    core_motivation: "Why it matters",
    problem_duration_self_reported: "How long",
    life_stage_context: "Where you are",
    /*
    symbolic_anchor_description: "What you draw on",
    alternatives_tried: "What you've tried",
    why_alternatives_failed: "What was missing",
    */
  };
  const greeting = language === "es" ?
    `Hola ${firstName},` :
    `Hi ${firstName},`;
  const intro = language === "es" ?
    "Esto es lo que entendí de nuestra conversación. Si algo está mal o quieres aclararlo antes de la breakthrough call, responde a este email con tus correcciones." :
    "Here's what I understood from our conversation. If anything is off or you want to clarify before the breakthrough call, just reply to this email with your corrections.";
  const sign = language === "es" ?
    "Gracias,\nSamuel" :
    "Thanks,\nSamuel";
  const subject = language === "es" ?
    "Lo que entendí de nuestra llamada" :
    "What I understood from our call";

  // ─── Plain-text fallback ─────────────────────────────────────────────────
  // Readable even in non-HTML mail clients. Curly quotes around values so
  // the structure survives plain rendering.
  const textRows: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const value = (extracted as Record<string, string>)[key];
    if (!value || value.trim().length === 0) continue;
    textRows.push(`${label}\n“${value.trim()}”`);
  }
  const text = `${greeting}\n\n${intro}\n\n${textRows.join("\n\n")}\n\n${sign}`;

  // ─── HTML body — table-based, inline-styled, email-client-safe ──────────
  // Brand tokens (mirror /qualify's qualify.css):
  //   --bg          #FFFFFF   --gold        #D4A85A
  //   --ink         #000000   --ink-mute    #555555
  // Stack: Georgia-as-Fraunces-fallback for the body type; Helvetica-as-
  // Manrope-fallback for the labels. Web font @import deliberately omitted
  // (unreliable across Outlook, Yahoo, K-9 Mail, etc.).

  const variableCells = Object.entries(labels)
    .map(([key, label]) => {
      const value = (extracted as Record<string, string>)[key];
      if (!value || value.trim().length === 0) return "";
      return `
        <tr><td style="padding: 0 0 36px 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr><td style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: 500; font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; color: #555555; padding: 0 0 10px 0;">
              ${escapeHtml(label)}
            </td></tr>
            <tr><td style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-weight: 400; font-size: 20px; line-height: 1.4; color: #000000;">
              &ldquo;${escapeHtml(value.trim())}&rdquo;
            </td></tr>
          </table>
        </td></tr>`;
    })
    .filter((s) => s.length > 0)
    .join("");

  const html = `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background: #FFFFFF; color: #000000;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: #FFFFFF;">
    <tr><td align="center" style="padding: 64px 24px 56px 24px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width: 560px; width: 100%;">

        <!-- Wordmark — Samwise + gold ✦, same DNA as canonical .qualify-brand -->
        <tr><td style="padding: 0 0 56px 0;">
          <span style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-weight: 400; font-size: 22px; letter-spacing: -0.01em; color: #000000;">Samwise</span><span style="color: #D4A85A; font-size: 9px; vertical-align: 12px; padding-left: 3px;">&#x2726;</span>
        </td></tr>

        <!-- Greeting -->
        <tr><td style="font-family: Georgia, 'Times New Roman', serif; font-weight: 400; font-size: 17px; line-height: 1.5; color: #000000; padding: 0 0 18px 0;">
          ${escapeHtml(greeting)}
        </td></tr>

        <!-- Intro -->
        <tr><td style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-weight: 400; font-size: 16px; line-height: 1.55; color: #1A1A1A; padding: 0 0 48px 0;">
          ${escapeHtml(intro)}
        </td></tr>

        <!-- Variable cards -->
        ${variableCells}

        <!-- Sign-off -->
        <tr><td style="font-family: Georgia, 'Times New Roman', serif; font-style: italic; font-weight: 400; font-size: 16px; line-height: 1.5; color: #000000; padding: 16px 0 0 0; white-space: pre-line;">
          ${escapeHtml(sign)}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    to,
    replyTo: "samuelgiraldoconcha@gmail.com",
    message: {subject, text, html},
  };
}
/* eslint-enable max-len */

/**
 * Minimal HTML-entity escaper for user-controlled strings rendered into
 * the email HTML body. Not a general-purpose sanitizer — used only for
 * the small set of fields the extraction LLM produces.
 * @param {string} s The string to escape.
 * @return {string} The HTML-escaped string.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
