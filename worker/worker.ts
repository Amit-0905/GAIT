export interface Env {
  GAIT_SECRET: string;
  GAIT_MODE?: string;
  GAIT_ALLOWLIST_IPS?: string;
  GAIT_REPLAY_WINDOW_MS?: string;
}

const DEFAULT_THRESHOLD = 65;
const OBSERVE_HEADER = 'X-Gait-Observe';
const REPLAY_WINDOW = 10 * 60 * 1000;

const seenNonces = new Map<string, number>();
let lastCleanup = 0;

function cleanExpiredNonces(replayWindow: number) {
  const now = Date.now();
  if (now - lastCleanup < 60000) return;
  lastCleanup = now;
  const cutoff = now - replayWindow;
  for (const [k, t] of seenNonces.entries()) {
    if (t < cutoff) seenNonces.delete(k);
  }
}

function enc(s: string) {
  return new TextEncoder().encode(s);
}
function b64(bytes: ArrayBuffer) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function atobUtf8(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function importKey(secret: string) {
  return crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function sign(secret: string, message: string) {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc(message));
  return b64(sig);
}

async function verify(secret: string, message: string, signature: string) {
  try {
    const key = await importKey(secret);
    const sigBin = atob(signature);
    const sigBytes = new Uint8Array(sigBin.length);
    for (let i = 0; i < sigBin.length; i++) {
      sigBytes[i] = sigBin.charCodeAt(i);
    }
    return await crypto.subtle.verify('HMAC', key, sigBytes, enc(message));
  } catch {
    return false;
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

function scoreProof(
  proof: any,
  meta: { revealMs?: number; focusTrap?: boolean; recoveryMs?: number }
) {
  let score = 0;
  const reasons: string[] = [];
  const env = proof?.env || {};
  const stats = proof?.stats || {};

  if (env.webdriver) {
    score += 100;
    reasons.push('webdriver');
  }
  if (env.playwright) {
    score += 100;
    reasons.push('playwright');
  }
  if (env.cypress) {
    score += 60;
    reasons.push('cypress');
  }
  if (env.headlessUA) {
    score += 80;
    reasons.push('headless_ua');
  }
  if (env.plugins === 0 && /Chrome/i.test(env.ua || '')) {
    score += 15;
    reasons.push('no_plugins');
  }
  if ((env.deviceMemory || 0) === 0 && (env.hardwareConcurrency || 0) === 0) {
    score += 20;
    reasons.push('zero_hardware');
  }

  if (meta.revealMs != null && meta.revealMs > 0) {
    if (stats.durationMs < meta.revealMs + 400) {
      score += 25;
      reasons.push('too_fast_after_reveal');
    }
  }
  if (meta.focusTrap === false) {
    score += 25;
    reasons.push('focus_trap_missed');
  }
  if (meta.recoveryMs != null && meta.recoveryMs > 0 && meta.recoveryMs < 50) {
    score += 35;
    reasons.push('impossible_recovery');
  }

  if (!stats || stats.empty) {
    score += 45;
    reasons.push('no_stats');
  } else {
    if ((stats.durationMs || 0) < 1800 && !stats.keyboardOnly) {
      score += 35;
      reasons.push('too_fast');
    }
    if ((stats.cvSpeed || 0) < 0.12 && !stats.keyboardOnly) {
      score += 35;
      reasons.push('mechanical_speed');
    }
    if ((stats.meanAngleChange || 0) < 0.025 && !stats.keyboardOnly) {
      score += 20;
      reasons.push('robotic_path');
    }
    if ((stats.tortuosity || 1) > 1 && (stats.tortuosity || 1) < 1.04 && !stats.keyboardOnly) {
      score += 15;
      reasons.push('too_straight');
    }
    if ((stats.keyCount || 0) === 0 && (stats.scrollCount || 0) === 0 && (stats.points || 0) < 2) {
      score += 20;
      reasons.push('thin_interaction');
    }
    if (stats.keyboardOnly && (stats.keyCount || 0) >= 2 && (stats.keyCv || 0) > 0.08) {
      score -= 20;
      reasons.push('keyboard_accessible');
    }
    if ((stats.pointerType === 'touch' || env.touchCapable) && (stats.touches || 0) > 0) {
      score -= 10;
      reasons.push('touch_session');
    }
  }

  if (score < 0) score = 0;
  return { score, reasons };
}

async function parseChallenge(secret: string, token: string) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  let payload = '';
  try {
    payload = atobUtf8(payloadB64);
  } catch {
    return null;
  }
  const ok = await verify(secret, payload, sig);
  if (!ok) return null;
  try {
    return JSON.parse(payload) as { t: number; n: string };
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname;
    const mode = env.GAIT_MODE || 'balanced';
    const replayWindow = Number(env.GAIT_REPLAY_WINDOW_MS || String(REPLAY_WINDOW));

    // Prevent infinite fetch loops when accessed directly on workers.dev subdomains
    if (
      host.endsWith('.workers.dev') &&
      url.pathname !== '/gait-challenge' &&
      url.pathname !== '/gait-health'
    ) {
      return new Response(
        'GAIT Worker is active. Deploy as a route on your custom domain to proxy traffic.',
        {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }
      );
    }

    if (!env.GAIT_SECRET) return new Response('GAIT_SECRET missing', { status: 500 });

    if (url.pathname === '/gait-challenge' && request.method === 'GET') {
      const payload = JSON.stringify({ t: Date.now(), n: crypto.randomUUID() });
      const token = `${btoa(payload)}.${await sign(env.GAIT_SECRET, payload)}`;
      return new Response(token, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store, max-age=0',
        },
      });
    }

    if (url.pathname === '/gait-health' && request.method === 'GET') {
      return json({ ok: true, mode, seenNonces: seenNonces.size });
    }

    if (request.method !== 'POST') return fetch(request);

    const cf = (request as any).cf || {};
    const clientIp = request.headers.get('CF-Connecting-IP') || '';
    const allowIps = (env.GAIT_ALLOWLIST_IPS || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    const isAllowlisted = clientIp && allowIps.includes(clientIp);

    // Only parse formData if it matches standard form contents to avoid breaking raw JSON payloads
    const contentType = request.headers.get('content-type') || '';
    const isForm =
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data');

    let form: FormData | null = null;
    if (isForm) {
      try {
        form = await request.formData();
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
    }

    const trapName = form
      ? Array.from(form.keys()).find(k => /^gait_.*field$/.test(k) || k === 'gait_website_field')
      : undefined;
    if (form && trapName && form.get(trapName)) {
      return new Response('Forbidden', {
        status: 403,
        headers: { 'X-Gait-Score': '100', 'X-Gait-Reasons': 'honeypot' },
      });
    }

    const challenge =
      request.headers.get('X-Gait-Challenge') ||
      (form ? (form.get('__gait_challenge') as string) : '') ||
      '';
    if (challenge !== 'ci-bypass') {
      cleanExpiredNonces(replayWindow);
      const parsed = await parseChallenge(env.GAIT_SECRET, challenge);
      if (!parsed)
        return new Response('Forbidden', {
          status: 403,
          headers: { 'X-Gait-Reasons': 'bad_challenge' },
        });
      const age = Date.now() - Number(parsed.t || 0);
      if (!(age >= 0 && age <= replayWindow))
        return new Response('Forbidden', {
          status: 403,
          headers: { 'X-Gait-Reasons': 'expired_challenge' },
        });
      if (seenNonces.has(parsed.n))
        return new Response('Forbidden', {
          status: 403,
          headers: { 'X-Gait-Reasons': 'replay_nonce' },
        });
      seenNonces.set(parsed.n, Date.now());
    }

    const raw = request.headers.get('X-Gait-Attestation') || (form ? form.get('__gait_v2') : null);
    if (!raw)
      return new Response('Forbidden', {
        status: 403,
        headers: { 'X-Gait-Reasons': 'missing_proof' },
      });

    let proof: any = null;
    try {
      proof = JSON.parse(atobUtf8(String(raw)));
    } catch {
      try {
        proof = JSON.parse(String(raw));
      } catch {
        return new Response('Forbidden', {
          status: 403,
          headers: { 'X-Gait-Reasons': 'bad_proof' },
        });
      }
    }

    const meta = {
      revealMs:
        Number(
          request.headers.get('X-Gait-RevealMs') || (form ? form.get('__gait_reveal') : '0') || '0'
        ) || undefined,
      focusTrap:
        request.headers.get('X-Gait-FocusTrap') === '1' ||
        (form ? form.get('__gait_focus_trap') === '1' : false),
      recoveryMs:
        Number(
          request.headers.get('X-Gait-RecoveryMs') ||
            (form ? form.get('__gait_recovery') : '0') ||
            '0'
        ) || undefined,
    };

    const result = scoreProof(proof, meta);
    let threshold = DEFAULT_THRESHOLD;
    if (mode === 'strict') threshold = 50;
    if (mode === 'observe') threshold = 999;
    if (isAllowlisted) threshold = 999;

    const shouldBlock = result.score >= threshold;

    // Construct cleaned form data without GAIT helper fields
    let clean: FormData | null = null;
    if (form) {
      clean = new FormData();
      for (const [k, v] of form.entries()) {
        if (
          k !== '__gait_v2' &&
          k !== '__gait_challenge' &&
          k !== trapName &&
          k !== '__gait_reveal' &&
          k !== '__gait_focus_trap' &&
          k !== '__gait_recovery'
        ) {
          clean.append(k, v);
        }
      }
    }

    const newHeaders = new Headers(request.headers);
    newHeaders.set('X-Gait-Score', String(result.score));
    newHeaders.set('X-Gait-Reasons', result.reasons.join(','));
    newHeaders.set('X-Gait-Mode', mode);
    if (cf && typeof cf.country === 'string') newHeaders.set('X-Gait-Country', cf.country);

    if (shouldBlock) {
      if (mode === 'observe') {
        newHeaders.set(OBSERVE_HEADER, '1');
      } else {
        return new Response('Blocked', { status: 403, headers: newHeaders });
      }
    }

    // Forward the request preserving either the cleaned form data or the original raw body (e.g. JSON)
    const upstream = new Request(request.url, {
      method: request.method,
      headers: newHeaders,
      body: form ? clean : request.body,
      redirect: 'manual',
      ...(form ? {} : { duplex: 'half' }),
    });
    return fetch(upstream);
  },
};
