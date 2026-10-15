# Dual-Password Dynamic Dashboard Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a single unified login portal where entering the Main Password directs the user to the Main Dashboard (`/`), while entering the Stealth Password automatically routes the user directly to the Stealth Dashboard (`/c-ctrl-9842`), with secure role-based session isolation and logout capabilities.

**Architecture:** Node.js/Express server implements an authentication module (`auth.ts`) managing cryptographic session cookies (`auth_session`). An unauthenticated user visiting any protected route is redirected to a sleek, dark-themed login portal (`login.html`). When submitted, the backend verifies the password: if matching `MAIN_PASSWORD`, a session token with role `main` is issued and the response instructs redirection to `/`; if matching `STEALTH_PASSWORD`, a session token with role `stealth` is issued and the response instructs redirection to `STEALTH_ROUTE`. Middleware enforces that `main` sessions cannot access or discover the stealth route (returning 404).

**Tech Stack:** Node.js, Express, TypeScript, Crypto (HMAC session signatures), HTML5/CSS3 (Glassmorphism design matching existing dark theme), Vanilla JavaScript.

**Spec:** Dual-Password Gateway and Role-Based Route Dispatcher.

---

## Global Constraints

- **Single Entry Point:** A single login screen accepts the password; users do not need to choose their destination dashboard upfront.
- **Strict Role Isolation:** A session authenticated with the `main` password must NOT be able to access the stealth dashboard or stealth API endpoints (must return 404 Not Found to prevent detection).
- **Stealth Route Preservation:** The stealth route path remains dynamically configurable via `STEALTH_ROUTE` env var (default `/c-ctrl-9842`).
- **Android App & Stream Uninterrupted:** Ingest routes (`/api/v1/broadcasts`), storage (`/storage/*`), health checks (`/api/v1/health`), and WebSockets (`/ws`) must remain accessible without session cookies.
- **Backward Compatibility:** HTTP Basic Auth fallback must remain supported for API scripts and curl commands.
- **Design Excellence:** The login page must follow the application's sleek dark aesthetic (`#090912`, `#12121e`, glassmorphism, glowing accents, Outfit/Inter typography).

---

## Review Focus

1. **Main Password Routing:** Entering `MAIN_PASSWORD` sets a `main` role cookie and redirects to `/` (Main Recording Archive).
2. **Stealth Password Routing:** Entering `STEALTH_PASSWORD` sets a `stealth` role cookie and redirects directly to `STEALTH_ROUTE` (Stealth Monitor Hub).
3. **Covert Protection:** If a user with a `main` session navigates directly to `STEALTH_ROUTE`, the server responds with 404 Not Found rather than 401 or redirecting, concealing the route's existence.
4. **Logout Functionality:** Clicking "Logout" on either dashboard invalidates the session cookie and cleanly returns the user to `/login`.
5. **Session Expiry & Invalid Attempts:** Invalid passwords return a 401 with smooth error animation; expired/tampered cookies gracefully redirect back to `/login`.

---

## File Structure

- **Create:** `server/src/auth.ts` — Authentication utilities, HMAC session token signer/verifier, role definitions, and Express auth handlers.
- **Modify:** `server/src/config.ts` — Define `MAIN_PASSWORD`, `STEALTH_PASSWORD`, `AUTH_SECRET`, and default credentials.
- **Modify:** `server/src/index.ts` — Integrate session parsing middleware, replace basicAuth with dual session/basic auth middleware, mount `/login` and `/api/v1/auth/*` routes, restrict `STEALTH_ROUTE` to `stealth` role.
- **Create:** `server/public/login.html` — High-tech glassmorphism login interface with responsive password input, error states, and automatic redirection.
- **Modify:** `server/public/index.html` — Add a sleek "Logout" button in the top header.
- **Modify:** `server/stealth/stealth.html` — Add a sleek "Logout" button in the top navigation.
- **Create:** `server/src/__tests__/auth.test.ts` (or manual test verification script `server/scripts/test-auth.ts`) — Automated validation of dual-password authentication, cookie verification, role permissions, and redirects.

---

### Task 1: Update Configuration & Implement Authentication Service (`config.ts` & `auth.ts`)

**Files:**
- Modify: `server/src/config.ts`
- Create: `server/src/auth.ts`

**Interfaces:**
- `createSessionToken(role: 'main' | 'stealth'): string`
- `verifySessionToken(token: string): { role: 'main' | 'stealth'; timestamp: number } | null`
- `parseCookies(cookieHeader: string | undefined): Record<string, string>`
- `authMiddleware(req, res, next): void`

- [x] **Step 1: Update `config.ts`**
  Export `MAIN_PASSWORD`, `STEALTH_PASSWORD`, `DASHBOARD_USERNAME`, and `AUTH_SECRET`.
  Defaults:
  - `MAIN_PASSWORD`: `process.env.MAIN_PASSWORD || process.env.DASHBOARD_PASSWORD || 'cvb#345'`
  - `STEALTH_PASSWORD`: `process.env.STEALTH_PASSWORD || 'stealth#9842'`
  - `DASHBOARD_USERNAME`: `process.env.DASHBOARD_USERNAME || 'admin@789'`
  - `AUTH_SECRET`: `process.env.AUTH_SECRET || 'audio-stream-auth-key-secret-9842'`

