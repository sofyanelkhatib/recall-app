/* ================================================================
   RECALL — core application logic
   Sections: CONFIG · STORAGE (IndexedDB) · PDF/TEXT PARSING ·
   CHUNKING · AI PROVIDERS (Groq/Gemini) · JSON IMPORT ·
   SM-2 SCHEDULER · UI CONTROLLER · VIEW RENDERERS
   ================================================================ */

/* ----------------------------------------------------------------
   CONFIG
   Model IDs are isolated here on purpose: providers rename/deprecate
   models periodically. If a call starts failing with a "model not
   found" style error, this is the only place that needs to change.
   ---------------------------------------------------------------- */
const CONFIG = {
  GROQ_MODEL: "openai/gpt-oss-120b",
  GROQ_ENDPOINT: "https://api.groq.com/openai/v1/chat/completions",
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_ENDPOINT_BASE: "https://generativelanguage.googleapis.com/v1beta/models",
  MAX_CARDS_PER_SET: 100,       // cap on AI-generated cards only (controls API cost)
  MIN_CARDS_PER_SET: 8,
  STUDY_BATCH_SIZE: 100,        // how many cards are served per study round
  CHUNK_TARGET_CHARS: 3500,     // approx characters per generation chunk
  CARDS_PER_CHUNK_TARGET: 10,   // roughly how many cards to ask per chunk
  DB_NAME: "recall-db",
  DB_VERSION: 1,
};

/* ----------------------------------------------------------------
   STORAGE — IndexedDB wrapper
   Stores: decks (metadata), cards (per-deck), sessions (history)
   ---------------------------------------------------------------- */
