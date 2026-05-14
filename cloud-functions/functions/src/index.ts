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
