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

// Phase-extraction prompt used by loadCallScript. Same loading pattern as
// SYNTHESIS_PROMPT above — the build script copies the .txt file to lib/
// so __dirname resolution works at runtime. Edits to this prompt are
// free-form (no skill governs it) — it's a small JSON-out parsing task.
const LOAD_SCRIPT_PROMPT = fs.readFileSync(
  path.join(__dirname, "load_call_script_prompt.txt"),
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

      // Read the Google Doc content
      let docContent = "";
      try {
        const exportUrl = `https://docs.google.com/document/d/${documentId}/export?format=txt`;
        const response = await fetch(exportUrl);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        docContent = await response.text();
      } catch (error) {
        logger.error("Failed to read Google Doc via export link:", error);
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
      const enrichedDocContent =
        `${docContent}\n\n` +
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
 * loadCallScript (HTTP)
 *
 * Body: { googleDocLink: string }
 *
 * Reads the Doc via the Google Docs API, asks Gemini to parse it into a
 * phases array, returns { scriptType, phases }. Mirrors registerNewRitual's
 * shape but with a phase-extraction prompt instead of a synthesis prompt.
 *
 * Used by samwise-app/app/copilot/ at session start.
 */
export const loadCallScript = onRequest(
  {cors: true, timeoutSeconds: 120},
  async (req, res) => {
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

    const filledPrompt = LOAD_SCRIPT_PROMPT
      .replace("{{DOC_TITLE}}", title)
      .replace("{{DOC_CONTENT}}", content);

    const gemini = new GoogleGenerativeAI(requireEnv("GEMINI_KEY"));
    const model = gemini.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {responseMimeType: "application/json"},
    });
    const result = await model.generateContent(filledPrompt);
    const text = result.response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.error("loadCallScript: Gemini returned non-JSON", {text});
      res.status(502).json({error: "Gemini returned non-JSON"});
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    logger.error("loadCallScript failed", err);
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({error: message});
  }
  }
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
      core_motivation?: string;
      problem_duration_self_reported?: string;
      life_stage_context?: string;
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
