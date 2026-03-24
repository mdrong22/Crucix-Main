const SWEEP_ESTIMATE_S = 50; // estimated sweep duration in seconds

const lines = [
  'CRUCIX INTELLIGENCE ENGINE v2.0.0',
  'INITIATING FIRST SWEEP...',
  '├── CONNECTING 25 OSINT SOURCES',
  '├── GDELT · OPENSKY · FIRMS · MARITIME · SAFECAST',
  '├── FRED · BLS · EIA · TREASURY · GSCPI',
  '└── TELEGRAM · WHO · OFAC · ACLED · REDDIT · BLUESKY',
  '<span class="ok">AWAITING SWEEP COMPLETION...</span>',
];

const container = document.getElementById('bootLines');
lines.forEach((text, i) => {
  setTimeout(() => {
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = text;
    container.appendChild(div);
  }, i * 220);
});

const statusMessages = [
  'COLLECTING DATA...',
  'PROCESSING SOURCES...',
  'SYNTHESIZING SIGNALS...',
  'CORRELATING FEEDS...',
  'AWAITING COMPLETION...',
];
let statusIdx = 0;
const statusText = document.getElementById('statusText');
setInterval(() => {
  statusIdx = (statusIdx + 1) % statusMessages.length;
  statusText.textContent = statusMessages[statusIdx];
}, 4000);

// === Countdown ===
const etaText = document.getElementById('etaText');
const barFill = document.getElementById('barFill');
let countdownInterval = null;

function startCountdown(elapsedSeconds) {
  let remaining = Math.max(0, SWEEP_ESTIMATE_S - elapsedSeconds);

  function tick() {
    if (remaining <= 0) {
      etaText.textContent = 'FINALIZING...';
      barFill.style.width = '99%';
      return;
    }
    const pct = Math.min(99, ((SWEEP_ESTIMATE_S - remaining) / SWEEP_ESTIMATE_S) * 100);
    barFill.style.width = pct + '%';
    etaText.innerHTML = `EST. READY IN <span class="eta">~${remaining}s</span>`;
    remaining--;
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

// Fetch health to get elapsed time since sweep started
fetch('/api/health')
  .then(r => r.json())
  .then(h => {
    let elapsed = 0;
    if (h.sweepStartedAt) {
      elapsed = Math.floor((Date.now() - new Date(h.sweepStartedAt).getTime()) / 1000);
    }
    startCountdown(elapsed);
  })
  .catch(() => startCountdown(0));

// === SSE — wait for sweep to complete, then redirect ===
let redirected = false;
function goToDashboard() {
  if (redirected) return;
  redirected = true;
  clearInterval(countdownInterval);
  clearInterval(pollInterval);
  barFill.style.transition = 'width 0.4s ease';
  barFill.style.width = '100%';
  etaText.textContent = '';
  statusText.textContent = 'TERMINAL READY — LOADING DASHBOARD';
  setTimeout(() => location.replace('/'), 800);
}

const es = new EventSource('/events');
es.onmessage = (e) => {
  try {
    const msg = JSON.parse(e.data);
    if (msg.type === 'update') {
      es.close();
      goToDashboard();
    }
  } catch {}
};
es.onerror = () => {
  es.close();
  setTimeout(() => location.reload(), 3000);
};

// === Fallback polling — in case SSE misses the update ===
const pollInterval = setInterval(() => {
  fetch('/api/data').then(r => {
    if (r.ok) goToDashboard();
  }).catch(() => {});
}, 5000);