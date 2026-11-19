import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_MODEL = 'gemini-2.5-flash';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const TAX_VERIFICATION_SYSTEM_INSTRUCTION = `You are an expert Personal Tax Document Verification Assistant for a Malaysian accounting firm (LHDN personal income tax).
Your job is to inspect uploaded client tax documents (images or PDFs), identify what type of tax document each file is, verify its tax year, and compare the uploaded files against the client's Required Document Checklist.

Rules:
1. Classify each uploaded document accurately against Malaysia personal tax categories (e.g., EA Form / Employment Income, EPF / KWSP Statement, Medical & Lifestyle Receipts, Zakat / Donation Receipt, Insurance Statement, Bank Interest / Dividend Statement, CP58 Commission Statement, PCB / Monthly Tax Deduction Statement, or Unrecognized).
2. Extract key metadata: Taxpayer Name, Tax Year, and Total Amount in MYR (if applicable).
3. Compare verified documents (both newly uploaded valid documents AND already-verified items noted in the checklist) against the provided requiredDocuments list.
4. Match each uploaded file to the closest item in the client's requiredDocuments list when applicable, and put the exact matched checklist docType string into matchedChecklistDocType (or empty string if none matches).
5. Determine the exact recommendedJobStatus based on these strict rules:
   - "No Book In": 0 required documents have been verified/uploaded.
   - "Pending Document": At least 1 required document is verified/uploaded, but 1 or more required documents are still missing, wrong tax year, or unreadable.
   - "Book In Can Start": All required documents are present, legible, and match the requested tax year.
6. Draft a polite, clear reminder message listing ONLY the specific missing documents if the status is "Pending Document", a general booking-in reminder if "No Book In", or a warm confirmation that all documents are complete and handed over to our tax preparer if "Book In Can Start".

Output strictly in the requested JSON schema.`;

interface UploadedFilePayload {
  fileName: string;
  mimeType: string;
  data: string; // base64 without data URL prefix
}

