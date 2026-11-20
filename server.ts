import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import multer from 'multer';
import QRCode from 'qrcode';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_MODEL = 'gemini-3.8-flash';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const DOCUMENT_CATEGORY_ENUM = [
  'EA Form / Employment Income',
  'EPF / KWSP Statement',
  'CP58 Commission Statement',
  'Medical Receipt',
  'Lifestyle / Tech Receipt',
  'Insurance / Takaful Statement',
  'Zakat / Approved Donation Receipt',
  'Dividend / Bank Interest Voucher',
  'Unrecognized / Blurry',
] as const;

// Strictly server-side Gemini SDK initialization
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

function assertGeminiKey(): void {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
}

// ---------------------------------------------------------------------------
// Standard RFC 6238 TOTP Implementation (Secrets Strictly Server-Side)
// ---------------------------------------------------------------------------
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_ISSUER = 'CukaiDesk';

// Secrets are held strictly on the backend and never exposed to the browser
const pendingTotpSecrets = new Map<string, { secret: Buffer; createdAt: number }>();
const boundTotpSecrets = new Map<string, { secret: Buffer; boundAt: number }>();

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i += 1) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function generateHotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const hmac = crypto.createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 10 ** TOTP_DIGITS;
  return String(otp).padStart(TOTP_DIGITS, '0');
}

function verifyTotpCode(secret: Buffer, submittedCode: string, windowSteps = 1): boolean {
  const cleanCode = submittedCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) return false;

  const currentCounter = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  const codeBuf = Buffer.from(cleanCode, 'utf8');

  for (let delta = -windowSteps; delta <= windowSteps; delta += 1) {
    const candidate = generateHotp(secret, currentCounter + delta);
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (
      candidateBuf.length === codeBuf.length &&
      crypto.timingSafeEqual(candidateBuf, codeBuf)
    ) {
      return true;
    }
  }
  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported file type (${file.mimetype}). Please upload a PDF, JPEG, PNG, or WebP document.`
        )
      );
    }
  },
});

const ANALYZE_DOCUMENT_SYSTEM_INSTRUCTION = `You are a Malaysian Personal Income Tax (LHDN) Document & Receipt Reader for a chartered accounting firm.
Your task is to inspect a single uploaded PDF or image (receipt, EA Form, EPF/KWSP statement, CP58 commission voucher, medical bill, lifestyle/tech receipt, insurance/takaful statement, zakat/donation receipt, or dividend/bank interest voucher) and extract structured tax data accurately.

Strict Rules:
1. Classify documentCategory strictly into one of the allowed enum values:
   - "EA Form / Employment Income"
   - "EPF / KWSP Statement"
   - "CP58 Commission Statement"
   - "Medical Receipt"
   - "Lifestyle / Tech Receipt"
   - "Insurance / Takaful Statement"
   - "Zakat / Approved Donation Receipt"
   - "Dividend / Bank Interest Voucher"
   - "Unrecognized / Blurry"
2. Set isLegible to false if the image is blurry, cropped, cut off, dark, low-resolution, or unreadable so amounts/dates/issuer cannot be verified reliably. Otherwise set isLegible to true.
3. Extract merchantOrIssuer (employer name, hospital/clinic, insurer, takaful operator, zakat center, bank, or retail vendor). Use "" if unreadable.
4. Extract receiptDate in strict YYYY-MM-DD format (or "" if no date is found).
5. Extract taxYear as an integer Year of Assessment (e.g., 2026) detected on the document (or 0 if no year is found).
6. Set taxYearMatches to true ONLY if the detected taxYear equals the client's active Year of Assessment provided in the prompt. Otherwise set taxYearMatches to false.
7. Extract totalAmountMYR as a numeric total in Malaysian Ringgit (MYR) — e.g., gross annual remuneration/total paid/total contribution/receipt grand total. Use 0 if no monetary amount is shown.
8. Map taxReliefCategory to the applicable LHDN Malaysia personal tax relief or income category (e.g., "Income", "EPF & Life Insurance", "Medical Expenses", "Lifestyle", "Education & Medical Insurance", "Zakat", "Approved Donation", "Investment Income", or "Not Applicable").
9. Provide concise confidenceNotes explaining what was extracted or why the document needs manual review (e.g., blurry text, wrong tax year, missing total).
10. Match the document against the client's requiredDocuments checklist array and set matchedChecklistItem to the EXACT matching string from requiredDocuments, or "" if none of the checklist items apply.

Return ONLY valid JSON conforming strictly to the responseSchema.`;

const TAX_VERIFICATION_SYSTEM_INSTRUCTION = `You are an expert Personal Tax Document Verification Assistant for a Malaysian accounting firm (LHDN personal income tax).
Your job is to inspect uploaded client tax documents (images or PDFs), identify what type of tax document each file is, verify its tax year, and compare the uploaded files against the client's Required Document Checklist.

