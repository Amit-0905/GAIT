export type GaitMode = 'strict' | 'balanced' | 'observe';

export interface GaitConfig {
  challengeUrl?: string;
  mode?: GaitMode;
  formSelector?: string;
  fieldName?: string;
  trapName?: string;
  minDurationMs?: number;
  maxPoints?: number;
  debug?: boolean;
  ciBypass?: boolean;
  movingTarget?: boolean;
  focusTrap?: boolean;
  useWorker?: boolean;
  submitMode?: 'fetch' | 'form';
}

interface Point {
  x: number;
  y: number;
  t: number;
}
interface KeyPoint {
  k: number;
  t: number;
}
interface ScrollPoint {
  y: number;
  t: number;
}

const defaults: Required<GaitConfig> = {
  challengeUrl: '/gait-challenge',
  mode: 'balanced',
  formSelector: '[data-gait="v2"]',
  fieldName: '__gait_v2',
  trapName: 'gait_website_field',
  minDurationMs: 1800,
  maxPoints: 96,
  debug: false,
  ciBypass: false,
  movingTarget: true,
  focusTrap: true,
  useWorker: true,
  submitMode: 'form',
};

function now() {
  return Math.round(performance.now());
}
function mean(arr: number[]) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function variance(arr: number[]) {
  const m = mean(arr);
  return arr.length ? mean(arr.map(v => (v - m) * (v - m))) : 0;
}

function btoaUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function getEnv() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const w = window as Window & {
    __playwright?: unknown;
    __pw_resume?: unknown;
    __pw_manual?: unknown;
    Cypress?: unknown;
  };
  return {
    webdriver: !!navigator.webdriver,
    plugins: navigator.plugins ? navigator.plugins.length : 0,
    deviceMemory: nav.deviceMemory || 0,
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    platform: navigator.platform || '',
    touchCapable: navigator.maxTouchPoints > 0 || 'ontouchstart' in window,
    ua: navigator.userAgent,
    headlessUA: /HeadlessChrome|Headless/i.test(navigator.userAgent),
    playwright: !!(w.__playwright || w.__pw_resume || w.__pw_manual),
    cypress: !!w.Cypress,
    languages: navigator.languages ? navigator.languages.join(',') : navigator.language || '',
    dimDiff:
      Math.abs(window.outerWidth - window.innerWidth) +
      Math.abs(window.outerHeight - window.innerHeight),
    reducedMotion:
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
  };
}

class MovingTarget {
  ready = false;
  revealMs = 0;
  private _onReady?: () => void;
  constructor(private cfg: { minMs: number; maxMs: number }) {
    this.revealMs = cfg.minMs + Math.random() * (cfg.maxMs - cfg.minMs);
  }
  start() {
    setTimeout(() => {
      this.ready = true;
      this._onReady?.();
    }, this.revealMs);
  }
  onReady(cb: () => void) {
    if (this.ready) cb();
    else this._onReady = cb;
  }
}

class FocusTrap {
  triggered = false;
  recoveryMs = 0;
  private startMs = 0;
  constructor(private form: HTMLFormElement) {}
  arm(delayMs: number) {
    setTimeout(() => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;opacity:0;pointer-events:auto;';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
      this.startMs = performance.now();
      const btn = this.form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      const remove = () => {
        overlay.remove();
        if (btn) btn.disabled = false;
        this.recoveryMs = performance.now() - this.startMs;
        this.triggered = true;
      };
      window.addEventListener('pointerdown', remove, { once: true, capture: true });
      window.addEventListener('keydown', remove, { once: true, capture: true });
      window.addEventListener('focus', remove, { once: true, capture: true });
      setTimeout(remove, 3000);
    }, delayMs);
  }
}