interface ChecklistItemInput {
  docType: string;
  status: string;
  fileName?: string | null;
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '30mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, model: GEMINI_MODEL });
  });

  /**
   * POST /api/verify-documents
   * Runs multimodal Gemini 2.5 Flash verification against uploaded PDFs / images.
   */
  app.post('/api/verify-documents', async (req, res) => {
    try {
      const {
        clientName,
        clientId,
        taxYear,
        filingCategory,
        requiredDocuments,
        files,
      } = req.body as {
        clientName?: string;
        clientId?: string;
        taxYear?: number;
        filingCategory?: string;
        requiredDocuments?: ChecklistItemInput[];
        files?: UploadedFilePayload[];
      };

      if (!Array.isArray(requiredDocuments) || requiredDocuments.length === 0) {
        return res.status(400).json({ error: 'Client requiredDocuments checklist is required.' });
      }
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'Please attach at least one PDF or image tax document.' });
      }
      if (files.length > 10) {
        return res.status(400).json({ error: 'A maximum of 10 files can be verified per batch.' });
      }

      const ai = getGeminiClient();

      const parts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [
        {
          text: `Analyze the attached tax documents for Malaysian personal tax Year of Assessment (YA) ${taxYear ?? 2026}.
Client Name: ${clientName ?? 'Taxpayer'}
Client Reference ID: ${clientId ?? 'N/A'}
Filing Category: ${filingCategory ?? 'Form BE (Salaried)'}
Current Required Document Checklist (items already marked "Verified" should remain satisfied unless contradicted):
${JSON.stringify(requiredDocuments, null, 2)}

Uploaded files in order:
${files.map((f, idx) => `${idx + 1}. ${f.fileName} (${f.mimeType})`).join('\n')}

Inspect every attached document carefully. Verify whether the tax year matches YA ${taxYear ?? 2026}, extract MYR monetary totals where shown, map each valid file to the exact docType in the checklist if applicable, identify all still-missing docTypes from the checklist, determine recommendedJobStatus, and write automatedReminderDraft.`,
        },
      ];

      for (const file of files) {
        const cleanBase64 = file.data.includes(',') ? file.data.split(',')[1] : file.data;
        parts.push({
          text: `--- Document File: ${file.fileName} ---`,
        });
        parts.push({
          inlineData: {
            mimeType: file.mimeType || 'image/png',
            data: cleanBase64,
          },
        });
      }

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: { parts },
        config: {
          systemInstruction: TAX_VERIFICATION_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
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
                    matchedChecklistDocType: { type: Type.STRING },
                    taxpayerName: { type: Type.STRING },
                    taxYearValid: { type: Type.BOOLEAN },
                    extractedAmount: { type: Type.NUMBER },
                    notes: { type: Type.STRING },
                  },
                  required: ['fileName', 'documentCategory', 'taxYearValid'],
                },
              },
              missingDocuments: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              recommendedJobStatus: {
                type: Type.STRING,
                enum: ['No Book In', 'Pending Document', 'Book In Can Start'],
              },
              automatedReminderDraft: {
                type: Type.STRING,
              },
            },
            required: [
              'detectedDocuments',
              'missingDocuments',
              'recommendedJobStatus',
              'automatedReminderDraft',
            ],
          },
        },
      });

      const rawText = response.text;
      if (!rawText) {
        return res.status(502).json({ error: 'Gemini returned an empty response.' });
      }

      const parsed = JSON.parse(rawText);
      return res.json(parsed);
    } catch (error) {
      console.error('Error verifying documents with Gemini:', error);
      const message = error instanceof Error ? error.message : 'Document verification failed.';
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/draft-reminder
   * Generates polished Malaysia personal tax Email + WhatsApp follow-up drafts via Gemini 2.5 Flash.
   */
  app.post('/api/draft-reminder', async (req, res) => {
    try {
      const {
        clientName,
        clientId,
        taxYear,
        jobStatus,
        missingDocuments,
        verifiedDocuments,
        stage,
        daysSinceLastReminder,
      } = req.body as {
        clientName?: string;
        clientId?: string;
        taxYear?: number;
        jobStatus?: string;
        missingDocuments?: string[];
        verifiedDocuments?: string[];
        stage?: string;
        daysSinceLastReminder?: number | null;
      };

      const ai = getGeminiClient();

      const prompt = `Draft a concise, courteous, professional Malaysian personal tax client communication for:
- Client Name: ${clientName ?? 'Valued Client'}
- Reference ID: ${clientId ?? 'TAX-2026'}
- Tax Year: YA ${taxYear ?? 2026}
- Current Status: ${jobStatus ?? 'Pending Document'}
- Workflow Stage: ${stage ?? 'Missing Doc Alert'}
- Days Since Last Reminder: ${daysSinceLastReminder ?? 'None'}
- Already Verified Documents: ${JSON.stringify(verifiedDocuments ?? [])}
- Specific Missing Documents: ${JSON.stringify(missingDocuments ?? [])}

Requirements:
1. If status is "Pending Document", acknowledge the received documents and list ONLY the specific missing documents clearly.
2. If status is "No Book In" and stage is "7-Day Follow-up", write a polite escalating reminder encouraging initial booking-in via the client portal.
3. If status is "Book In Can Start", confirm all documents are complete and inform the client that tax computation has begun.
4. Provide a crisp Email subject line, a clean Email body, and a concise WhatsApp message (ready to paste, without excessive emojis).`;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          systemInstruction:
            'You are a client operations specialist at a Malaysian chartered accounting firm communicating clearly about LHDN personal income tax filings.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              subject: { type: Type.STRING },
              emailBody: { type: Type.STRING },
              whatsappBody: { type: Type.STRING },
            },
            required: ['subject', 'emailBody', 'whatsappBody'],
          },
        },
      });

      const rawText = response.text;
      if (!rawText) {
        return res.status(502).json({ error: 'Gemini returned an empty reminder draft.' });
      }

      return res.json(JSON.parse(rawText));
    } catch (error) {
      console.error('Error drafting reminder with Gemini:', error);
      const message = error instanceof Error ? error.message : 'Failed to draft reminder.';
      return res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CukaiDesk server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
