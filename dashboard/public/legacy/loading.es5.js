"use strict";

var SWEEP_ESTIMATE_S = 50; // estimated sweep duration in seconds

var lines = ['CRUCIX INTELLIGENCE ENGINE v2.0.0', 'INITIATING FIRST SWEEP...', '├── CONNECTING 25 OSINT SOURCES', '├── GDELT · OPENSKY · FIRMS · MARITIME · SAFECAST', '├── FRED · BLS · EIA · TREASURY · GSCPI', '└── TELEGRAM · WHO · OFAC · ACLED · REDDIT · BLUESKY', '<span class="ok">AWAITING SWEEP COMPLETION...</span>'];
var container = document.getElementById('bootLines');
lines.forEach(function (text, i) {
  setTimeout(function () {
    var div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = text;
    container.appendChild(div);
  }, i * 220);
});
var statusMessages = ['COLLECTING DATA...', 'PROCESSING SOURCES...', 'SYNTHESIZING SIGNALS...', 'CORRELATING FEEDS...', 'AWAITING COMPLETION...'];
var statusIdx = 0;
var statusText = document.getElementById('statusText');
setInterval(function () {
  statusIdx = (statusIdx + 1) % statusMessages.length;
  statusText.textContent = statusMessages[statusIdx];
}, 4000);

// === Countdown ===
var etaText = document.getElementById('etaText');
var barFill = document.getElementById('barFill');
var countdownInterval = null;
function startCountdown(elapsedSeconds) {
  var remaining = Math.max(0, SWEEP_ESTIMATE_S - elapsedSeconds);
  function tick() {
    if (remaining <= 0) {
      etaText.textContent = 'FINALIZING...';
      barFill.style.width = '99%';
      return;
    }
    var pct = Math.min(99, (SWEEP_ESTIMATE_S - remaining) / SWEEP_ESTIMATE_S * 100);
    barFill.style.width = pct + '%';
    etaText.innerHTML = "EST. READY IN <span class=\"eta\">~".concat(remaining, "s</span>");
    remaining--;
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

// Fetch health to get elapsed time since sweep started
fetch('/api/health').then(function (r) {
  return r.json();
}).then(function (h) {
  var elapsed = 0;
  if (h.sweepStartedAt) {
    elapsed = Math.floor((Date.now() - new Date(h.sweepStartedAt).getTime()) / 1000);
  }
  startCountdown(elapsed);
})["catch"](function () {
  return startCountdown(0);
});

// === SSE — wait for sweep to complete, then redirect ===
var redirected = false;
function goToDashboard() {
  if (redirected) return;
  redirected = true;
  clearInterval(countdownInterval);
  clearInterval(pollInterval);
  barFill.style.transition = 'width 0.4s ease';
  barFill.style.width = '100%';
  etaText.textContent = '';
  statusText.textContent = 'TERMINAL READY — LOADING DASHBOARD';
  setTimeout(function () {
    return location.replace('/');
  }, 800);
}
var es = new EventSource('/events');
es.onmessage = function (e) {
  try {
    var msg = JSON.parse(e.data);
    if (msg.type === 'update') {
      es.close();
      goToDashboard();
    }
  } catch (_unused) {}
};
es.onerror = function () {
  es.close();
  setTimeout(function () {
    return location.reload();
  }, 3000);
};

// === Fallback polling — in case SSE misses the update ===
var pollInterval = setInterval(function () {
  fetch('/api/data').then(function (r) {
    if (r.ok) goToDashboard();
  })["catch"](function () {});
}, 5000);