- [x] **Step 2: Implement `auth.ts`**
  Implement cryptographic HMAC-SHA256 session tokens:
  - Session payload: `${role}:${timestamp}:${hmac(secret, role + ':' + timestamp)}`
  - Validation: Verify signature and timestamp freshness (7 days validity).
  - Helper `parseCookies(header)` to read `auth_session` cookie without requiring external dependencies.
  - Export `handleLogin(req, res)`:
    - Check if `password === MAIN_PASSWORD`: return `{ success: true, role: 'main', redirect: '/' }` + Set-Cookie `auth_session`.
    - Check if `password === STEALTH_PASSWORD`: return `{ success: true, role: 'stealth', redirect: STEALTH_ROUTE }` + Set-Cookie `auth_session`.
    - Otherwise return 401 `{ success: false, error: 'Invalid password' }`.
  - Export `handleLogout(req, res)`:
    - Clear `auth_session` cookie, return `{ success: true, redirect: '/login' }`.
  - Export `handleSessionCheck(req, res)`:
    - Return current authentication status, role, and redirect route if valid.

- [x] **Step 3: Verify TypeScript compilation**
  Run `npm run build` in `server` to ensure clean compilation.

---

### Task 2: Create the Modern Glassmorphism Login Portal (`login.html`)

**Files:**
- Create: `server/public/login.html`

- [x] **Step 1: Design `login.html`**
  Build a standalone, stunning dark-mode login page:
  - Aesthetic: Dark backdrop `#090912`, radial glow, glassmorphic card with blur and subtle border.
  - Icons & Typography: Outfit and Inter fonts, glowing lock emblem.
  - Elements:
    - Single password input field with show/hide password toggle.
    - Submit button with smooth hover & ripple effects.
    - Status message container (error shaking animation, success green glow).
  - Client-side Script:
    - Submits via `fetch('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ password }) })`.
    - On success: updates UI to "Access Granted" and triggers `window.location.href = data.redirect`.
    - On error: highlights input in red, displays error message, and shakes the card.
    - Auto-focus password input on page load.
    - Support Enter key submission.

- [x] **Step 2: Verify page renders and styles properly**
  Ensure styles and scripts are self-contained or reference `style.css` without breaking.

---

### Task 3: Mount Routes & Role-Based Middleware in Server (`index.ts`)

**Files:**
- Modify: `server/src/index.ts`

- [x] **Step 1: Replace old `basicAuth` with unified auth middleware**
  - Allow public access to:
    - `/login`, `/login.html`, `/style.css`, favicon
    - `/api/v1/auth/login`, `/api/v1/auth/logout`, `/api/v1/auth/session`
    - `/api/v1/broadcasts*`, `/api/v1/health`, `/storage/*`, `/ws*`
  - For API calls:
    - Check `auth_session` cookie or Basic Auth header.
    - If valid, attach `req.userRole = role` and `next()`.
    - If invalid, return 401 JSON.
  - For browser page requests:
    - If no valid session: redirect to `/login`.
    - If user visits `/login` and is ALREADY authenticated: redirect to their respective dashboard (`/` or `STEALTH_ROUTE`).
    - If user visits `${STEALTH_ROUTE}`:
      - If `role !== 'stealth'`: return 404 Not Found (keeps stealth dashboard covert).
      - If `role === 'stealth'`: serve `stealth.html`.
    - If user visits `/` or `/dashboard`:
      - Accessible by both `main` and `stealth` roles.

- [x] **Step 2: Mount Auth API Endpoints**
  - `POST /api/v1/auth/login` -> `handleLogin`
  - `POST /api/v1/auth/logout` -> `handleLogout`
  - `GET /api/v1/auth/session` -> `handleSessionCheck`
  - `GET /login` -> serve `server/public/login.html`

- [x] **Step 3: Update `STEALTH_ROUTE` handler**
  Ensure `${STEALTH_ROUTE}` checks that `req.userRole === 'stealth'`.

---

### Task 4: Add Logout Buttons to Main and Stealth Dashboards

**Files:**
- Modify: `server/public/index.html`
- Modify: `server/public/app.js`
- Modify: `server/stealth/stealth.html`
- Modify: `server/stealth/stealth.js`

- [x] **Step 1: Add Logout button in `public/index.html` and wire in `app.js`**
  - Add `<button id="btn-logout" class="btn-logout">🔒 Logout</button>` in the top header.
  - In `app.js`, on click: send `POST /api/v1/auth/logout` and redirect to `/login`.

- [x] **Step 2: Add Logout button in `stealth.html` and wire in `stealth.js`**
  - Add `<button id="btn-logout" class="switch-btn switch-btn--logout">🔒 Logout</button>` in the header navigation.
  - In `stealth.js`, on click: send `POST /api/v1/auth/logout` and redirect to `/login`.

---

### Task 5: Automated Testing & End-to-End Verification

**Files:**
- Create: `server/scripts/test-auth.ts`

- [x] **Step 1: Write test script `test-auth.ts`**
  Create an automated verification script that tests:
  1. Login with invalid password -> returns 401.
  2. Login with `MAIN_PASSWORD` -> returns 200, role: `main`, redirect: `/`, sets valid cookie.
  3. Access `/` with `main` cookie -> returns 200.
  4. Access `${STEALTH_ROUTE}` with `main` cookie -> returns 404 (stealth isolation verified!).
  5. Login with `STEALTH_PASSWORD` -> returns 200, role: `stealth`, redirect: `${STEALTH_ROUTE}`, sets valid cookie.
  6. Access `${STEALTH_ROUTE}` with `stealth` cookie -> returns 200.
  7. Access `/` with `stealth` cookie -> returns 200.
  8. Logout -> clears cookie, redirects to `/login`.

- [x] **Step 2: Run test script and compile**
  Run `npx ts-node scripts/test-auth.ts` and confirm all 8 assertions pass.
  Run `npm run build` to confirm zero compilation errors.