class Recorder {
  path: Point[] = [];
  keys: KeyPoint[] = [];
  scrolls: ScrollPoint[] = [];
  touches = 0;
  pointerType: string | null = null;
  start = performance.now();
  lastMove = 0;
  maxPoints: number;
  constructor(maxPoints: number) {
    this.maxPoints = maxPoints;
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this.onPointerDown, { passive: true });
    window.addEventListener('keydown', this.onKeyDown, { passive: true });
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('touchmove', this.onTouchMove, { passive: true });
  }
  onPointerMove = (e: PointerEvent) => {
    if (!e.isTrusted) return;
    const t = now();
    if (t - this.lastMove < 12) return;
    this.lastMove = t;
    this.pointerType = e.pointerType || this.pointerType;
    this.path.push({ x: Math.round(e.clientX), y: Math.round(e.clientY), t });
    if (this.path.length > this.maxPoints) this.path.splice(0, this.path.length - this.maxPoints);
  };
  onPointerDown = (e: PointerEvent) => {
    if (!e.isTrusted) return;
    this.pointerType = e.pointerType || this.pointerType;
    const t = now();
    this.path.push({ x: Math.round(e.clientX), y: Math.round(e.clientY), t });
    if (this.path.length > this.maxPoints) this.path.splice(0, this.path.length - this.maxPoints);
  };
  onKeyDown = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    this.keys.push({ k: e.key.length, t: now() });
    if (this.keys.length > 64) this.keys.splice(0, this.keys.length - 64);
  };
  onScroll = () => {
    this.scrolls.push({ y: Math.round(window.scrollY), t: now() });
    if (this.scrolls.length > 64) this.scrolls.splice(0, this.scrolls.length - 64);
  };
  onTouchMove = (e: TouchEvent) => {
    if (!e.isTrusted) return;
    this.touches += e.touches?.length || 1;
  };
  analyze() {
    const points = this.path;
    if (points.length < 2) {
      return {
        empty: true,
        durationMs: now(),
        pointerType: this.pointerType,
        touches: this.touches,
        keyboardOnly: this.keys.length > 0 && points.length < 2,
      };
    }
    const speeds: number[] = [];
    const angleChanges: number[] = [];
    let pathLen = 0;
    let prevAngle: number | null = null;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const dt = Math.max(1, points[i].t - points[i - 1].t);
      const dist = Math.hypot(dx, dy);
      if (dist === 0) continue;
      pathLen += dist;
      speeds.push(dist / dt);
      const angle = Math.atan2(dy, dx);
      if (prevAngle !== null) {
        let diff = Math.abs(angle - prevAngle);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        angleChanges.push(diff);
      }
      prevAngle = angle;
    }
    const first = points[0];
    const last = points[points.length - 1];
    const displacement = Math.hypot(last.x - first.x, last.y - first.y);
    const tortuosity = displacement > 5 ? pathLen / displacement : 1;
    const cvSpeed = speeds.length
      ? Math.sqrt(variance(speeds)) / Math.max(mean(speeds), 0.0001)
      : 0;
    const meanAngleChange = mean(angleChanges);
    const keyIntervals = this.keys.slice(1).map((k, i) => k.t - this.keys[i].t);
    const keyCv = keyIntervals.length
      ? Math.sqrt(variance(keyIntervals)) / Math.max(mean(keyIntervals), 1)
      : 0;
    return {
      empty: false,
      durationMs: Math.round(performance.now() - this.start),
      points: points.length,
      pathLen: Math.round(pathLen),
      displacement: Math.round(displacement),
      tortuosity: Number(tortuosity.toFixed(3)),
      cvSpeed: Number(cvSpeed.toFixed(3)),
      meanAngleChange: Number(meanAngleChange.toFixed(3)),
      keyCount: this.keys.length,
      keyCv: Number(keyCv.toFixed(3)),
      scrollCount: this.scrolls.length,
      pointerType: this.pointerType,
      touches: this.touches,
      keyboardOnly: this.keys.length > 0 && points.length < 2,
    };
  }
  toJSON() {
    return {
      env: getEnv(),
      stats: this.analyze(),
      path: this.path,
      keys: this.keys,
      scrolls: this.scrolls,
    };
  }
}

