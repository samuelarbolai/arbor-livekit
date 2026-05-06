const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const docContent = `
Tab 1
This user has put nothing here.
User Config
Spanish
Same voice as before.
Everything is the Same. 
Samuel Girlado Concha is the user. 
ID is: 
"pZX1S3FySfgre88oHxHu09JqMGz1"
Tab 6
This is yet another test. Fuckencio is the codeword.
`;

async function run() {
  const GEMINI_KEY = process.env.GEMINI_KEY;
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
    },
  });

  const fullPrompt = `
      Instructions:
      Please extract the requested information from the provided document.

      Document Content:
      ${docContent}

      Return a JSON object that exactly matches this structure:
      {
        "agentConfig": {
          "language": "string",
          "phoneNumber": "string",
          "userInputs": "string",
          "voiceID": "string"
        },
        "fallbackSchedules": ["string"],
        "fallbackActive": true,
        "schedules": ["string"],
        "timeZone": "string",
        "userID": "string",
        "googleDocsLink": "string"
      }
    `;

  const result = await model.generateContent(fullPrompt);
  console.log(result.response.text());
}

run().catch(console.error);