Rules:
1. Classify each uploaded document accurately against Malaysia personal tax categories.
2. Extract key metadata: Taxpayer Name, Tax Year, and Total Amount in MYR (if applicable).
3. Compare verified documents (both newly uploaded valid documents AND already-verified items noted in the checklist) against the provided requiredDocuments list.
4. Match each uploaded file to the closest item in the client's requiredDocuments list when applicable, and put the exact matched checklist docType string into matchedChecklistDocType (or empty string if none matches).
5. Determine the exact recommendedJobStatus: "No Book In", "Pending Document", or "Book In Can Start".
6. Draft a polite, clear reminder message listing ONLY the specific missing documents if needed.

Output strictly in the requested JSON schema.`;

interface UploadedFilePayload {
  fileName: string;
  mimeType: string;
  data: string;
}

interface ChecklistItemInput {
  docType: string;
  status: string;
  fileName?: string | null;
}

function parseRequiredDocumentsField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) =>
        typeof item === 'string'
          ? item.trim()
          : item && typeof item === 'object' && 'docType' in item
            ? String((item as { docType: unknown }).docType).trim()
            : ''
      )
      .filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parseRequiredDocumentsField(parsed);
    } catch {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '30mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, model: GEMINI_MODEL });
  });

  /**
   * POST /api/2fa/setup
   * Generates a fresh RFC 6238 TOTP secret strictly on the server and returns
   * only a scannable authenticator QR code data URL (never exposing raw secret).
   */
  app.post('/api/2fa/setup', async (req, res) => {
    try {
      const { uid, email } = req.body as { uid?: string; email?: string };
      const cleanUid = String(uid || '').trim();
      const cleanEmail = String(email || '').trim().toLowerCase();

      if (!cleanUid || !cleanEmail) {
        return res.status(400).json({ error: 'Authenticated user uid and email are required.' });
      }

      const secretBytes = crypto.randomBytes(20);
      const base32Secret = encodeBase32(secretBytes);
      pendingTotpSecrets.set(cleanUid, {
        secret: secretBytes,
        createdAt: Date.now(),
      });

      const label = encodeURIComponent(`${TOTP_ISSUER}:${cleanEmail}`);
      const issuerParam = encodeURIComponent(TOTP_ISSUER);
      const otpauthUri = `otpauth://totp/${label}?secret=${base32Secret}&issuer=${issuerParam}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;

      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 220,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
      });

      return res.json({
        qrCodeDataUrl,
        issuer: TOTP_ISSUER,
        accountName: cleanEmail,
        digits: TOTP_DIGITS,
        periodSeconds: TOTP_PERIOD_SECONDS,
      });
    } catch (error) {
      console.error('Error setting up 2FA TOTP:', error);
      return res.status(500).json({ error: 'Failed to generate authenticator setup QR code.' });
    }
  });

  /**
   * POST /api/2fa/verify
   * Verifies a 6-digit RFC 6238 TOTP code against the server-stored pending or bound secret.
   */
  app.post('/api/2fa/verify', (req, res) => {
    try {
      const { uid, code, action } = req.body as {
        uid?: string;
        code?: string;
        action?: 'bind' | 'verify' | 'clear';
      };
      const cleanUid = String(uid || '').trim();

      if (!cleanUid) {
        return res.status(400).json({ valid: false, error: 'Authenticated user uid is required.' });
      }

      if (action === 'clear') {
        pendingTotpSecrets.delete(cleanUid);
        boundTotpSecrets.delete(cleanUid);
        return res.json({ valid: true, cleared: true });
      }

      const cleanCode = String(code || '').replace(/\s+/g, '');
      if (!/^\d{6}$/.test(cleanCode)) {
        return res
          .status(400)
          .json({ valid: false, error: 'Enter a valid 6-digit authenticator code.' });
      }

      const pending = pendingTotpSecrets.get(cleanUid);
      if (pending && verifyTotpCode(pending.secret, cleanCode, 1)) {
        boundTotpSecrets.set(cleanUid, {
          secret: pending.secret,
          boundAt: Date.now(),
        });
        pendingTotpSecrets.delete(cleanUid);
        return res.json({ valid: true, bound: true, verifiedAt: new Date().toISOString() });
      }

      const bound = boundTotpSecrets.get(cleanUid);
      if (bound && verifyTotpCode(bound.secret, cleanCode, 1)) {
        return res.json({ valid: true, bound: true, verifiedAt: new Date().toISOString() });
      }

      if (!pending && !bound) {
        return res.status(400).json({
          valid: false,
          error: 'No active authenticator setup found on the server. Generate a fresh QR code first.',
        });
      }

      return res.status(400).json({
        valid: false,
        error: 'Invalid or expired 6-digit code. Check your authenticator app and try again.',
      });
    } catch (error) {
      console.error('Error verifying 2FA TOTP code:', error);
      return res.status(500).json({ valid: false, error: 'Failed to verify authenticator code.' });
    }
  });

  /**
   * POST /api/analyze-document
   * Accepts multipart/form-data (via multer memory storage, max 15MB) or JSON base64 payload.
   * Analyzes a single receipt or tax document using Gemini 3.8 Flash with a strict JSON schema.
   */
  app.post('/api/analyze-document', (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      upload.single('file')(req, res, (err: unknown) => {
        if (err) {
          if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res
              .status(400)
              .json({ error: 'Uploaded file exceeds the 15MB maximum size limit.' });
          }
          const msg = err instanceof Error ? err.message : 'File upload failed.';
          return res.status(400).json({ error: msg });
        }
        return next();
      });
    } else {
      return next();
    }
  }, async (req, res) => {
    try {
      assertGeminiKey();

      const body = req.body as Record<string, unknown>;
      const clientId = String(body.clientId || '').trim();
      const taxYear = Number(body.taxYear) || new Date().getFullYear();
      const requiredDocuments = parseRequiredDocumentsField(body.requiredDocuments);

      let base64Data = '';
      let mimeType = '';
      let fileName = '';

      if (req.file) {
        base64Data = req.file.buffer.toString('base64');
        mimeType = req.file.mimetype;
        fileName = req.file.originalname || 'uploaded-document';
      } else if (typeof body.fileBase64 === 'string' && body.fileBase64.trim()) {
        const rawBase64 = body.fileBase64.trim();
        base64Data = rawBase64.includes(',') ? rawBase64.split(',')[1] : rawBase64;
        mimeType = String(body.mimeType || '').trim();
        fileName = String(body.fileName || 'uploaded-document').trim();

        const estimatedBytes = Math.ceil((base64Data.length * 3) / 4);
        if (estimatedBytes > MAX_UPLOAD_BYTES) {
          return res
            .status(400)
            .json({ error: 'Uploaded file exceeds the 15MB maximum size limit.' });
        }
      } else {
        return res
          .status(400)
          .json({ error: 'No document file provided. Please upload a PDF, JPEG, PNG, or WebP file.' });
      }

      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        return res.status(400).json({
          error: `Unsupported file type (${mimeType || 'unknown'}). Allowed types: PDF, JPEG, PNG, WebP.`,
        });
      }

      const promptText = `Analyze the attached Malaysian personal tax document or receipt.
Client Reference ID: ${clientId || 'N/A'}
Active Year of Assessment (YA): ${taxYear}
Original File Name: ${fileName}
Client Required Document Checklist:
${JSON.stringify(requiredDocuments, null, 2)}

Extract all required fields strictly according to the schema. Set taxYearMatches to true only when the document's Year of Assessment matches ${taxYear}. Set matchedChecklistItem to the exact string from the checklist above that this file satisfies, or "" if none matches.`;

      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType,
              },
            },
            {
              text: promptText,
            },
          ],
        },
        config: {
          systemInstruction: ANALYZE_DOCUMENT_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              documentCategory: {
                type: Type.STRING,
                enum: [...DOCUMENT_CATEGORY_ENUM],
              },
              isLegible: {
                type: Type.BOOLEAN,
              },
              merchantOrIssuer: {
                type: Type.STRING,
              },
              receiptDate: {
                type: Type.STRING,
              },
              taxYear: {
                type: Type.INTEGER,
              },
              taxYearMatches: {
                type: Type.BOOLEAN,
              },
              totalAmountMYR: {
                type: Type.NUMBER,
              },
              taxReliefCategory: {
                type: Type.STRING,
              },
              confidenceNotes: {
                type: Type.STRING,
              },
              matchedChecklistItem: {
                type: Type.STRING,
              },
            },
            required: [
              'documentCategory',
              'isLegible',
              'merchantOrIssuer',
              'receiptDate',
              'taxYear',
              'taxYearMatches',
              'totalAmountMYR',
              'taxReliefCategory',
              'confidenceNotes',
              'matchedChecklistItem',
            ],
          },
        },
      });

      const rawText = response.text;
      if (!rawText) {
        return res.status(502).json({ error: 'Gemini returned an empty document analysis response.' });
      }

      const parsed = JSON.parse(rawText);
      return res.json({
        fileName,
        ...parsed,
      });
    } catch (error) {
      console.error('Error analyzing document with Gemini:', error);
      const message = error instanceof Error ? error.message : 'Document analysis failed.';
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/verify-documents
   * Batch multimodal verification endpoint retained for backwards compatibility.
   */
  app.post('/api/verify-documents', async (req, res) => {
    try {
      assertGeminiKey();

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
${files.map((f, idx) => `${idx + 1}. ${f.fileName} (${f.mimeType})`).join('\n')}`,
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
   * Generates polished Malaysia personal tax Email + WhatsApp follow-up drafts via Gemini.
   */
  app.post('/api/draft-reminder', async (req, res) => {
    try {
      assertGeminiKey();

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
