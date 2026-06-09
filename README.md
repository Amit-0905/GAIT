<p align="center">
  <img src="./docs/logo.png" alt="Gait" width="120" />
</p>
<h1 align="center">GAIT v2</h1>
<p align="center">
  <b>Invisible proof-of-humanity for forms, APIs, and user actions.</b><br>
  Drop-in JS + Cloudflare Worker. No CAPTCHA. No tracking tokens. No friction.
</p>

<p align="center">
  <a href="#the-problem">The Problem</a> •
  <a href="#the-solution">The Solution</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#license">License</a>
</p>

[![License: Non-Commercial](https://img.shields.io/badge/License-Non--Commercial-red.svg?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare)](https://workers.cloudflare.com/)

---

## The Problem

Bots officially outnumber humans online. Headless browsers, LLM scrapers, and automated spam tools have made traditional bot protection useless:

- **CAPTCHAs?** AI vision models solve them at scale.
- **IP reputation?** Residential proxies rotate every request.
- **JavaScript challenges?** `puppeteer` and `playwright` execute them effortlessly.

Your signup forms, comment sections, and API endpoints are being hammered by automation that looks identical to a real user — except it isn't.

## The Solution

GAIT v2 is a **behavioral attestation layer** that lives at the edge (Cloudflare). It passively records the natural entropy of human interaction — mouse kinematics, scroll inertia, and keystroke cadence — and verifies it cryptographically before your server ever sees the request.

If the movement isn't **messy enough** to be human, the request is blocked. Period.

---

## What GAIT v2 Protects (Universal Attestation)

| Surface                  | Threat                                   | How GAIT Protects                                                   |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------- |
| **Forms**                | Bot signups, spam submissions            | Auto-hooks submit using `attachForms()`                             |
| **SPA Navigation**       | Scrapers after login                     | Intercept `fetch()`; append `X-Gait-Attestation` to POST/PUT/DELETE |
| **API Endpoints**        | Bots hammering `/api/vote`, `/api/claim` | Worker validates `X-Gait-Attestation` before origin                 |
| **Click Actions**        | Fake add-to-cart, automated upvotes      | `gait.attest()` before firing any XHR                               |
| **One-Click Buttons**    | "Apply", "Download", "Claim"             | Intercept click, append proof                                       |
| **WebSocket Handshakes** | Bot armies in games/editors              | Initial `new WebSocket(...)` carries `X-Gait-Attestation`           |

---

## Architecture

```
┌─────────────┐         ┌──────────────────────────┐
  │   Browser   │ ──────► │  GAIT Client SDK         │
  │             │         │  - Entropy recorder        │
  │             │         │  - Moving target           │
  │             │         │  - Focus trap              │
  │             │         │  - Web Worker hash proof   │
  └─────────────┘         └──────────────────────────┘
         │                           │
         │ 1. GET /gait-challenge    │
         ▼                           │
┌─────────────────┐                   │
│ Cloudflare Edge │ ── signed nonce  │
│  (HMAC-SHA256)  │                   │
└─────────────────┘                   │
         │                          │
         │ 2. POST /any-endpoint     │
         │    + X-Gait-Attestation   │
         │    + X-Gait-Challenge     │
         ▼                          ▼
┌────────────────────────────────────────────────┐
│  Worker Scoring Engine                           │
│  - Replay nonce cache (with lazy edge cleanup)   │
│  - Environment fingerprinting (webdriver, etc.)  │
│  - Kinematic entropy (speed CV, tortuosity)      │
│  - Moving target timing check                    │
│  - Focus trap recovery check                     │
│  - Accessibility bonus (keyboard/touch)          │
└────────────────────────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐  ┌────────┐
│ Pass  │  │ Block  │
│ 2xx   │  │ 403    │
└───────┘  └────────┘
```

---

## Quick Start

### 1. Deploy the Worker

Deploy GAIT to run on **your** Cloudflare account.

```bash
# Clone the repository
git clone https://github.com/Amit-0905/GAIT.git
cd GAIT

# Install dependencies
npm install

# Log in to Cloudflare
npx wrangler login

# Set a strong, random cryptographic secret
npx wrangler secret put GAIT_SECRET

# Update wrangler.toml with your domain pattern, then deploy
npx wrangler deploy
```

`wrangler.toml` configuration:

```toml
name = "gait-worker"
main = "worker/worker.ts"
compatibility_date = "2026-06-09"
compatibility_flags = ["nodejs_compat"]

[vars]
GAIT_MODE = "balanced"
GAIT_ALLOWLIST_IPS = ""
```

---

### 2. Add GAIT to your Forms

Build the production bundles:

```bash
npm run build
```

Then drop the script onto your HTML pages.

```html
<!-- HTML Form -->
<form action="/contact" method="POST" data-gait="v2">
  <label>Email <input type="email" name="email" required /></label><br />
  <label>Message <textarea name="message" required></textarea></label><br />
  <button type="submit">Send</button>
</form>

<!-- Include & Initialize GAIT Client -->
<script type="module">
  import { Gait } from './dist/gait-v2.esm.js';
  const gait = new Gait({
    challengeUrl: '/gait-challenge', // Handled by your Worker route
    submitMode: 'form', // 'form' for standard HTML navigation, 'fetch' for custom AJAX
  });
  gait.attachForms();
</script>
```

---

## Universal Attestation API — protect any custom action

For single-page apps (SPA) or AJAX forms, request attestations programmatically:

```js
import { Gait } from 'gait';

const gait = new Gait({ challengeUrl: '/gait-challenge' });

document.getElementById('upvote-btn').addEventListener('click', async () => {
  const { headers } = await gait.attest();

  await fetch('/api/upvote', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: 42 }),
  });
});
```

---

## Configuration

### Client Options

| Option          | Type                                  | Default              | Description                                                                                                             |
| --------------- | ------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `challengeUrl`  | `string`                              | `/gait-challenge`    | Worker challenge endpoint                                                                                               |
| `submitMode`    | `'form' \| 'fetch'`                   | `'form'`             | **'form'** appends inputs and submits naturally (native navigation). **'fetch'** intercepts and submits via AJAX fetch. |
| `mode`          | `'strict' \| 'balanced' \| 'observe'` | `'balanced'`         | Early client-side threshold adjustments                                                                                 |
| `formSelector`  | `string`                              | `[data-gait="v2"]`   | Selector for forms to automatically hook                                                                                |
| `fieldName`     | `string`                              | `__gait_v2`          | Hidden input field name for attestation                                                                                 |
| `trapName`      | `string`                              | `gait_website_field` | Honeypot field name (filled by bots)                                                                                    |
| `minDurationMs` | `number`                              | `1800`               | Minimum interaction duration before submit                                                                              |
| `maxPoints`     | `number`                              | `96`                 | Max cursor points to sample                                                                                             |
| `movingTarget`  | `boolean`                             | `true`               | Introduces dynamic delay to submit action                                                                               |
| `focusTrap`     | `boolean`                             | `true`               | Invisible overlay test for headless bots                                                                                |
| `useWorker`     | `boolean`                             | `true`               | Calculate signature hashes off main thread                                                                              |
| `debug`         | `boolean`                             | `false`              | Enable console log diagnostics                                                                                          |
| `ciBypass`      | `boolean`                             | `false`              | Skip challenge validation inside CI tests                                                                               |

### Worker Environment Variables

| Variable                | Default      | Purpose                                            |
| ----------------------- | ------------ | -------------------------------------------------- |
| `GAIT_SECRET`           | _(Required)_ | HMAC 32-byte secret for token signing              |
| `GAIT_MODE`             | `balanced`   | Scoring mode (`strict` \| `balanced` \| `observe`) |
| `GAIT_ALLOWLIST_IPS`    | `""`         | Comma-separated client IPs to bypass scoring       |
| `GAIT_REPLAY_WINDOW_MS` | `600000`     | Nonce expiration window (10 minutes)               |

---

## Response Headers

| Header           | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `X-Gait-Score`   | Numeric risk score (0 to 100+; higher is suspicious) |
| `X-Gait-Reasons` | Comma-separated list of reason codes                 |
| `X-Gait-Mode`    | Scoring mode                                         |
| `X-Gait-Country` | Country code provided by Cloudflare                  |
| `X-Gait-Observe` | `1` if in observe mode (no blocking)                 |

---

## Client Events

| Event        | Detail                       | When                                  |
| ------------ | ---------------------------- | ------------------------------------- |
| `gait:pass`  | `{ status }`                 | Verification passed successfully      |
| `gait:block` | `{ status, score, reasons }` | Request blocked (Worker returned 403) |
| `gait:error` | `{ reason }`                 | Attestation/network request failed    |

---

## Reason Codes

| Code                      | Layer       | Meaning                                      |
| ------------------------- | ----------- | -------------------------------------------- |
| `webdriver`               | env         | `navigator.webdriver === true`               |
| `playwright`              | env         | Playwright globals detected                  |
| `cypress`                 | env         | Cypress testing globals detected             |
| `headless_ua`             | env         | HeadlessChrome User-Agent match              |
| `no_plugins`              | env         | Zero browser plugins in Chrome               |
| `zero_hardware`           | env         | Hardware concurrency & memory spoofed/zeroed |
| `too_fast`                | stats       | Submission duration below minimum limit      |
| `mechanical_speed`        | stats       | Speed Coefficient of Variation too regular   |
| `robotic_path`            | stats       | Path angular variations too low              |
| `too_straight`            | stats       | Cursor path is linear (tortuosity ~ 1.0)     |
| `thin_interaction`        | stats       | Insufficient cursor/scroll actions           |
| `moving_target_premature` | client      | Submitted before target reveal               |
| `too_fast_after_reveal`   | worker      | Submission too quick after element reveal    |
| `focus_trap_missed`       | worker      | Bot clicked submit without clearing overlay  |
| `impossible_recovery`     | worker      | Recovered from overlay in < 50ms             |
| `honeypot`                | form        | Hidden input field populated                 |
| `bad_challenge`           | header      | Challenge HMAC verification failed           |
| `expired_challenge`       | header      | Challenge token expired                      |
| `replay_nonce`            | header      | Challenge token already consumed             |
| `missing_proof`           | body/header | No attestation data received                 |
| `bad_proof`               | body/header | Parsing attestation JSON failed              |
| `keyboard_accessible`     | bonus       | Keyboard-only interaction bonus              |
| `touch_session`           | bonus       | Touch event interaction bonus                |

---

## Accessibility

- Keyboard-only sessions are detected, graded on keystroke intervals, and receive a score bonus.
- Touch sessions are recognized and scored more leniently than mouse events.
- Screen reader accessibility is supported. Always test using `observe` mode before rolling out `strict` mode in production.

---

## CI / Testing

```js
const gait = new Gait({ ciBypass: true });
```

Never enable `ciBypass` in production.

---

## Production Rollout

1. Deploy Worker in `observe` mode.
2. Protect one low-risk route.
3. Log `X-Gait-Score` and `X-Gait-Reasons` for 3–7 days.
4. Review false positives (keyboard, touch, assistive tech).
5. Switch to `balanced` per route.

---

## Limitations

- Advanced bots can simulate richer behavior over time. This is an arms race, not a one-time shield.
- Accessibility and privacy reviews are recommended before large-scale rollout.
- Best used as one layer in a broader anti-abuse system.
- **Read-only scraping** (downloading public pages) is not blocked — GAIT guards **actions**, not **views**.
- **DDoS / volumetric attacks** need rate-limiting or Cloudflare Magic Transit, not GAIT.

---

## Roadmap

- Route-specific thresholds via KV.
- Signed proof hashing (zero-knowledge).
- KV-based replay cache for multi-region Workers.
- Admin dashboard for score analytics.
- WebAuthn-bound high-risk actions.

---

## Author

**Amit** — [github.com/Amit-0905](https://github.com/Amit-0905)

Built for [Anti-Bot](https://github.com/Amit-0905) and the broader anti-bot community.

---

## License

This project is licensed under a **Non-Commercial License**. Free for personal, educational, research, and non-commercial use.

Commercial licensing and a managed SaaS offering are currently being prepared. For enterprise inquiries, commercial agreements, or high-volume usage, please open an issue or contact the maintainers.

See the [LICENSE](LICENSE) file for full details.
