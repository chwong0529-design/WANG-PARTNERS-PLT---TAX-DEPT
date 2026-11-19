# Personal Tax Client Portal & Automated Document Tracking System
**Target Platform:** Google AI Studio (Gemini 2.5 Flash) + Firebase / Google Cloud  
**Region Context:** Malaysia Personal Tax (e.g., EA Form, EPF/KWSP, CP58, LHDN Tax Reliefs)

---

## 1. System Architecture & Tech Stack
To build this efficiently using Google’s ecosystem, structure your application with the following components:

* **Frontend (Client Portal & Staff Dashboard):** React or Next.js (prototyped via Google AI Studio Build / Project IDX).
* **AI Engine (Document Detection & Missing Item Analysis):** **Gemini 2.5 Flash** (multimodal capabilities read uploaded PDFs, JPEGs, and scans of tax forms and classify them automatically).
* **Database & Authentication:** **Firebase Authentication** (secure client logins via Email/Magic Link) and **Cloud Firestore** (stores client profiles, required document checklists, uploaded file metadata, and job statuses).
* **File Storage:** **Google Cloud Storage** or **Firebase Storage** (encrypted storage for sensitive tax PDFs/images).
* **Automated Reminders:** **Cloud Functions / Cloud Scheduler** integrated with **SendGrid/Gmail API** (for email) or **Twilio/WhatsApp Business API** (for automated follow-ups).

---

## 2. Core Database Schema (Cloud Firestore)
Design your database around a `clients` collection so status updates and reminders run automatically based on real-time data:

```json
{
  "clientId": "TAX-2026-089",
  "name": "Ahmad Razak",
  "email": "ahmad@example.com",
  "phone": "+60123456789",
  "taxYear": 2026,
  "jobStatus": "Pending Document",
  "lastReminderSent": "2026-11-15T09:00:00Z",
  "requiredDocuments": [
    {
      "docType": "EA Form / Employment Income",
      "status": "Verified",
      "fileUrl": "gs://tax-portal-docs/TAX-2026-089/ea_form.pdf"
    },
    {
      "docType": "EPF / KWSP Statement",
      "status": "Missing",
      "fileUrl": null
    },
    {
      "docType": "Medical & Lifestyle Receipts",
      "status": "Missing",
      "fileUrl": null
    },
    {
      "docType": "Bank Interest / Dividend Statement",
      "status": "Verified",
      "fileUrl": "gs://tax-portal-docs/TAX-2026-089/dividend.pdf"
    }
  ]
}
```

### Job Status Definitions
* **`No Book In`**: Client has been invited, but 0 documents have been uploaded.
* **`Pending Document`**: Client has uploaded at least 1 document, but 1 or more required documents are still missing or invalid.
* **`Book In Can Start`**: All required documents have been received, verified for the correct tax year, and the file is ready for the tax preparer.

---

## 3. Google AI Studio Configuration

### A. System Instructions
When building the AI document-verification engine in **Google AI Studio**, select **Gemini 2.5 Flash**, enable **Structured Outputs (JSON)**, and paste the following into the **System Instructions** panel:

```text
You are an expert Personal Tax Document Verification Assistant for an accounting firm. 
Your job is to inspect uploaded client tax documents (images or PDFs), identify what type of tax document each file is, verify its tax year, and compare the uploaded files against the client's Required Document Checklist.

Rules:
1. Classify each uploaded document accurately (e.g., Employment Income/EA Form, EPF Statement, Medical Receipt, Zakat/Donation Receipt, Insurance Statement, Dividend Voucher, CP58, or Unrecognized).
2. Extract key metadata: Taxpayer Name, Tax Year, and Total Amount (if applicable).
3. Compare verified documents against the provided `requiredDocuments` list.
4. Determine the exact `jobStatus` based on these strict rules:
   - "No Book In": 0 required documents have been uploaded.
   - "Pending Document": At least 1 document is uploaded, but 1 or more required documents are still missing or unreadable.
   - "Book In Can Start": All required documents are present, legible, and match the current tax year.
5. Draft a polite, clear reminder message listing ONLY the specific missing documents if the status is "Pending Document", or a general booking-in reminder if "No Book In".

Output strictly in the requested JSON schema.
```

### B. Structured Output Schema (JSON)
In Google AI Studio, click **Structured Output** -> **Edit Schema** and input this JSON schema so your app's backend can reliably read Gemini's response and update the database automatically:

```json
{
  "type": "object",
  "properties": {
    "detectedDocuments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fileName": { "type": "string" },
          "documentCategory": { "type": "string" },
          "taxYearValid": { "type": "boolean" },
          "extractedAmount": { "type": "number" },
          "notes": { "type": "string" }
        },
        "required": ["fileName", "documentCategory", "taxYearValid"]
      }
    },
    "missingDocuments": {
      "type": "array",
      "items": { "type": "string" }
    },
    "recommendedJobStatus": {
      "type": "string",
      "enum": ["No Book In", "Pending Document", "Book In Can Start"]
    },
    "automatedReminderDraft": {
      "type": "string"
    }
  },
  "required": [
    "detectedDocuments",
    "missingDocuments",
    "recommendedJobStatus",
    "automatedReminderDraft"
  ]
}
```

---

## 4. Automated Workflow Logic

| Stage | Trigger Condition | Automated App Action |
| :--- | :--- | :--- |
| **1. Initial Outreach** | Tax season opens; client status is `No Book In`. | Sends scheduled Email/WhatsApp with unique client login link and personalized checklist. |
| **2. Non-Response Follow-up** | Status remains `No Book In` after 7 days. | Automatically dispatches escalating gentle reminders every 7 days until first upload occurs. |
| **3. AI Document Check** | Client logs in and uploads files via portal. | Files are passed to Gemini 2.5 Flash API. Gemini classifies files and updates `missingDocuments`. |
| **4. Missing Doc Alert** | Gemini detects incomplete checklist. | Status updates to `Pending Document`. App sends an itemized alert: *"We received your EA Form, but we are still missing your EPF Statement."* |
| **5. Ready for Tax Prep** | `missingDocuments` array becomes empty (`[]`). | Status automatically flips to `Book In Can Start`. Tax staff receive a dashboard notification to begin tax computation. |

---

## 5. Sample Implementation Code (Node.js / Google GenAI SDK)
Use the official `@google/genai` SDK to connect uploaded client documents to your Google AI Studio prompt logic:

```javascript
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function verifyClientTaxDocuments(clientChecklist, uploadedFiles) {
  const prompt = `
    Analyze the attached tax documents for tax year 2026.
    Client Required Checklist: ${JSON.stringify(clientChecklist)}
  `;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [prompt, ...uploadedFiles],
    config: {
      systemInstruction: "You are an expert Personal Tax Document Verification Assistant...",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          detectedDocuments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                fileName: { type: Type.STRING },
                documentCategory: { type: Type.STRING },
                taxYearValid: { type: Type.BOOLEAN },
                extractedAmount: { type: Type.NUMBER },
                notes: { type: Type.STRING }
              },
              required: ["fileName", "documentCategory", "taxYearValid"]
            }
          },
          missingDocuments: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          },
          recommendedJobStatus: {
            type: Type.STRING,
            enum: ["No Book In", "Pending Document", "Book In Can Start"]
          },
          automatedReminderDraft: {
            type: Type.STRING
          }
        },
        required: [
          "detectedDocuments",
          "missingDocuments",
          "recommendedJobStatus",
          "automatedReminderDraft"
        ]
      }
    }
  });

  return JSON.parse(response.text);
}
```