const WORKER_CODE = `self.onmessage=function(e){const{nonce,path,keys,scrolls}=e.data;let hash=0;const str=nonce+JSON.stringify(path)+JSON.stringify(keys)+JSON.stringify(scrolls);for(let i=0;i<str.length;i++){const chr=str.charCodeAt(i);hash=((hash<<5)-hash)+chr;hash|=0;}self.postMessage({hash});};`;

function computeHashWorker(nonce: string, payload: object): Promise<string> {
  return new Promise(resolve => {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const w = new Worker(URL.createObjectURL(blob));
    w.onmessage = e => {
      resolve(String(e.data.hash));
      w.terminate();
    };
    w.postMessage({ nonce, ...payload });
  });
}

function maybeCIBypass(config: Required<GaitConfig>) {
  if (!config.ciBypass) return false;
  const w = window as Window & { Cypress?: unknown };
  return !!w.Cypress || /Playwright|HeadlessChrome/i.test(navigator.userAgent);
}

async function getChallenge(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('challenge_failed');
  return res.text();
}

function addHoneypot(form: HTMLFormElement, trapName: string) {
  if (form.querySelector(`input[name="${trapName}"]`)) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.name = trapName;
  input.autocomplete = 'off';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText =
    'position:absolute;opacity:0;width:1px;height:1px;left:-9999px;pointer-events:none;';
  form.prepend(input);
}

export class Gait {
  private recorder: Recorder;
  private challengePromise: Promise<string>;
  private cfg: Required<GaitConfig>;

  constructor(config: GaitConfig = {}) {
    this.cfg = { ...defaults, ...config };
    this.recorder = new Recorder(this.cfg.maxPoints);
    this.challengePromise = maybeCIBypass(this.cfg)
      ? Promise.resolve('ci-bypass')
      : getChallenge(this.cfg.challengeUrl);
  }

  async attest(): Promise<{ proof: string; challenge: string; headers: Record<string, string> }> {
    const stats = this.recorder.analyze();
    if (
      !maybeCIBypass(this.cfg) &&
      stats.durationMs < this.cfg.minDurationMs &&
      !stats.keyboardOnly
    ) {
      throw new Error('gait: too_fast');
    }
    const payload = this.recorder.toJSON();
    let challenge = 'ci-bypass';
    try {
      challenge = await this.challengePromise;
    } catch {
      throw new Error('gait: challenge_failed');
    }
    let workerHash = '';
    if (this.cfg.useWorker && typeof Worker !== 'undefined') {
      try {
        workerHash = await computeHashWorker(challenge, payload);
      } catch {
        /* silent */
      }
    }
    const headers: Record<string, string> = {
      'X-Gait-Challenge': challenge,
      'X-Gait-Attestation': btoaUtf8(JSON.stringify(payload)),
    };
    if (workerHash) headers['X-Gait-Proof'] = workerHash;
    return { proof: JSON.stringify(payload), challenge, headers };
  }

