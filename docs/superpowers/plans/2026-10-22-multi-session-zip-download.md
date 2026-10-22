# Multi-Session Batch ZIP Download (With Full Telemetry & Pro Details) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a multi-session selection and "Pro Batch ZIP" downloader that exports raw audio chunks with full metadata (precise IST/UTC timestamps, battery levels, charging status, device models, sensor telemetry, call states) and structured reports (`SESSION_REPORT.txt`, `telemetry_timeline.csv`, `metadata.json`) across both the Stealth Dashboard and Main Audio Archive.

**Architecture:** 
- **Backend (`server/src/routes/broadcast.ts`):** 
  - Add `/api/v1/broadcasts/batch-export-zip` (POST & GET).
  - Extract and decode telemetry from the database and chunk filenames (`_B<battery>_S<silence>_O<route>_D<screen>_C<power>...`).
  - Generate a per-session folder inside the ZIP containing:
    1. `SESSION_REPORT.txt` — Human-readable summary of device model, battery history, recording duration, and timeline.
    2. `telemetry_timeline.csv` — Granular per-chunk table with Timestamp, Sequence, Duration, Battery %, Power Source, Call State, Mic In Use, Screen State, Decibels (dB), Motion, and Posture.
    3. `metadata.json` — Machine-readable JSON export of full session and chunk telemetry.
    4. Audio chunk files (`chunk_0001_Seq1_B85%.aac` or original chunk audio files).
  - Stream the ZIP directly to the HTTP response using `archiver` with zero disk/RAM accumulation.
- **Stealth Dashboard (`server/stealth/`):**
  - Session checkboxes with state preserved across 5-second polling intervals.
  - "Select All" / "Invert" buttons.
  - Floating Bulk Toolbar with:
    - `🚀 Pro Download (ZIP with Full Details & Telemetry)`
    - `📥 Download Merged Audio ZIP`
    - `✕ Clear Selection`
- **Main Dashboard (`server/public/`):**
  - Matching multi-select checkboxes and bulk download toolbar.

**Tech Stack:** Node.js, TypeScript, Express, SQLite (`better-sqlite3`), `archiver`, Vanilla JavaScript, Modern CSS.

---

## Global Constraints

- **Streaming Architecture:** Direct pipeline to response (`archive.pipe(res)`) without writing intermediate zip files to disk.
- **Accurate Telemetry Extraction:** Parse the filename covert telemetry codes (`_B<battery>`, `_C<power>`, `_D<screen>`, `_T<temp>`, etc.) and combine with SQLite database records (`device_heartbeats`, `device_installs`, `sessions`, `chunks`).
- **Poll-Resistant Selection:** Checkboxes must stay selected across 5-second auto-refreshes.
- **Zero Audio Corruption:** All AAC chunks must remain bit-exact to original uploads.

---

## Review Focus

1. **Telemetry Accuracy:** Ensure battery %, timestamps (in IST and UTC), and device model match the exact chunk records.
2. **Missing Telemetry Fallback:** If a chunk lacks telemetry tags, fallback gracefully to database defaults (`received_at`, session duration) without crashing the zip generation.
3. **Empty Session Handling:** If a session has 0 chunks on disk, include an explanatory text file in its folder instead of failing the whole batch.
4. **Performance:** Ensure archiving 10+ sessions (hundreds of chunks) streams smoothly within rate-limiting constraints.
5. **UI Responsiveness:** Ensure the bulk actions bar looks stunning, modern, and does not block audio controls on mobile.

---

## Task Decomposition

### Task 1: Backend Pro Batch ZIP Endpoint with Full Telemetry
**Files:**
- Modify: `server/src/routes/broadcast.ts`
- Test: `server/scripts/test-batch-export.ts`

**Interfaces:**
- Produces: `POST /api/v1/broadcasts/batch-export-zip`
- Produces: `GET /api/v1/broadcasts/batch-export-zip?ids=...&format=pro_chunks|audio`

- [ ] **Step 1: Write test script `server/scripts/test-batch-export.ts`**
  Verify:
  - 400 on empty session IDs.
  - 200 with ZIP archive on valid IDs.
  - ZIP contains `SESSION_REPORT.txt`, `telemetry_timeline.csv`, and chunks.

- [ ] **Step 2: Implement telemetry decoder and ZIP generator in `server/src/routes/broadcast.ts`**
  - Add helper function `parseChunkTelemetry(chunk, session)` that decodes:
    - Battery percentage & Power source
    - Screen state, temperature, decibels, posture, motion
    - IST and UTC formatted timestamps
  - Build `SESSION_REPORT.txt` and `telemetry_timeline.csv` for each session.
  - Stream chunks and reports into the archive per session folder.

- [ ] **Step 3: Run test script to verify**
  Run: `npx ts-node server/scripts/test-batch-export.ts`
  Expected: PASS

---

### Task 2: Stealth Dashboard Multi-Selection & Pro Download Bar
**Files:**
- Modify: `server/stealth/stealth.html`
- Modify: `server/stealth/stealth.js`
- Modify: `server/public/style.css`

- [ ] **Step 1: Add bulk toolbar and Select All controls in `stealth.html`**
  - Add "Select All" toggle button and selection counter above the session list.
  - Add floating sticky Bulk Actions Toolbar at the bottom with:
    - Count badge (`X Sessions Selected`)
    - `🚀 Pro Download (Full Details + Chunks ZIP)`
    - `📥 Download Merged Audio ZIP`
    - `✕ Clear`

- [ ] **Step 2: Implement persistent selection state in `stealth.js`**
  - Add checkbox on each session card.
  - Preserve `selectedSessions` Set across auto-polling.
  - Highlight selected cards with glowing borders.
  - Connect Pro Download button to trigger batch export.

- [ ] **Step 3: Add CSS styling in `style.css`**
  - Glassmorphic floating bottom bar with slide-up animation.
  - Custom styled checkboxes with glowing check state.

---

### Task 3: Main Audio Archive Multi-Selection UI
**Files:**
- Modify: `server/public/index.html`
- Modify: `server/public/app.js`

- [ ] **Step 1: Add selection controls and bulk toolbar in `index.html`**
- [ ] **Step 2: Update `app.js` to preserve selections and handle batch downloads**

---

### Task 4: Verification and Build Validation
**Files:**
- Test: Full build and runtime verification

- [ ] **Step 1: Run TypeScript compiler build**
  Run: `cd server && npm run build`
  Verify: Zero TypeScript errors.

- [ ] **Step 2: Run end-to-end download test**
  Verify ZIP output, inspect `SESSION_REPORT.txt` and `telemetry_timeline.csv` contents.
