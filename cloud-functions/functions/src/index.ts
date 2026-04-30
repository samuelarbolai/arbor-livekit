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
import {getFirestore} from "firebase-admin/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";

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

export const helloWorld = onRequest((request, response) => {
  logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});

// The Cloud Functions for Firebase SDK to create Cloud Functions and triggers.
initializeApp();
const db = getFirestore();
import "dotenv/config";
import {AgentDispatchClient} from "livekit-server-sdk";

export const makeCallsBatchFunction = onRequest(async (req, res) => {
  interface AgentConfig {
    userID: string;
    userInput: string;
    language?: string;
    voiceId?: string;
    phoneNumber: string;
  }

  const batchPayload = <AgentConfig[]>[];

  const LIVEKIT_URL = process.env.LIVEKIT_URL!;
  const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
  const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;

  const agentDispatchClient = new AgentDispatchClient(
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET
  );

  const agentName = "my-agent";

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

// For Colombia Central users
// Cron Syntax: "0,30 * * * *" (every 30 mins, on the hour and half hour)
export const checkUsersRituals = onSchedule({
  schedule: "0,30 * * * *",
  timeZone: "America/Bogota",
}, async (event) => {
  /*
  NOTE FOR FUTURE SELF:
  When we got a user from another timezone,
  just make a new cron job for their timezone.
  Don't try to do timezone calculations here, it is not worth the effort.
  */

  logger.info("Checking users' rituals...");

  const db = getFirestore();

  const now = new Date();

  // Round down to nearest 30-minute mark
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