const DB = (() => {
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("decks")) {
          db.createObjectStore("decks", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("cards")) {
          const store = db.createObjectStore("cards", { keyPath: "id" });
          store.createIndex("deckId", "deckId", { unique: false });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          const store = db.createObjectStore("sessions", { keyPath: "id" });
          store.createIndex("deckId", "deckId", { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function tx(storeNames, mode) {
    const db = await open();
    return db.transaction(storeNames, mode);
  }

  async function put(storeName, value) {
    const t = await tx([storeName], "readwrite");
    return new Promise((resolve, reject) => {
      const req = t.objectStore(storeName).put(value);
      req.onsuccess = () => resolve(value);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function putMany(storeName, values) {
    const t = await tx([storeName], "readwrite");
    return new Promise((resolve, reject) => {
      const store = t.objectStore(storeName);
      values.forEach((v) => store.put(v));
      t.oncomplete = () => resolve(values);
      t.onerror = (e) => reject(e.target.error);
    });
  }

  async function get(storeName, key) {
    const t = await tx([storeName], "readonly");
    return new Promise((resolve, reject) => {
      const req = t.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAll(storeName) {
    const t = await tx([storeName], "readonly");
    return new Promise((resolve, reject) => {
      const req = t.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAllByIndex(storeName, indexName, key) {
    const t = await tx([storeName], "readonly");
    return new Promise((resolve, reject) => {
      const idx = t.objectStore(storeName).index(indexName);
      const req = idx.getAll(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function del(storeName, key) {
    const t = await tx([storeName], "readwrite");
    return new Promise((resolve, reject) => {
      const req = t.objectStore(storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function delManyByIndex(storeName, indexName, key) {
    const items = await getAllByIndex(storeName, indexName, key);
    const t = await tx([storeName], "readwrite");
    return new Promise((resolve, reject) => {
      const store = t.objectStore(storeName);
      items.forEach((item) => store.delete(item.id));
      t.oncomplete = () => resolve();
      t.onerror = (e) => reject(e.target.error);
    });
  }

  async function clearAll() {
    const db = await open();
    const names = ["decks", "cards", "sessions"];
    const t = db.transaction(names, "readwrite");
    return new Promise((resolve, reject) => {
      names.forEach((n) => t.objectStore(n).clear());
      t.oncomplete = () => resolve();
      t.onerror = (e) => reject(e.target.error);
    });
  }

  return { put, putMany, get, getAll, getAllByIndex, del, delManyByIndex, clearAll };
})();

/* ----------------------------------------------------------------
   UTILITIES
   ---------------------------------------------------------------- */
function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

let toastTimer = null;
function showToast(msg, duration = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ----------------------------------------------------------------
   DOCUMENT PARSING — PDF (pdf.js) and plain text
   ---------------------------------------------------------------- */
if (window["pdfjsLib"]) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";
}

async function parsePdfFile(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(" ");
    fullText += pageText + "\n\n";
  }
  return fullText.trim();
}

async function parseTxtFile(file) {
  return await file.text();
}

async function parseUploadedFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") return await parsePdfFile(file);
  if (ext === "txt") return await parseTxtFile(file);
  throw new Error("Unsupported file type. Please upload a .pdf or .txt file.");
}

/* ----------------------------------------------------------------
   CHUNKING
   Splits long text into paragraph-respecting chunks so that:
   (a) generation calls stay within free-tier rate/size limits, and
   (b) the model can focus deeply on a smaller span instead of
       shallowly skimming an entire document in one shot, which is
       what actually gives us full, even coverage of the material.
   ---------------------------------------------------------------- */
function chunkText(text, targetChars = CONFIG.CHUNK_TARGET_CHARS) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > targetChars && current.length > 0) {
      chunks.push(current.trim());
      current = "";
    }
    // paragraph itself longer than target: hard-split it
    if (para.length > targetChars) {
      const sentences = para.split(/(?<=[.?!])\s+/);
      let sub = "";
      for (const s of sentences) {
        if (sub.length + s.length > targetChars && sub.length > 0) {
          chunks.push(sub.trim());
          sub = "";
        }
        sub += s + " ";
      }
      if (sub.trim()) current += sub;
    } else {
      current += para + "\n\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.length ? chunks : [text.trim()];
}

// Decide how many cards each chunk should target so total stays <= MAX_CARDS_PER_SET
function planCardsPerChunk(numChunks, totalChars) {
  const roughTotal = clamp(
    Math.round(totalChars / 180), // ~1 card per 180 chars of source, as a scaling heuristic
    CONFIG.MIN_CARDS_PER_SET,
    CONFIG.MAX_CARDS_PER_SET
  );
  const perChunk = Math.max(2, Math.round(roughTotal / numChunks));
  return { perChunk, roughTotal };
}

/* ----------------------------------------------------------------
   AI PROVIDERS — Groq & Gemini
   Both are called directly from the browser with a user-supplied
   key stored in localStorage. Provider-agnostic: generateChunkCards()
   is the single entry point the rest of the app calls.
   ---------------------------------------------------------------- */
const PROMPT_SYSTEM = `You are an expert exam writer creating advanced active-recall flashcards for a learner who wants deep mastery, not surface trivia. You write questions that test understanding, application, reasoning, and connections between ideas — the kind of questions a tough oral board examiner would ask, not a fill-in-the-blank quiz.

Rules:
- Cover the given text thoroughly and evenly; do not skip sections or minor-but-testable details.
- Every question must be answerable from the given text.
- Prefer "why", "how", "compare", "what would happen if", "what is the mechanism/reasoning behind" framings over simple "what is X" framings, wherever the material supports it.
- Answers should be complete but concise (1-4 sentences), self-contained, and correct.
- Return ONLY valid JSON, no markdown fences, no commentary, matching exactly this schema:
{"cards":[{"q":"question text","a":"answer text"}]}`;

function buildUserPrompt(chunkText, targetCount) {
  return `Generate exactly ${targetCount} advanced active-recall flashcards from the following material. Return ONLY the JSON object described in the system prompt, nothing else.\n\n---\n${chunkText}\n---`;
}

function extractJsonObject(raw) {
  // Strip markdown fences if the model added them despite instructions
  let cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  // Find first { ... last } as a safety net against stray leading/trailing text
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response.");
  cleaned = cleaned.slice(start, end + 1);
  return JSON.parse(cleaned);
}

async function callGroq(apiKey, chunkText, targetCount) {
  const res = await fetch(CONFIG.GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.GROQ_MODEL,
      messages: [
        { role: "system", content: PROMPT_SYSTEM },
        { role: "user", content: buildUserPrompt(chunkText, targetCount) },
      ],
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq API error (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Groq returned an empty response.");
  return extractJsonObject(raw);
}

async function callGemini(apiKey, chunkText, targetCount) {
  const url = `${CONFIG.GEMINI_ENDPOINT_BASE}/${CONFIG.GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: PROMPT_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: buildUserPrompt(chunkText, targetCount) }] }],
      generationConfig: { temperature: 0.4 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API error (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  if (!raw) throw new Error("Gemini returned an empty response.");
  return extractJsonObject(raw);
}

async function generateChunkCards(provider, apiKey, chunkText, targetCount) {
  const result = provider === "gemini"
    ? await callGemini(apiKey, chunkText, targetCount)
    : await callGroq(apiKey, chunkText, targetCount);

  if (!result.cards || !Array.isArray(result.cards)) {
    throw new Error("Model response did not contain a valid cards array.");
  }
  return result.cards
    .filter((c) => c && c.q && c.a)
    .map((c) => ({ q: String(c.q).trim(), a: String(c.a).trim() }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Orchestrates chunked generation across the whole document.
 * onProgress(current, total, message) is called after each chunk.
 */
async function generateFullDeck({ text, provider, apiKey, onProgress }) {
  const chunks = chunkText(text);
  const { perChunk } = planCardsPerChunk(chunks.length, text.length);

  const allCards = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length, `Reading section ${i + 1} of ${chunks.length}…`);
    try {
      const cards = await generateChunkCards(provider, apiKey, chunks[i], perChunk);
      allCards.push(...cards);
    } catch (err) {
      // Don't let one chunk failure kill the whole set — surface it, keep going.
      console.error(`Chunk ${i + 1} failed:`, err);
      onProgress?.(i, chunks.length, `Section ${i + 1} failed (${err.message}) — continuing…`);
    }
    // Light pacing between calls to stay comfortably under free-tier RPM limits.
    if (i < chunks.length - 1) await sleep(900);
  }

  if (allCards.length === 0) {
    throw new Error("No flashcards could be generated. Check your API key and try again.");
  }

  return allCards.slice(0, CONFIG.MAX_CARDS_PER_SET);
}

/* ----------------------------------------------------------------
   MANUAL JSON IMPORT (fallback path — no API involved at all)
   Expected schema, produced by pasting PROMPT_TEMPLATE_FOR_EXPORT
   into Claude/Gemini chat and saving the reply as a .json file:
   { "title": "optional set title", "cards": [{"q": "...", "a": "..."}] }
   ---------------------------------------------------------------- */
const PROMPT_TEMPLATE_FOR_EXPORT = `You are an expert exam writer creating advanced active-recall flashcards for a learner who wants deep mastery, not surface trivia. Read the material I provide below in full and generate comprehensive flashcards covering it from start to finish — no sections or key details skipped.

Rules:
- Cover the entire text thoroughly and evenly, scaling the number of cards to the length of the material (up to 100 cards for very long material).
- Every question must be answerable from the given text.
- Prefer "why", "how", "compare", "what would happen if", "what is the mechanism/reasoning behind" framings over simple "what is X" framings, wherever the material supports it.
- Answers should be complete but concise (1-4 sentences), self-contained, and correct.
- Return ONLY a single valid JSON object, no markdown code fences, no commentary before or after, matching exactly this schema:

{"title":"a short descriptive title for this material","cards":[{"q":"question text","a":"answer text"}]}

Save your entire reply as a .json file and upload it to the Recall app's Import tab.

Here is the material:
---
[PASTE YOUR TEXT OR DOCUMENT CONTENT HERE]
---`;

function parseImportedJson(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error("That file isn't valid JSON. Make sure you saved the model's raw reply with nothing else in it.");
  }
  if (!parsed.cards || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    throw new Error('JSON must contain a non-empty "cards" array with {"q":..., "a":...} objects.');
  }
  const cards = parsed.cards
    .filter((c) => c && c.q && c.a)
    .map((c) => ({ q: String(c.q).trim(), a: String(c.a).trim() }));
  if (cards.length === 0) {
    throw new Error("No valid cards found — each card needs both a q and an a field.");
  }
  return {
    title: parsed.title ? String(parsed.title).trim() : null,
    cards,
  };
}

/* ----------------------------------------------------------------
   ANKI .APKG IMPORT
   An .apkg is a ZIP containing:
     - collection.anki2 (or .anki21) : a SQLite database
     - a JSON "media" file mapping numeric filenames -> real filenames
     - the numbered media files themselves
   Notes store all fields in one string separated by \x1f. Note types
   ("models") live as JSON inside the col table; model.type === 1 means
   cloze. One cloze note produces one card per cloze ordinal, which is
   why we expand them rather than emitting a single card.
   Everything here runs locally — no network, no API.
   ---------------------------------------------------------------- */
const ANKI_FIELD_SEP = "\x1f";

function decodeEntities(s) {
  const named = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
    "&quot;": '"', "&apos;": "'", "&mdash;": "—", "&ndash;": "–",
    "&hellip;": "…", "&laquo;": "«", "&raquo;": "»",
  };
  s = s.replace(/&#(\d+);/g, (m, d) => {
    try { return String.fromCodePoint(parseInt(d, 10)); } catch { return m; }
  });
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
    try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; }
  });
  s = s.replace(/&[a-zA-Z]+;/g, (m) => (named[m] !== undefined ? named[m] : m));
  return s;
}

/**
 * Converts Anki field HTML into display text.
 * Images are preserved as <img> when we have the media data, because a
 * stripped image often destroys the whole point of the card.
 */
function ankiFieldToDisplay(html, mediaMap) {
  if (!html) return "";
  let s = String(html);

  // Preserve images by swapping in data URLs from the package media
  s = s.replace(/<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, (full, src) => {
    const key = decodeURIComponent(src).trim();
    const dataUrl = mediaMap && mediaMap[key];
    return dataUrl ? `\u0000IMG:${dataUrl}\u0000` : " [image] ";
  });

  s = s.replace(/\[sound:[^\]]*\]/g, " [audio] ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function getClozeOrdinals(text) {
  const ords = new Set();
  const re = /\{\{c(\d+)::/g;
  let m;
  while ((m = re.exec(text)) !== null) ords.add(parseInt(m[1], 10));
  return [...ords].sort((a, b) => a - b);
}

/** Render one cloze card. Target ordinal becomes a blank; others reveal. */
function renderCloze(text, targetOrd, reveal) {
  return text.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (full, numStr, answer, hint) => {
    const num = parseInt(numStr, 10);
    if (num === targetOrd) {
      if (reveal) return `[${answer}]`;
      return hint ? `[${hint}]` : "[...]";
    }
    return answer;
  });
}

/** Decompress a zstd byte stream (used by newer Anki exports). */
function zstdDecompress(bytes) {
  if (typeof fzstd === "undefined" || !fzstd.decompress) {
    throw new Error("The decompressor didn't load. Check your connection and reload the app.");
  }
  return fzstd.decompress(bytes);
}

/**
 * Minimal protobuf reader for the newer `media` manifest.
 * The manifest is a repeated list of entries; each entry's field 1 is the
 * real filename. An entry's position in the list is the numeric filename
 * inside the archive (first entry -> "0", second -> "1", ...).
 * Only the two field types we need are handled; everything else is skipped.
 */
function parseMediaProtobuf(bytes) {
  const names = [];
  let i = 0;

  function readVarint(limit) {
    let result = 0, shift = 0;
    while (i < limit) {
      const b = bytes[i++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 56) break;
    }
    return result;
  }

  function skipField(wireType, limit) {
    if (wireType === 0) readVarint(limit);
    else if (wireType === 1) i += 8;
    else if (wireType === 2) { const len = readVarint(limit); i += len; }
    else if (wireType === 5) i += 4;
    else i = limit; // unknown wire type: stop
  }

  const decoder = new TextDecoder("utf-8");

  while (i < bytes.length) {
    const tag = readVarint(bytes.length);
    const field = tag >>> 3;
    const wireType = tag & 7;
    if (field === 1 && wireType === 2) {
      const len = readVarint(bytes.length);
      const end = i + len;
      let name = null;
      while (i < end) {
        const t2 = readVarint(end);
        const f2 = t2 >>> 3;
        const w2 = t2 & 7;
        if (f2 === 1 && w2 === 2) {
          const l2 = readVarint(end);
          name = decoder.decode(bytes.subarray(i, i + l2));
          i += l2;
        } else {
          skipField(w2, end);
        }
      }
      i = end;
      names.push(name);
    } else {
      skipField(wireType, bytes.length);
    }
  }
  return names;
}

/**
 * Builds { realFilename -> dataURL } for images.
 * Legacy packages use a JSON manifest with raw media files; newer packages
 * use a zstd-compressed protobuf manifest with zstd-compressed media files.
 */
async function buildMediaMap(zip, isModern) {
  const map = {};
  const mediaEntry = zip.file("media");
  if (!mediaEntry) return map;

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
  const MAX_INLINE = 120;
  let inlined = 0;

  /** Returns [archiveName, realName] pairs. */
  let pairs = [];
  try {
    if (isModern) {
      const raw = await mediaEntry.async("uint8array");
      let manifestBytes;
      try {
        manifestBytes = zstdDecompress(raw);
      } catch {
        manifestBytes = raw; // some builds leave the manifest uncompressed
      }
      const names = parseMediaProtobuf(manifestBytes);
      pairs = names.map((real, idx) => [String(idx), real]).filter(([, r]) => r);
    } else {
      const manifest = JSON.parse(await mediaEntry.async("string"));
      pairs = Object.entries(manifest);
    }
  } catch {
    return map;
  }

  for (const [archiveName, realName] of pairs) {
    if (inlined >= MAX_INLINE) break;
    if (!realName || !IMAGE_EXT.test(realName)) continue;
    const f = zip.file(archiveName);
    if (!f) continue;
    try {
      let bytes = await f.async("uint8array");
      if (isModern) {
        // Media files are individually zstd-compressed in newer packages,
        // but not always — fall back to the raw bytes if decompression fails.
        try {
          const magic = bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
          if (magic) bytes = zstdDecompress(bytes);
        } catch { /* keep raw bytes */ }
      }
      const ext = realName.split(".").pop().toLowerCase();
      const mime =
        ext === "svg" ? "image/svg+xml" :
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
        `image/${ext}`;
      map[realName] = `data:${mime};base64,${bytesToBase64(bytes)}`;
      inlined++;
    } catch {
      /* skip unreadable media */
    }
  }
  return map;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

let sqlJsPromise = null;
function loadSqlJs() {
  if (sqlJsPromise) return sqlJsPromise;
  if (typeof initSqlJs !== "function") {
    return Promise.reject(new Error("SQL engine failed to load. Check your connection and reload the app."));
  }
  sqlJsPromise = initSqlJs({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${file}`,
  });
  return sqlJsPromise;
}

function tableExists(db, name) {
  try {
    const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
    return r.length > 0 && r[0].values.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads note types from either schema.
 * Legacy: a JSON blob in col.models.
 * Modern: separate notetypes/fields tables, with cloze indicated by the
 * first bytes of the notetype config protobuf (field 1 varint == 1).
 * Returns { [id]: { name, isCloze, fieldNames[] } }
 */
function readNoteTypes(db) {
  const models = {};

  if (tableExists(db, "notetypes")) {
    const ntRes = db.exec("SELECT id, name, config FROM notetypes");
    if (ntRes.length) {
      for (const [id, name, config] of ntRes[0].values) {
        let isCloze = false;
        try {
          const cfg = config instanceof Uint8Array ? config : new Uint8Array(config || []);
          // protobuf field 1 (kind) varint == 1 means cloze; normal omits it
          if (cfg.length >= 2 && cfg[0] === 0x08 && cfg[1] === 0x01) isCloze = true;
        } catch { /* default to normal */ }
        models[String(id)] = { name: name || "", isCloze, fieldNames: [] };
      }
    }
    if (tableExists(db, "fields")) {
      const fRes = db.exec("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord");
      if (fRes.length) {
        for (const [ntid, ord, name] of fRes[0].values) {
          const m = models[String(ntid)];
          if (m) m.fieldNames[ord] = name;
        }
      }
    }
    return models;
  }

  // Legacy schema
  const colRes = db.exec("SELECT models FROM col LIMIT 1");
  if (!colRes.length || !colRes[0].values.length) return models;
  let parsed;
  try {
    parsed = JSON.parse(colRes[0].values[0][0] || "{}");
  } catch {
    return models;
  }
  for (const [id, m] of Object.entries(parsed)) {
    models[String(id)] = {
      name: m.name || "",
      isCloze: m.type === 1,
      fieldNames: Array.isArray(m.flds) ? m.flds.map((f) => f.name) : [],
    };
  }
  return models;
}

/** Reads a deck name from either schema. */
function readDeckName(db) {
  try {
    if (tableExists(db, "decks")) {
      const r = db.exec("SELECT name FROM decks");
      if (r.length) {
        const names = r[0].values
          .map((v) => v[0])
          .filter((n) => typeof n === "string" && n && n !== "Default");
        if (names.length) return names[0].replace(/\x1f/g, " :: ");
      }
    }
    const colRes = db.exec("SELECT decks FROM col LIMIT 1");
    if (colRes.length && colRes[0].values.length) {
      const decks = JSON.parse(colRes[0].values[0][0] || "{}");
      const names = Object.values(decks)
        .map((d) => d && d.name)
        .filter((n) => n && n !== "Default");
      if (names.length) return names[0].replace(/\x1f/g, " :: ");
    }
  } catch { /* deck name is optional */ }
  return null;
}

/**
 * Main entry point: File (.apkg) -> { deckName, cards: [{q,a}], stats }
 * Handles both the legacy uncompressed packages and the newer
 * zstd-compressed ones without the user needing to know the difference.
 */
async function parseApkgFile(file, onProgress) {
  if (typeof JSZip === "undefined") {
    throw new Error("ZIP reader failed to load. Check your connection and reload the app.");
  }

  onProgress?.("Unpacking package…");
  let zip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new Error("This file isn't a readable Anki package. Export it from Anki as .apkg and try again.");
  }

  // Newer packages ship a placeholder collection.anki2 containing only an
  // "update your Anki" note, so the compressed database must win the lookup.
  const MODERN_DB = "collection.anki21b";
  const dbName = [MODERN_DB, "collection.anki21", "collection.anki2"].find((n) => zip.file(n));
  if (!dbName) {
    throw new Error("No Anki collection found inside this file. Make sure it's a .apkg exported from Anki.");
  }
  const isModern = dbName === MODERN_DB;

  onProgress?.(isModern ? "Decompressing deck…" : "Reading deck database…");
  let dbBytes = await zip.file(dbName).async("uint8array");
  if (isModern) {
    try {
      dbBytes = zstdDecompress(dbBytes);
    } catch (e) {
      throw new Error("Couldn't decompress this deck. If it's very large, try exporting it from Anki in smaller pieces.");
    }
  }

  onProgress?.("Reading deck database…");
  const SQL = await loadSqlJs();
  let db;
  try {
    db = new SQL.Database(dbBytes);
  } catch {
    throw new Error("This deck's database couldn't be opened. Try re-exporting it from Anki.");
  }

  onProgress?.("Loading images…");
  let mediaMap = {};
  try {
    mediaMap = await buildMediaMap(zip, isModern);
  } catch { /* images are optional */ }

  let models, deckName;
  try {
    models = readNoteTypes(db);
    deckName = readDeckName(db);
  } catch {
    db.close();
    throw new Error("Couldn't read this deck's structure. Try re-exporting it from Anki.");
  }

  if (!models || Object.keys(models).length === 0) {
    db.close();
    throw new Error("This deck's note types couldn't be read. Try re-exporting it from Anki.");
  }

  // Which cloze ordinals actually exist per note
  const cardsByNote = {};
  try {
    const cardRes = db.exec("SELECT nid, ord FROM cards");
    if (cardRes.length) {
      for (const [nid, ord] of cardRes[0].values) {
        const key = String(nid);
        (cardsByNote[key] = cardsByNote[key] || []).push(ord);
      }
    }
  } catch { /* fall back to deriving ordinals from the text */ }

  onProgress?.("Converting cards…");
  let noteRes;
  try {
    noteRes = db.exec("SELECT id, mid, flds FROM notes");
  } catch {
    db.close();
    throw new Error("Couldn't read the notes in this deck. Try re-exporting it from Anki.");
  }
  db.close();

  if (!noteRes.length || !noteRes[0].values.length) {
    throw new Error("This deck contains no notes.");
  }

  const out = [];
  let basicCount = 0, clozeCount = 0, skipped = 0;

  for (const [id, mid, flds] of noteRes[0].values) {
    const model = models[String(mid)];
    const fields = String(flds == null ? "" : flds).split(ANKI_FIELD_SEP);

    // Treat as cloze if the note type says so, or if the text clearly is.
    const looksCloze = /\{\{c\d+::/.test(fields[0] || "");
    const isCloze = model ? (model.isCloze || looksCloze) : looksCloze;

    if (isCloze) {
      const clozeSource = fields[0] || "";
      const available = getClozeOrdinals(clozeSource);
      if (!available.length) { skipped++; continue; }

      const ords = cardsByNote[String(id)];
      const targets = (ords && ords.length)
        ? [...new Set(ords.map((o) => o + 1))].filter((n) => available.includes(n))
        : available;

      const extra = fields[1] ? ankiFieldToDisplay(fields[1], mediaMap) : "";

      for (const n of (targets.length ? targets : available)) {
        const q = ankiFieldToDisplay(renderCloze(clozeSource, n, false), mediaMap);
        let a = ankiFieldToDisplay(renderCloze(clozeSource, n, true), mediaMap);
        if (extra) a += `\n\n${extra}`;
        if (q && a) { out.push({ q, a }); clozeCount++; }
      }
    } else {
      const rendered = fields.map((f) => ankiFieldToDisplay(f, mediaMap));
      const nonEmpty = rendered.filter((f) => f && f.trim());
      if (nonEmpty.length >= 2) {
        const q = nonEmpty[0];
        const a = nonEmpty.slice(1).join("\n\n");
        if (q && a) { out.push({ q, a }); basicCount++; }
      } else {
        skipped++;
      }
    }
  }

  if (out.length === 0) {
    throw new Error("No usable cards found. This deck may use a card layout the app can't convert yet.");
  }

  return {
    deckName: deckName || file.name.replace(/\.(apkg|colpkg)$/i, ""),
    cards: out,
    stats: { basic: basicCount, cloze: clozeCount, skipped, images: Object.keys(mediaMap).length },
  };
}

/* ----------------------------------------------------------------
   SM-2 SPACED REPETITION SCHEDULER
   Per-card state: { ease, interval (days), reps, due (ISO), lapses }
   Rating buttons map to: again=0, hard=3, good=4, easy=5 (SM-2 quality)
   ---------------------------------------------------------------- */
const RATING_QUALITY = { again: 0, hard: 3, good: 4, easy: 5 };

function initialCardState() {
  return {
    ease: 2.5,
    interval: 0,      // days
    reps: 0,
    lapses: 0,
    due: nowISO(),
    lastReviewed: null,
  };
}

/**
 * Returns updated scheduling state for a card given a rating.
 * Also used (with a dry-run clone) to preview intervals on rating buttons.
 */
function scheduleCard(state, ratingKey) {
  const q = RATING_QUALITY[ratingKey];
  const s = { ...state };

  if (q < 3) {
    // "Again" — reset progress, resurface soon
    s.lapses += 1;
    s.reps = 0;
    s.interval = 0;
    s.ease = clamp(s.ease - 0.2, 1.3, 3.0);
    s.due = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min from now
  } else {
    s.ease = clamp(s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)), 1.3, 3.0);
    s.reps += 1;

    if (s.reps === 1) {
      s.interval = ratingKey === "hard" ? 1 : ratingKey === "easy" ? 3 : 1;
    } else if (s.reps === 2) {
      s.interval = ratingKey === "hard" ? 2 : ratingKey === "easy" ? 6 : 3;
    } else {
      let mult = s.ease;
      if (ratingKey === "hard") mult = 1.2;
      if (ratingKey === "easy") mult = s.ease * 1.3;
      s.interval = Math.max(1, Math.round(s.interval * mult));
    }
    const dueMs = Date.now() + s.interval * 24 * 60 * 60 * 1000;
    s.due = new Date(dueMs).toISOString();
  }

  s.lastReviewed = nowISO();
  return s;
}

function previewInterval(state, ratingKey) {
  const next = scheduleCard(state, ratingKey);
  if (ratingKey === "again") return "<10m";
  const days = next.interval;
  if (days < 1) return "<1d";
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/* ----------------------------------------------------------------
   DECK / DATA MODEL
   deck:    { id, title, source ('generated'|'imported'), provider,
              createdAt, cardCount }
   card:    { id, deckId, q, a, ...SM-2 state }
   session: { id, deckId, date, total, again, hard, good, easy,
              accuracy (good+easy / total) }
   ---------------------------------------------------------------- */
async function createDeckFromCards(title, cardPairs, sourceMeta) {
  const deckId = uid("deck");
  const deck = {
    id: deckId,
    title: title || "Untitled Set",
    source: sourceMeta.source,       // 'generated' | 'imported'
    provider: sourceMeta.provider || null,
    createdAt: nowISO(),
    cardCount: cardPairs.length,
  };
  const cards = cardPairs.map((c) => ({
    id: uid("card"),
    deckId,
    q: c.q,
    a: c.a,
    ...initialCardState(),
  }));

  await DB.put("decks", deck);
  await DB.putMany("cards", cards);
  return deck;
}

async function getAllDecks() {
  const decks = await DB.getAll("decks");
  return decks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getDeckCards(deckId) {
  return DB.getAllByIndex("cards", "deckId", deckId);
}

async function getDeckSessions(deckId) {
  const sessions = await DB.getAllByIndex("sessions", "deckId", deckId);
  return sessions.sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function deleteDeck(deckId) {
  await DB.del("decks", deckId);
  await DB.delManyByIndex("cards", "deckId", deckId);
  await DB.delManyByIndex("sessions", "deckId", deckId);
}

async function recordSession(deckId, tally) {
  const total = tally.again + tally.hard + tally.good + tally.easy;
  const accuracy = total ? Math.round(((tally.good + tally.easy) / total) * 100) : 0;
  const session = {
    id: uid("sess"),
    deckId,
    date: nowISO(),
    total,
    ...tally,
    accuracy,
  };
  await DB.put("sessions", session);
  return session;
}

function computeMastery(cards) {
  if (!cards.length) return 0;
  // Mastery = share of cards with at least 2 successful reps and ease >= 2.3
  const mastered = cards.filter((c) => c.reps >= 2 && c.ease >= 2.3).length;
  return Math.round((mastered / cards.length) * 100);
}

function dueCards(cards) {
  const now = Date.now();
  return cards.filter((c) => new Date(c.due).getTime() <= now);
}

/* ================================================================
   UI CONTROLLER
   ================================================================ */
const state = {
  currentView: "library",
  studySession: null, // { deckId, cards: [...], index, tally, deckTitle }
  currentDetailDeckId: null,
};

function switchView(viewName) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${viewName}`).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === viewName);
  });
  state.currentView = viewName;
  window.scrollTo(0, 0);
}

/* ---------------- LIBRARY ---------------- */
async function renderLibrary() {
  const decks = await getAllDecks();
  const grid = document.getElementById("library-grid");
  const empty = document.getElementById("library-empty");

  if (decks.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const tiles = await Promise.all(decks.map(async (deck) => {
    const cards = await getDeckCards(deck.id);
    const mastery = computeMastery(cards);
    const due = dueCards(cards).length;
    const ringColor = mastery >= 70 ? "var(--sage-dim)" : mastery >= 35 ? "var(--amber-dim)" : "var(--rust-dim)";
    const sourceLabel =
      deck.source === "anki" ? "Anki deck" :
      deck.source === "imported" ? "Imported" :
      `Generated · ${deck.provider || ""}`;

    return `
      <div class="deck-tile" data-deck-id="${deck.id}">
        <div class="deck-tile-title">${escapeHtml(deck.title)}</div>
        <span class="source-badge">${escapeHtml(sourceLabel)}</span>
        <div class="deck-tile-meta">
          <span>${cards.length} cards${due ? ` · ${due} due` : ""}</span>
          <div class="mastery-ring" style="background:${ringColor}; color:#fff;">${mastery}%</div>
        </div>
      </div>`;
  }));

  grid.innerHTML = tiles.join("");
  grid.querySelectorAll(".deck-tile").forEach((tile) => {
    tile.addEventListener("click", () => openDeckDetail(tile.dataset.deckId));
  });
}

/* ---------------- CREATE / GENERATE ---------------- */
function initCreateView() {
  // Tabs
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.tab).classList.add("active");
    });
  });

  // Source toggle (text vs file)
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const isText = btn.dataset.source === "text";
      document.getElementById("source-text").classList.toggle("hidden", !isText);
      document.getElementById("source-file").classList.toggle("hidden", isText);
    });
  });

  // Char counter
  const textarea = document.getElementById("source-textarea");
  textarea.addEventListener("input", () => {
    document.getElementById("text-count").textContent = `${textarea.value.length.toLocaleString()} characters`;
  });

  // File dropzone
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  let parsedFileText = "";

  dropzone.addEventListener("click", () => fileInput.click());
  ["dragover", "dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.toggle("drag-over", evt === "dragover");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelected(file);
  });

  async function handleFileSelected(file) {
    const statusEl = document.getElementById("file-status");
    statusEl.textContent = "Parsing…";
    try {
      parsedFileText = await parseUploadedFile(file);
      statusEl.textContent = `✓ Parsed "${file.name}" — ${parsedFileText.length.toLocaleString()} characters extracted.`;
      dropzone.dataset.hasFile = "true";
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      parsedFileText = "";
    }
  }

  // Generate button
  document.getElementById("generate-btn").addEventListener("click", async () => {
    const title = document.getElementById("set-title").value.trim();
    const provider = document.getElementById("provider-select").value;
    const isTextMode = document.querySelector('.toggle-btn[data-source="text"]').classList.contains("active");
    const sourceText = isTextMode ? textarea.value.trim() : parsedFileText.trim();

    if (!sourceText || sourceText.length < 50) {
      showToast("Add more material first — at least a few sentences.");
      return;
    }

    const apiKey = getStoredKey(provider);
    if (!apiKey) {
      showToast(`Add your ${provider === "gemini" ? "Gemini" : "Groq"} API key in Settings first.`);
      switchView("settings");
      return;
    }

    const btn = document.getElementById("generate-btn");
    const progressBlock = document.getElementById("generate-progress");
    const progressFill = document.getElementById("progress-fill");
    const progressText = document.getElementById("progress-text");

    btn.disabled = true;
    progressBlock.classList.remove("hidden");
    progressFill.style.width = "4%";
    progressText.textContent = "Starting…";

    try {
      const cards = await generateFullDeck({
        text: sourceText,
        provider,
        apiKey,
        onProgress: (i, total, msg) => {
          progressFill.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
          progressText.textContent = msg;
        },
      });

      const deck = await createDeckFromCards(
        title || `Set from ${isTextMode ? "pasted text" : "uploaded file"}`,
        cards,
        { source: "generated", provider }
      );

      showToast(`Created "${deck.title}" with ${cards.length} cards.`);
      resetCreateForm();
      switchView("library");
      await renderLibrary();
    } catch (err) {
      console.error(err);
      showToast(`Generation failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      progressBlock.classList.add("hidden");
    }
  });

  function resetCreateForm() {
    document.getElementById("set-title").value = "";
    textarea.value = "";
    document.getElementById("text-count").textContent = "0 characters";
    parsedFileText = "";
    document.getElementById("file-status").textContent = "";
    fileInput.value = "";
  }

  // --- Import JSON tab ---
  document.getElementById("copy-template-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(PROMPT_TEMPLATE_FOR_EXPORT);
      showToast("Prompt template copied. Paste it into Claude or Gemini.");
    } catch {
      showToast("Couldn't copy automatically — select and copy the template manually.");
    }
  });

  const jsonDropzone = document.getElementById("json-dropzone");
  const jsonFileInput = document.getElementById("json-file-input");
  jsonDropzone.addEventListener("click", () => jsonFileInput.click());
  jsonFileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById("json-status");
    statusEl.textContent = "Reading…";
    try {
      const raw = await file.text();
      const { title, cards } = parseImportedJson(raw);
      const deck = await createDeckFromCards(
        title || file.name.replace(/\.json$/i, ""),
        cards,
        { source: "imported" }
      );
      statusEl.textContent = `✓ Imported ${cards.length} cards.`;
      showToast(`Created "${deck.title}" with ${cards.length} cards.`);
      jsonFileInput.value = "";
      switchView("library");
      await renderLibrary();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  });

  // --- Anki .apkg tab ---
  const apkgDropzone = document.getElementById("apkg-dropzone");
  const apkgInput = document.getElementById("apkg-file-input");
  const apkgStatus = document.getElementById("apkg-status");
  const apkgPreview = document.getElementById("apkg-preview");
  let pendingApkg = null;

  apkgDropzone.addEventListener("click", () => apkgInput.click());
  ["dragover", "dragleave", "drop"].forEach((evt) => {
    apkgDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      apkgDropzone.classList.toggle("drag-over", evt === "dragover");
    });
  });
  apkgDropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) handleApkg(f);
  });
  apkgInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) handleApkg(f);
  });

  async function handleApkg(file) {
    apkgPreview.classList.add("hidden");
    pendingApkg = null;
    apkgStatus.textContent = "Starting…";
    try {
      const result = await parseApkgFile(file, (msg) => {
        apkgStatus.textContent = msg;
      });
      pendingApkg = result;

      const { basic, cloze, skipped, images } = result.stats;
      const bits = [];
      if (basic) bits.push(`${basic} basic`);
      if (cloze) bits.push(`${cloze} cloze`);
      if (images) bits.push(`${images} images`);
      const rounds = Math.ceil(result.cards.length / CONFIG.STUDY_BATCH_SIZE);

      document.getElementById("apkg-summary").innerHTML = `
        <div class="apkg-count">${result.cards.length} cards found</div>
        <div class="hint">${bits.join(" · ")}${skipped ? ` · ${skipped} notes skipped` : ""}</div>
        ${rounds > 1 ? `<div class="hint">You'll study these in ${rounds} rounds of up to ${CONFIG.STUDY_BATCH_SIZE}.</div>` : ""}
      `;
      document.getElementById("apkg-title").value = result.deckName;
      apkgStatus.textContent = "";
      apkgPreview.classList.remove("hidden");
    } catch (err) {
      console.error(err);
      apkgStatus.textContent = `Error: ${err.message}`;
      apkgInput.value = "";
    }
  }

  document.getElementById("apkg-import-btn").addEventListener("click", async () => {
    if (!pendingApkg) return;
    const title = document.getElementById("apkg-title").value.trim() || pendingApkg.deckName;
    const cards = pendingApkg.cards;
    const btn = document.getElementById("apkg-import-btn");
    btn.disabled = true;
    btn.querySelector("span") ? null : null;
    const originalLabel = btn.textContent;
    btn.textContent = `Adding ${cards.length} cards…`;
    try {
      const deck = await createDeckFromCards(title, cards, { source: "anki" });
      showToast(`Imported "${deck.title}" — ${cards.length} cards.`);
      pendingApkg = null;
      apkgPreview.classList.add("hidden");
      apkgInput.value = "";
      switchView("library");
      await renderLibrary();
    } catch (err) {
      console.error(err);
      showToast(`Import failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

/* ---------------- SETTINGS ---------------- */
function getStoredKey(provider) {
  return localStorage.getItem(`recall_key_${provider}`) || "";
}
function setStoredKey(provider, key) {
  if (key) localStorage.setItem(`recall_key_${provider}`, key);
  else localStorage.removeItem(`recall_key_${provider}`);
}

function initSettingsView() {
  document.getElementById("groq-key").value = getStoredKey("groq");
  document.getElementById("gemini-key").value = getStoredKey("gemini");

  document.getElementById("save-keys-btn").addEventListener("click", () => {
    setStoredKey("groq", document.getElementById("groq-key").value.trim());
    setStoredKey("gemini", document.getElementById("gemini-key").value.trim());
    document.getElementById("save-keys-status").textContent = "Saved.";
    showToast("API keys saved to this browser.");
    setTimeout(() => { document.getElementById("save-keys-status").textContent = ""; }, 2000);
  });

  document.getElementById("clear-data-btn").addEventListener("click", async () => {
    if (!confirm("This deletes every set, card, and review history in this browser. This can't be undone. Continue?")) return;
    await DB.clearAll();
    showToast("All data cleared.");
    switchView("library");
    await renderLibrary();
  });
}

/* ---------------- STUDY SESSION ----------------
   Long decks are served in rounds of STUDY_BATCH_SIZE rather than as one
   endless queue: you finish a round, see how it went, then continue to the
   next round until the whole deck has been covered.
   ---------------------------------------------- */
async function startStudySession(deckId) {
  const deck = await DB.get("decks", deckId);
  const allCards = await getDeckCards(deckId);
  if (allCards.length === 0) {
    showToast("This set has no cards.");
    return;
  }
  // Study what's due; if nothing is scheduled yet, study the whole deck.
  let queue = dueCards(allCards);
  if (queue.length === 0) queue = allCards.slice();

  // Shuffle once, then walk through it in fixed rounds.
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  state.studySession = {
    deckId,
    deckTitle: deck.title,
    fullQueue: queue,
    batchStart: 0,
    cards: [],
    index: 0,
    tally: { again: 0, hard: 0, good: 0, easy: 0 },
    totalReviewed: 0,
  };

  loadNextBatch();
  switchView("study");
  renderStudyCard();
}

function loadNextBatch() {
  const s = state.studySession;
  s.cards = s.fullQueue.slice(s.batchStart, s.batchStart + CONFIG.STUDY_BATCH_SIZE);
  s.index = 0;
  s.tally = { again: 0, hard: 0, good: 0, easy: 0 };
}

function currentRoundInfo() {
  const s = state.studySession;
  const round = Math.floor(s.batchStart / CONFIG.STUDY_BATCH_SIZE) + 1;
  const totalRounds = Math.ceil(s.fullQueue.length / CONFIG.STUDY_BATCH_SIZE);
  return { round, totalRounds };
}

/**
 * Renders card text into an element. Text is inserted as text nodes (never
 * innerHTML) so imported deck content can't inject markup; images carried
 * over from Anki are rebuilt as real <img> elements from their data URLs.
 */
function renderCardText(el, text) {
  el.innerHTML = "";
  const parts = String(text || "").split(/\u0000IMG:([^\u0000]+)\u0000/);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const img = document.createElement("img");
      img.src = part;
      img.className = "card-image";
      img.alt = "";
      el.appendChild(img);
    } else {
      part.split("\n").forEach((line, j, arr) => {
        el.appendChild(document.createTextNode(line));
        if (j < arr.length - 1) el.appendChild(document.createElement("br"));
      });
    }
  });
}

function renderStudyCard() {
  const s = state.studySession;
  const card = s.cards[s.index];
  const flipEl = document.getElementById("flip-card");
  flipEl.classList.remove("flipped");
  document.getElementById("rate-row").classList.add("hidden");

  renderCardText(document.getElementById("card-question"), card.q);
  renderCardText(document.getElementById("card-answer"), card.a);

  const { round, totalRounds } = currentRoundInfo();
  document.getElementById("study-set-title").textContent =
    totalRounds > 1 ? `${s.deckTitle} — round ${round} of ${totalRounds}` : s.deckTitle;
  document.getElementById("study-count").textContent = `${s.index + 1} / ${s.cards.length}`;
  document.getElementById("study-progress-fill").style.width = `${Math.round((s.index / s.cards.length) * 100)}%`;

  ["again", "hard", "good", "easy"].forEach((key) => {
    document.getElementById(`${key}-interval`).textContent = previewInterval(card, key);
  });
}

function initStudyView() {
  document.getElementById("flip-card").addEventListener("click", () => {
    const flipEl = document.getElementById("flip-card");
    const wasFlipped = flipEl.classList.contains("flipped");
    if (!wasFlipped) {
      flipEl.classList.add("flipped");
      document.getElementById("rate-row").classList.remove("hidden");
    }
  });

  document.querySelectorAll(".rate-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const s = state.studySession;
      const card = s.cards[s.index];
      const rating = btn.dataset.rating;

      const updated = scheduleCard(card, rating);
      Object.assign(card, updated);
      await DB.put("cards", card);
      s.tally[rating] += 1;

      s.index += 1;
      if (s.index >= s.cards.length) {
        await finishStudySession();
      } else {
        renderStudyCard();
      }
    });
  });

  document.getElementById("study-exit").addEventListener("click", async () => {
    if (state.studySession && state.studySession.index > 0) {
      if (!confirm("End this session early? Progress so far will be saved.")) return;
      await finishStudySession(true);
    } else {
      switchView("library");
      await renderLibrary();
    }
  });
}

async function finishStudySession(early = false) {
  const s = state.studySession;
  document.getElementById("study-progress-fill").style.width = "100%";
  const session = await recordSession(s.deckId, s.tally);
  s.totalReviewed += session.total;

  const { round, totalRounds } = currentRoundInfo();
  const nextStart = s.batchStart + CONFIG.STUDY_BATCH_SIZE;
  const remaining = early ? 0 : Math.max(0, s.fullQueue.length - nextStart);
  const hasMore = !early && remaining > 0;

  document.getElementById("summary-title").textContent =
    hasMore ? `Round ${round} complete` : "Session complete";

  document.getElementById("summary-stats").innerHTML = `
    <div class="stat-block"><div class="stat-value">${session.total}</div><div class="stat-label">Reviewed</div></div>
    <div class="stat-block"><div class="stat-value">${session.accuracy}%</div><div class="stat-label">Accuracy</div></div>
    <div class="stat-block"><div class="stat-value">${s.tally.again}</div><div class="stat-label">Again</div></div>
  `;

  const continueBtn = document.getElementById("summary-continue-btn");
  const noteEl = document.getElementById("summary-note");
  const doneBtn = document.getElementById("summary-done-btn");

  if (hasMore) {
    const nextCount = Math.min(CONFIG.STUDY_BATCH_SIZE, remaining);
    continueBtn.textContent = `Continue — next ${nextCount} cards`;
    continueBtn.classList.remove("hidden");
    noteEl.textContent = `${remaining} cards left in this deck · round ${round} of ${totalRounds} done`;
    noteEl.classList.remove("hidden");
    doneBtn.textContent = "Stop for now";
  } else {
    continueBtn.classList.add("hidden");
    doneBtn.textContent = "Back to library";
    if (!early && totalRounds > 1) {
      noteEl.textContent = `Whole deck covered — ${s.totalReviewed} cards across ${totalRounds} rounds.`;
      noteEl.classList.remove("hidden");
    } else {
      noteEl.classList.add("hidden");
    }
  }

  switchView("summary");
}

function initSummaryView() {
  document.getElementById("summary-done-btn").addEventListener("click", async () => {
    state.studySession = null;
    switchView("library");
    await renderLibrary();
  });

  document.getElementById("summary-continue-btn").addEventListener("click", () => {
    const s = state.studySession;
    if (!s) return;
    s.batchStart += CONFIG.STUDY_BATCH_SIZE;
    loadNextBatch();
    if (s.cards.length === 0) {
      switchView("library");
      renderLibrary();
      return;
    }
    switchView("study");
    renderStudyCard();
  });
}

/* ---------------- DECK DETAIL ---------------- */
async function openDeckDetail(deckId) {
  state.currentDetailDeckId = deckId;
  const deck = await DB.get("decks", deckId);
  const cards = await getDeckCards(deckId);
  const sessions = await getDeckSessions(deckId);

  document.getElementById("detail-title").textContent = deck.title;
  document.getElementById("detail-meta").textContent =
    `${cards.length} cards · created ${formatDate(deck.createdAt)} · ${
      deck.source === "anki" ? "from Anki deck" :
      deck.source === "imported" ? "imported" :
      `generated via ${deck.provider}`
    }`;

  const mastery = computeMastery(cards);
  const due = dueCards(cards).length;
  const lastAccuracy = sessions.length ? sessions[sessions.length - 1].accuracy : null;
  const pendingQueue = due > 0 ? due : cards.length;
  const rounds = Math.ceil(pendingQueue / CONFIG.STUDY_BATCH_SIZE);

  document.getElementById("detail-stats").innerHTML = `
    <div class="stat-block"><div class="stat-value">${mastery}%</div><div class="stat-label">Mastery</div></div>
    <div class="stat-block"><div class="stat-value">${due}</div><div class="stat-label">Due now</div></div>
    <div class="stat-block"><div class="stat-value">${lastAccuracy !== null ? lastAccuracy + "%" : "—"}</div><div class="stat-label">Last score</div></div>
  `;

  const studyBtn = document.getElementById("detail-study-btn");
  studyBtn.textContent = rounds > 1
    ? `Study now — ${CONFIG.STUDY_BATCH_SIZE} of ${pendingQueue} cards`
    : "Study now";

  drawTrendChart(sessions);
  switchView("detail");
}

function drawTrendChart(sessions) {
  const canvas = document.getElementById("trend-canvas");
  const ctx = canvas.getContext("2d");
  // Read live theme colors so the chart matches whichever theme is active.
  const cs = getComputedStyle(document.documentElement);
  const accent = (cs.getPropertyValue("--accent-text") || "#e8a04c").trim() || "#e8a04c";
  const gridColor = (cs.getPropertyValue("--navy-700") || "#2d3549").trim() || "#2d3549";
  const mutedColor = (cs.getPropertyValue("--text-low") || "#8b91a3").trim() || "#8b91a3";
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 300;
  const cssHeight = 140;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const pad = 24;
  if (sessions.length === 0) {
    ctx.fillStyle = mutedColor;
    ctx.font = "13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No sessions yet — study this set to see trends.", cssWidth / 2, cssHeight / 2);
    return;
  }

  const points = sessions.slice(-20); // last 20 sessions
  const w = cssWidth - pad * 2;
  const h = cssHeight - pad * 2;

  // gridlines
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  [0, 50, 100].forEach((val) => {
    const y = pad + h - (val / 100) * h;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(cssWidth - pad, y);
    ctx.stroke();
  });

  // line
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((s, i) => {
    const x = points.length === 1 ? pad + w / 2 : pad + (i / (points.length - 1)) * w;
    const y = pad + h - (s.accuracy / 100) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // points
  ctx.fillStyle = accent;
  points.forEach((s, i) => {
    const x = points.length === 1 ? pad + w / 2 : pad + (i / (points.length - 1)) * w;
    const y = pad + h - (s.accuracy / 100) * h;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function initDetailView() {
  document.getElementById("detail-back").addEventListener("click", async () => {
    switchView("library");
    await renderLibrary();
  });

  document.getElementById("detail-study-btn").addEventListener("click", () => {
    startStudySession(state.currentDetailDeckId);
  });

  document.getElementById("detail-delete-btn").addEventListener("click", async () => {
    const deck = await DB.get("decks", state.currentDetailDeckId);
    if (!confirm(`Delete "${deck.title}" and all its review history? This can't be undone.`)) return;
    await deleteDeck(state.currentDetailDeckId);
    showToast("Set deleted.");
    switchView("library");
    await renderLibrary();
  });
}

/* ---------------- NAV WIRING ---------------- */
function initNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      switchView(btn.dataset.view);
      if (btn.dataset.view === "library") await renderLibrary();
    });
  });
  document.getElementById("empty-cta").addEventListener("click", () => switchView("create"));
}

/* ---------------- THEME ---------------- */
const THEME_KEY = "recall_theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#edeae2" : "#1a1f2e");
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage may be blocked */ }

  if (saved !== "light" && saved !== "dark") {
    // No stored choice yet: follow the device setting.
    const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
    saved = prefersLight ? "light" : "dark";
  }
  applyTheme(saved);

  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      const next = current === "light" ? "dark" : "light";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    });
  }
}

/* ---------------- SERVICE WORKER ---------------- */
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }
}

/* ---------------- INIT ---------------- */
document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initNav();
  initCreateView();
  initSettingsView();
  initStudyView();
  initSummaryView();
  initDetailView();
  registerServiceWorker();
  await renderLibrary();
});