  attachForms() {
    const cfg = this.cfg;
    const forms = Array.from(document.querySelectorAll(cfg.formSelector)) as HTMLFormElement[];
    forms.forEach(form => {
      if ((form as any).__gaitInit) return;
      (form as any).__gaitInit = true;
      addHoneypot(form, cfg.trapName);
      let movingTarget: MovingTarget | null = null;
      let focusTrap: FocusTrap | null = null;
      if (cfg.movingTarget) {
        movingTarget = new MovingTarget({ minMs: 800, maxMs: 2500 });
        movingTarget.start();
        const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (btn) {
          btn.disabled = true;
          movingTarget.onReady(() => (btn.disabled = false));
        }
      }
      if (cfg.focusTrap) {
        focusTrap = new FocusTrap(form);
        focusTrap.arm(4000 + Math.random() * 6000);
      }
      form.addEventListener('submit', async e => {
        e.preventDefault();
        try {
          const { proof, challenge, headers } = await this.attest();
          if (movingTarget && !movingTarget.ready) {
            form.dispatchEvent(
              new CustomEvent('gait:block', { detail: { reason: 'moving_target_premature' } })
            );
            return;
          }

          if (cfg.submitMode === 'fetch') {
            const fd = new FormData(form);
            fd.set(cfg.fieldName, proof);
            const reqHeaders = new Headers(headers);
            if (movingTarget)
              reqHeaders.set('X-Gait-RevealMs', String(Math.round(movingTarget.revealMs)));
            if (focusTrap) {
              reqHeaders.set('X-Gait-FocusTrap', focusTrap.triggered ? '1' : '0');
              reqHeaders.set('X-Gait-RecoveryMs', String(Math.round(focusTrap.recoveryMs)));
            }
            const res = await fetch(form.action || window.location.href, {
              method: (form.method || 'POST').toUpperCase(),
              body: fd,
              headers: reqHeaders,
              credentials: 'same-origin',
            });
            if (res.ok) {
              form.dispatchEvent(new CustomEvent('gait:pass', { detail: { status: res.status } }));
              if (res.redirected) {
                window.location.href = res.url;
                return;
              }
            } else {
              form.dispatchEvent(
                new CustomEvent('gait:block', {
                  detail: {
                    status: res.status,
                    score: res.headers.get('X-Gait-Score'),
                    reasons: res.headers.get('X-Gait-Reasons'),
                  },
                })
              );
            }
          } else {
            form.dispatchEvent(new CustomEvent('gait:pass', { detail: { status: 200 } }));

            let inputV2 = form.querySelector(`input[name="${cfg.fieldName}"]`) as HTMLInputElement;
            if (!inputV2) {
              inputV2 = document.createElement('input');
              inputV2.type = 'hidden';
              inputV2.name = cfg.fieldName;
              form.appendChild(inputV2);
            }
            inputV2.value = proof;

            let inputChallenge = form.querySelector(
              'input[name="__gait_challenge"]'
            ) as HTMLInputElement;
            if (!inputChallenge) {
              inputChallenge = document.createElement('input');
              inputChallenge.type = 'hidden';
              inputChallenge.name = '__gait_challenge';
              form.appendChild(inputChallenge);
            }
            inputChallenge.value = challenge;

            if (movingTarget) {
              let inputReveal = form.querySelector(
                'input[name="__gait_reveal"]'
              ) as HTMLInputElement;
              if (!inputReveal) {
                inputReveal = document.createElement('input');
                inputReveal.type = 'hidden';
                inputReveal.name = '__gait_reveal';
                form.appendChild(inputReveal);
              }
              inputReveal.value = String(Math.round(movingTarget.revealMs));
            }

            if (focusTrap) {
              let inputFocus = form.querySelector(
                'input[name="__gait_focus_trap"]'
              ) as HTMLInputElement;
              if (!inputFocus) {
                inputFocus = document.createElement('input');
                inputFocus.type = 'hidden';
                inputFocus.name = '__gait_focus_trap';
                form.appendChild(inputFocus);
              }
              inputFocus.value = focusTrap.triggered ? '1' : '0';

              let inputRecovery = form.querySelector(
                'input[name="__gait_recovery"]'
              ) as HTMLInputElement;
              if (!inputRecovery) {
                inputRecovery = document.createElement('input');
                inputRecovery.type = 'hidden';
                inputRecovery.name = '__gait_recovery';
                form.appendChild(inputRecovery);
              }
              inputRecovery.value = String(Math.round(focusTrap.recoveryMs));
            }

            form.submit();
          }
        } catch (err: any) {
          form.dispatchEvent(
            new CustomEvent('gait:error', { detail: { reason: err?.message || 'unknown' } })
          );
        }
      });
    });
  }
}

export function attach(config: GaitConfig = {}) {
  const gait = new Gait(config);
  gait.attachForms();
}

export { Recorder, getEnv };
export default { attach, Gait };
