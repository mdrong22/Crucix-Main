"use strict";

function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _toConsumableArray(r) { return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArray(r) { if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r); }
function _arrayWithoutHoles(r) { if (Array.isArray(r)) return _arrayLikeToArray(r); }
function _slicedToArray(r, e) { return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t["return"] && (u = t["return"](), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(r) { if (Array.isArray(r)) return r; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function _createForOfIteratorHelper(r, e) { var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (!t) { if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e && r && "number" == typeof r.length) { t && (r = t); var _n = 0, F = function F() {}; return { s: F, n: function n() { return _n >= r.length ? { done: !0 } : { done: !1, value: r[_n++] }; }, e: function e(r) { throw r; }, f: F }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); } var o, a = !0, u = !1; return { s: function s() { t = t.call(r); }, n: function n() { var r = t.next(); return a = r.done, r; }, e: function e(r) { u = !0, o = r; }, f: function f() { try { a || null == t["return"] || t["return"](); } finally { if (u) throw o; } } }; }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
var D = null;

// === I18N ===
var L = window.__CRUCIX_LOCALE__ || {};
function t(keyPath, fallback) {
  var keys = keyPath.split('.');
  var value = L;
  var _iterator = _createForOfIteratorHelper(keys),
    _step;
  try {
    for (_iterator.s(); !(_step = _iterator.n()).done;) {
      var key = _step.value;
      if (value && _typeof(value) === 'object' && key in value) {
        value = value[key];
      } else {
        return fallback || keyPath;
      }
    }
  } catch (err) {
    _iterator.e(err);
  } finally {
    _iterator.f();
  }
  return typeof value === 'string' ? value : fallback || keyPath;
}

// === GLOBALS ===
var globe = null;
var globeInitialized = false;
var flightsVisible = true;
var lowPerfMode = localStorage.getItem('crucix_low_perf') === 'true';
var isFlat = shouldStartFlat();
var currentRegion = 'world';
var flatSvg, flatProjection, flatPath, flatG, flatZoom, flatW, flatH;
var signalGuideItems = [{
  term: 'No Callsign',
  category: 'Air',
  meaning: 'OpenSky received an aircraft track without a usable callsign or flight ID in that record.',
  matters: 'Useful as an opacity signal. A cluster of missing callsigns can indicate incomplete transponder metadata or less transparent traffic.',
  notMeaning: 'Not proof of military, covert, or hostile activity on its own.',
  example: 'South China Sea: No Callsign 6 of 152 means 6 tracks in that theater had no usable callsign in the feed.'
}, {
  term: 'High Altitude',
  category: 'Air',
  meaning: 'Aircraft above 12,000 meters, roughly 39,000 feet, in the current OpenSky snapshot.',
  matters: 'Separates cruise-level traffic from lower-altitude local or regional movement.',
  notMeaning: 'Not a danger score and not inherently unusual. Commercial jets commonly operate here.',
  example: 'High Altitude 2 means only 2 tracked aircraft in that hotspot were above the cruise threshold at that snapshot.'
}, {
  term: 'Top Countries',
  category: 'Air',
  meaning: 'The most common OpenSky origin_country values among aircraft in that hotspot.',
  matters: 'Useful for understanding the rough composition of traffic flowing through a theater.',
  notMeaning: 'Not who is controlling the aircraft right now and not a direct indicator of military ownership.',
  example: 'China (61), Philippines (39), Taiwan (17) means those were the top registered origin countries in the snapshot.'
}, {
  term: 'FRP',
  category: 'Thermal',
  meaning: 'Fire Radiative Power. This is the intensity of one specific FIRMS hotspot, measured in megawatts.',
  matters: 'Higher FRP usually means a hotter, larger, or more energetic fire event at that exact point.',
  notMeaning: 'Not the intensity of the whole region and not automatic proof of conflict activity.',
  example: 'Sudan / Horn of Africa: FRP 92.3 MW describes that one hotspot, while Total 1,451 describes the entire regional detection count.'
}, {
  term: 'Total Detections',
  category: 'Thermal',
  meaning: 'The total number of FIRMS thermal detections in the entire region bucket for the current sweep.',
  matters: 'Useful for spotting unusually active fire clusters, especially when compared with historical baselines or night activity.',
  notMeaning: 'Not a count for the single map point you clicked and not necessarily a conflict count.',
  example: 'Total 1,451 means the whole Sudan / Horn of Africa bucket had 1,451 detections in that sweep.'
}, {
  term: 'Night Detections',
  category: 'Thermal',
  meaning: 'Thermal detections tagged as occurring at night inside the broader FIRMS region bucket.',
  matters: 'Nighttime heat can be more noteworthy because it is less likely to be routine daytime land burning.',
  notMeaning: 'Not a direct combat indicator. It still needs context from location, baseline, and corroborating sources.',
  example: 'Night 140 means 140 of the 1,451 regional detections were nighttime detections in that sweep.'
}, {
  term: 'Chokepoint',
  category: 'Maritime',
  meaning: 'A strategic maritime corridor or passage where trade and energy flows can be delayed, diverted, or disrupted.',
  matters: 'These nodes matter because a disruption here can affect shipping costs, transit times, and commodity pricing globally.',
  notMeaning: 'Not proof that disruption is happening now. It is a strategic watch location.',
  example: 'Bab el-Mandeb or the Strait of Hormuz matter because shipping and energy flows concentrate there.'
}, {
  term: 'SDR Receiver',
  category: 'Signals',
  meaning: 'A publicly reachable software-defined radio receiver in or near a region of interest.',
  matters: 'Dense receiver coverage can give you more ability to monitor communications or signal activity in a theater.',
  notMeaning: 'Not evidence of hostile emissions or a threat by itself. It is an observation and monitoring layer.',
  example: 'South China Sea SDR count means publicly accessible KiwiSDR receivers are available in or near that zone.'
}, {
  term: 'CPM',
  category: 'Radiation',
  meaning: 'Counts per minute from a radiation monitoring source, used here for relative radiation status at a site.',
  matters: 'Useful for spotting anomalies against the site’s normal range or comparing consecutive readings.',
  notMeaning: 'Not a direct safety verdict on its own. Interpretation depends on local baseline and trend, not the raw number alone.',
  example: 'A site reading 33 CPM can be normal if that location’s usual background level is in the same range.'
}, {
  term: 'HY Spread',
  category: 'Macro',
  meaning: 'High-yield credit spread, shown here as a stress proxy from FRED credit data.',
  matters: 'When spreads widen, markets are usually pricing more credit stress and tighter financial conditions.',
  notMeaning: 'Not a recession call by itself. It is one stress signal among many.',
  example: 'A rising HY Spread alongside higher VIX and weaker equities is a stronger risk-off pattern than HY alone.'
}, {
  term: 'VIX',
  category: 'Macro',
  meaning: 'The CBOE Volatility Index, commonly used as a market-implied fear or volatility gauge.',
  matters: 'Higher VIX often means more expected equity volatility and more defensive market positioning.',
  notMeaning: 'Not a direct forecast of a crash and not a geopolitical indicator by itself.',
  example: 'VIX above 20 with widening HY spreads is a stronger stress pattern than VIX alone.'
}, {
  term: 'GSCPI',
  category: 'Macro',
  meaning: 'The Global Supply Chain Pressure Index, a broad indicator of global supply-chain strain.',
  matters: 'It helps translate geopolitical or weather disruptions into likely pressure on shipping, inventory, and pricing.',
  notMeaning: 'Not a live market price and not a company-specific supply-chain score by itself.',
  example: 'A higher GSCPI makes route or energy shocks more likely to spill into broader cost pressure.'
}, {
  term: 'WHO Alert',
  category: 'Health',
  meaning: 'A WHO Disease Outbreak News item or outbreak-related bulletin surfaced in the health layer.',
  matters: 'Useful for watching outbreaks that could affect travel, supply chains, humanitarian stress, or regional operating conditions.',
  notMeaning: 'Not a pandemic declaration and not automatically high severity.',
  example: 'A WHO alert in a port-heavy region matters more if it overlaps shipping, border controls, or local instability signals.'
}, {
  term: 'Sweep Delta',
  category: 'Platform',
  meaning: 'The change summary between the current sweep and the previous one, including new, escalated, and de-escalated signals.',
  matters: 'Useful for spotting what changed recently instead of re-reading the full dashboard from scratch.',
  notMeaning: 'Not a full risk model. It is a directional change layer on top of the raw signals.',
  example: 'A delta marked risk-off with several new and escalated items means the latest sweep materially worsened the signal mix.'
}];
var regionPOV = {
  world: {
    lat: 20,
    lng: 20,
    altitude: 1.8
  },
  americas: {
    lat: 35,
    lng: -95,
    altitude: 1.0
  },
  europe: {
    lat: 50,
    lng: 15,
    altitude: 1.0
  },
  middleEast: {
    lat: 28,
    lng: 45,
    altitude: 1.1
  },
  asiaPacific: {
    lat: 25,
    lng: 110,
    altitude: 1.2
  },
  africa: {
    lat: 5,
    lng: 20,
    altitude: 1.2
  }
};
if (lowPerfMode) document.body.classList.add('low-perf');
function isWeakMobileDevice() {
  var reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var memory = navigator.deviceMemory || 0;
  var cores = navigator.hardwareConcurrency || 0;
  return reducedMotion || memory > 0 && memory <= 4 || cores > 0 && cores <= 4;
}
function shouldStartFlat() {
  if (!isMobileLayout()) return true;
  return lowPerfMode || isWeakMobileDevice();
}
function setMapLoading(show) {
  var text = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'Initializing 3D Globe';
  var overlay = document.getElementById('mapLoading');
  var label = document.getElementById('mapLoadingText');
  if (!overlay || !label) return;
  label.textContent = text;
  overlay.classList.toggle('show', show);
}
function togglePerfMode() {
  lowPerfMode = !lowPerfMode;
  localStorage.setItem('crucix_low_perf', String(lowPerfMode));
  document.body.classList.toggle('low-perf', lowPerfMode);
  var perfStatus = document.getElementById('perfStatus');
  if (perfStatus) perfStatus.textContent = lowPerfMode ? 'LITE' : 'FULL';
  if (globe) {
    globe.controls().autoRotate = !lowPerfMode;
    globe.arcDashAnimateTime(lowPerfMode ? 0 : 2000);
  }
  if (lowPerfMode && isMobileLayout() && !isFlat) {
    toggleMapMode();
  } else {
    renderLower();
    renderRight();
  }
}

// === TOPBAR ===
function getRegionControlsMarkup() {
  return ['world', 'americas', 'europe', 'middleEast', 'asiaPacific', 'africa'].map(function (r) {
    return "<button class=\"region-btn ".concat(r === currentRegion ? 'active' : '', "\" data-region=\"").concat(r, "\" onclick=\"setRegion('").concat(r, "')\">").concat(r === 'middleEast' ? 'MIDDLE EAST' : r === 'asiaPacific' ? 'ASIA PACIFIC' : r.toUpperCase(), "</button>");
  }).join('');
}
function renderRegionControls() {
  var mapRegionBar = document.getElementById('mapRegionBar');
  if (!mapRegionBar) return;
  if (isMobileLayout()) {
    mapRegionBar.innerHTML = '';
    mapRegionBar.style.display = 'none';
    return;
  }
  mapRegionBar.innerHTML = getRegionControlsMarkup();
  mapRegionBar.style.display = 'flex';
}
function renderTopbar() {
  var _D$delta;
  var mobile = isMobileLayout();
  var ts = new Date(D.meta.timestamp);
  var d = ts.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).toUpperCase();
  var timeStr = ts.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
  document.getElementById('topbar').innerHTML = "\n    <div class=\"top-left\">\n      <span class=\"brand\">CRUCIX MONITOR</span>\n      <span class=\"regime-chip\"><span class=\"blink\"></span>WARTIME STAGFLATION RISK</span>\n    </div>\n    ".concat(mobile ? "<div class=\"top-center\">".concat(getRegionControlsMarkup(), "</div>") : '', "\n    <div class=\"top-right\">\n         <button class=\"meta-pill perf-pill\" onclick=\"togglePerfMode()\" title=\"Reduce visual effects and start mobile in flat mode\">").concat(t('dashboard.visuals', 'VISUALS'), " <span class=\"v\" id=\"perfStatus\">").concat(lowPerfMode ? t('dashboard.visualsLite', 'LITE') : t('dashboard.visualsFull', 'FULL'), "</span></button>\n      <span class=\"meta-pill\">").concat(t('dashboard.sweep', 'SWEEP'), " <span class=\"v\">").concat((D.meta.totalDurationMs / 1000).toFixed(1), "s</span></span>\n      <span class=\"meta-pill\">").concat(d, " <span class=\"v\">").concat(timeStr, "</span></span>\n      <span class=\"meta-pill\">").concat(t('dashboard.sources', 'SOURCES'), " <span class=\"v\">").concat(D.meta.sourcesOk, "/").concat(D.meta.sourcesQueried, "</span></span>\n      ").concat((_D$delta = D.delta) !== null && _D$delta !== void 0 && _D$delta.summary ? "<span class=\"meta-pill\">".concat(t('dashboard.delta', 'DELTA'), " <span class=\"v\">").concat(D.delta.summary.direction === 'risk-off' ? '&#x25B2; ' + t('dashboard.riskOff', 'RISK-OFF') : D.delta.summary.direction === 'risk-on' ? '&#x25BC; ' + t('dashboard.riskOn', 'RISK-ON') : '&#x25C6; ' + t('dashboard.mixed', 'MIXED'), "</span></span>") : '', "\n      <button class=\"guide-btn\" onclick=\"openGlossary()\">").concat(t('dashboard.guideBtn', 'What Signals Mean'), "</button>\n      <span class=\"alert-badge\">").concat(t('dashboard.highAlert', 'HIGH ALERT'), "</span>\n    </div>");
  renderRegionControls();
}

// === LEFT RAIL ===
function renderLeftRail() {
  var _D$acled, _D$acled2, _D$space, _D$space2, _usd$value, _claims$value, _ref, _D$space$constellatio, _D$space$constellatio2;
  var totalAir = D.air.reduce(function (s, a) {
    return s + a.total;
  }, 0);
  var totalThermal = D.thermal.reduce(function (s, t) {
    return s + t.det;
  }, 0);
  var totalNight = D.thermal.reduce(function (s, t) {
    return s + t.night;
  }, 0);
  var newsCount = (D.news || []).length;
  var conflictEvents = ((_D$acled = D.acled) === null || _D$acled === void 0 ? void 0 : _D$acled.totalEvents) || 0;
  var conflictFatal = ((_D$acled2 = D.acled) === null || _D$acled2 === void 0 ? void 0 : _D$acled2.totalFatalities) || 0;
  var layers = [{
    name: t('layers.airActivity', 'Air Activity'),
    count: totalAir,
    dot: 'air',
    sub: "".concat(D.air.length, " ").concat(t('layers.theaters', 'theaters'))
  }, {
    name: t('layers.thermalSpikes', 'Thermal Spikes'),
    count: totalThermal.toLocaleString(),
    dot: 'thermal',
    sub: "".concat(totalNight.toLocaleString(), " ").concat(t('layers.nightDet', 'night det.'))
  }, {
    name: t('layers.sdrCoverage', 'SDR Coverage'),
    count: D.sdr.total,
    dot: 'sdr',
    sub: "".concat(D.sdr.online, " ").concat(t('layers.online', 'online'))
  }, {
    name: t('layers.maritimeWatch', 'Maritime Watch'),
    count: D.chokepoints.length,
    dot: 'maritime',
    sub: t('layers.chokepoints', 'chokepoints')
  }, {
    name: t('layers.nuclearSites', 'Nuclear Sites'),
    count: D.nuke.length,
    dot: 'nuke',
    sub: t('layers.monitors', 'monitors')
  }, {
    name: t('layers.conflictEvents', 'Conflict Events'),
    count: conflictEvents,
    dot: 'thermal',
    sub: "".concat(conflictFatal.toLocaleString(), " ").concat(t('layers.fatalities', 'fatalities'))
  }, {
    name: t('layers.healthWatch', 'Health Watch'),
    count: D.who.length,
    dot: 'health',
    sub: t('layers.whoAlerts', 'WHO alerts')
  }, {
    name: t('layers.worldNews', 'World News'),
    count: newsCount,
    dot: 'news',
    sub: t('layers.rssGeolocated', 'RSS geolocated')
  }, {
    name: t('layers.osintFeed', 'OSINT Feed'),
    count: D.tg.posts,
    dot: 'incident',
    sub: "".concat(D.tg.urgent.length, " ").concat(t('badges.urgent', 'urgent').toLowerCase())
  }, {
    name: t('layers.spaceActivity', 'Satellites'),
    count: ((_D$space = D.space) === null || _D$space === void 0 ? void 0 : _D$space.militarySats) || 0,
    dot: 'space',
    sub: "".concat(((_D$space2 = D.space) === null || _D$space2 === void 0 ? void 0 : _D$space2.totalNewObjects) || 0, " ").concat(t('space.newLast30d', 'new (30d)'))
  }];
  var allNormal = D.nuke.every(function (s) {
    return !s.anom;
  });
  var nukeHtml = D.nuke.map(function (s) {
    var _s$cpm;
    return "<div class=\"site-row\"><span>".concat(s.site, "</span><span class=\"site-val\">").concat(s.n > 0 ? (((_s$cpm = s.cpm) === null || _s$cpm === void 0 ? void 0 : _s$cpm.toFixed(1)) || '--') + ' CPM' : 'No data', "</span></div>");
  }).join('');
  var vix = D.fred.find(function (f) {
    return f.id === 'VIXCLS';
  });
  var hy = D.fred.find(function (f) {
    return f.id === 'BAMLH0A0HYM2';
  });
  var usd = D.fred.find(function (f) {
    return f.id === 'DTWEXBGS';
  });
  var m2 = D.fred.find(function (f) {
    return f.id === 'M2SL';
  });
  var mort = D.fred.find(function (f) {
    return f.id === 'MORTGAGE30US';
  });
  var claims = D.fred.find(function (f) {
    return f.id === 'ICSA';
  });
  document.getElementById('leftRail').innerHTML = "\n    <div class=\"g-panel\">\n      <div class=\"sec-head\"><h3>".concat(t('panels.sensorGrid', 'Sensor Grid'), "</h3><span class=\"badge\">").concat(t('badges.live', 'LIVE'), "</span></div>\n      ").concat(layers.map(function (l) {
    return "<div class=\"layer-item\"><div class=\"layer-left\"><div class=\"ldot ".concat(l.dot, "\"></div><div><div class=\"layer-name\">").concat(l.name, "</div><div class=\"layer-sub\">").concat(l.sub, "</div></div></div><div class=\"layer-count\">").concat(l.count, "</div></div>");
  }).join(''), "\n    </div>\n    <div class=\"g-panel\">\n      <div class=\"sec-head\"><h3>").concat(t('panels.nuclearWatch', 'Nuclear Watch'), "</h3><span class=\"badge\">").concat(t('badges.radiation', 'RADIATION'), "</span></div>\n      <div class=\"nuke-ok\">").concat(allNormal ? '&#9679; ' + t('nuclear.allSitesNormal', 'ALL SITES NORMAL') : '&#9888; ' + t('nuclear.anomalyDetected', 'ANOMALY DETECTED'), "</div>\n      ").concat(nukeHtml, "\n    </div>\n    <div class=\"g-panel\">\n      <div class=\"sec-head\"><h3>").concat(t('panels.riskGauges', 'Risk Gauges'), "</h3><span class=\"badge\">").concat(t('badges.stress', 'STRESS'), "</span></div>\n      <div class=\"econ-row\"><span class=\"elabel\">").concat(t('metrics.vix', 'VIX'), " (Fear)</span><span class=\"eval\" style=\"color:").concat((vix === null || vix === void 0 ? void 0 : vix.value) > 20 ? 'var(--warn)' : 'var(--accent)', "\">").concat((vix === null || vix === void 0 ? void 0 : vix.value) || '--', "</span></div>\n      <div class=\"econ-row\"><span class=\"elabel\">").concat(t('metrics.hySpread', 'HY Spread'), "</span><span class=\"eval\">").concat((hy === null || hy === void 0 ? void 0 : hy.value) || '--', "</span></div>\n      <div class=\"econ-row\"><span class=\"elabel\">").concat(t('metrics.usdIndex', 'USD Index'), "</span><span class=\"eval\">").concat((usd === null || usd === void 0 || (_usd$value = usd.value) === null || _usd$value === void 0 ? void 0 : _usd$value.toFixed(1)) || '--', "</span></div>\n      <div class=\"econ-row\"><span class=\"elabel\">").concat(t('metrics.joblessClaims', 'Jobless Claims'), "</span><span class=\"eval\">").concat((claims === null || claims === void 0 || (_claims$value = claims.value) === null || _claims$value === void 0 ? void 0 : _claims$value.toLocaleString()) || '--', "</span></div>\n      <div class=\"econ-row\"><span class=\"elabel\">").concat(t('metrics.mortgage30y', '30Y Mortgage'), "</span><span class=\"eval\">").concat((mort === null || mort === void 0 ? void 0 : mort.value) || '--', "%</span></div>\n      <div class=\"econ-row\"><span class=\"elabel\">").concat(t('metrics.m2Supply', 'M2 Supply'), "</span><span class=\"eval\">$").concat(((_ref = (m2 === null || m2 === void 0 ? void 0 : m2.value) / 1000) === null || _ref === void 0 ? void 0 : _ref.toFixed(1)) || '--', "T</span></div>\n      <div class=\"econ-row\"><span class=\"elabel\">").concat(t('metrics.natDebt', 'Nat. Debt'), "</span><span class=\"eval\">$").concat((parseFloat(D.treasury.totalDebt) / 1e12).toFixed(2), "T</span></div>\n    </div>\n    <div class=\"g-panel\">\n      <div class=\"sec-head\"><h3>").concat(t('panels.spaceWatch', 'Space Watch'), "</h3><span class=\"badge\">").concat(t('badges.orbital', 'CELESTRAK'), "</span></div>\n      ").concat(D.space ? "\n        <div class=\"econ-row\"><span class=\"elabel\">New Objects (30d)</span><span class=\"eval\" style=\"color:var(--accent2)\">".concat(D.space.totalNewObjects || 0, "</span></div>\n        <div class=\"econ-row\"><span class=\"elabel\">Military Sats</span><span class=\"eval\">").concat(D.space.militarySats || 0, "</span></div>\n        <div class=\"econ-row\"><span class=\"elabel\">Starlink</span><span class=\"eval\">").concat(((_D$space$constellatio = D.space.constellations) === null || _D$space$constellatio === void 0 ? void 0 : _D$space$constellatio.starlink) || 0, "</span></div>\n        <div class=\"econ-row\"><span class=\"elabel\">OneWeb</span><span class=\"eval\">").concat(((_D$space$constellatio2 = D.space.constellations) === null || _D$space$constellatio2 === void 0 ? void 0 : _D$space$constellatio2.oneweb) || 0, "</span></div>\n        ").concat(D.space.iss ? "<div class=\"econ-row\"><span class=\"elabel\">ISS</span><span class=\"eval\" style=\"color:var(--accent)\">ALT ".concat(((D.space.iss.apogee + D.space.iss.perigee) / 2).toFixed(0), " km</span></div>") : '', "\n        ").concat(Object.entries(D.space.militaryByCountry || {}).sort(function (a, b) {
    return b[1] - a[1];
  }).slice(0, 4).map(function (_ref2) {
    var _ref3 = _slicedToArray(_ref2, 2),
      c = _ref3[0],
      n = _ref3[1];
    return "<div class=\"econ-row\"><span class=\"elabel\" style=\"padding-left:8px\">".concat(c, "</span><span class=\"eval\" style=\"font-size:10px\">").concat(n, " mil sats</span></div>");
  }).join(''), "\n        ").concat((D.space.signals || []).length ? "<div style=\"margin-top:6px;padding:6px 8px;border:1px solid rgba(68,204,255,0.2);background:rgba(68,204,255,0.04);font-family:var(--mono);font-size:9px;color:var(--accent2);line-height:1.5\">".concat(D.space.signals.slice(0, 2).join('<br>'), "</div>") : '', "\n      ") : '<div style="font-family:var(--mono);font-size:10px;color:var(--dim)">NO SPACE DATA</div>', "\n    </div>");
}

// === MAP ===
var mapLifecycleBound = false;
function bindMapLifecycleEvents() {
  if (mapLifecycleBound) return;
  mapLifecycleBound = true;
  window.addEventListener('resize', function () {
    return syncResponsiveLayout();
  });
  window.addEventListener('orientationchange', function () {
    return setTimeout(function () {
      return syncResponsiveLayout(true);
    }, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) setTimeout(function () {
      return syncResponsiveLayout(true);
    }, 150);
  });
  window.addEventListener('pageshow', function () {
    return setTimeout(function () {
      return syncResponsiveLayout(true);
    }, 150);
  });
}
function renderMapLegend() {
  document.getElementById('mapLegend').innerHTML = [{
    c: '#64f0c8',
    l: t('map.airTraffic', 'Air Traffic')
  }, {
    c: '#ff5f63',
    l: t('map.thermalFire', 'Thermal/Fire')
  }, {
    c: 'rgba(255,120,80,0.8)',
    l: t('map.conflict', 'Conflict')
  }, {
    c: '#44ccff',
    l: t('map.sdrReceiver', 'SDR Receiver')
  }, {
    c: '#ffe082',
    l: t('map.nuclearSite', 'Nuclear Site')
  }, {
    c: '#b388ff',
    l: t('map.chokepoint', 'Chokepoint')
  }, {
    c: '#ffb84c',
    l: t('map.osintEvent', 'OSINT Event')
  }, {
    c: '#69f0ae',
    l: t('map.healthAlert', 'Health Alert')
  }, {
    c: '#81d4fa',
    l: t('map.worldNews', 'World News')
  }, {
    c: '#ff9800',
    l: t('map.weatherAlert', 'Weather Alert')
  }, {
    c: '#cddc39',
    l: t('map.epaRadNet', 'EPA RadNet')
  }, {
    c: '#ffffff',
    l: t('map.spaceStation', 'Space Station')
  }, {
    c: '#6495ed',
    l: t('map.gdeltEvent', 'GDELT Event')
  }].map(function (x) {
    return "<div class=\"leg-item\"><div class=\"leg-dot\" style=\"background:".concat(x.c, "\"></div>").concat(x.l, "</div>");
  }).join('');
}
function initMap() {
  bindMapLifecycleEvents();
  renderMapLegend();
  if (isFlat) {
    if (globe && typeof globe.pauseAnimation === 'function') globe.pauseAnimation();
    document.getElementById('globeViz').style.display = 'none';
    document.getElementById('flatMapSvg').style.display = 'block';
    document.getElementById('projToggle').textContent = 'GLOBE MODE';
    document.getElementById('mapHint').textContent = 'SCROLL TO ZOOM · DRAG TO PAN';
    if (!flatSvg) initFlatMap();else {
      flatG.selectAll('*').remove();
      drawFlatMap();
    }
    setMapLoading(false);
    return;
  }
  setMapLoading(true, 'Initializing 3D Globe');
  requestAnimationFrame(function () {
    try {
      initGlobe();
      setMapLoading(false);
    } catch (_unused) {
      isFlat = true;
      document.getElementById('globeViz').style.display = 'none';
      document.getElementById('flatMapSvg').style.display = 'block';
      document.getElementById('projToggle').textContent = 'GLOBE MODE';
      document.getElementById('mapHint').textContent = '3D LOAD FAILED · FLAT MODE';
      if (!flatSvg) initFlatMap();else {
        flatG.selectAll('*').remove();
        drawFlatMap();
      }
      setMapLoading(false);
    }
  });
}
function initGlobe() {
  if (globeInitialized && globe) {
    if (typeof globe.resumeAnimation === 'function') globe.resumeAnimation();
    document.getElementById('globeViz').style.display = 'block';
    document.getElementById('flatMapSvg').style.display = 'none';
    document.getElementById('projToggle').textContent = 'FLAT MODE';
    document.getElementById('mapHint').textContent = 'DRAG TO ROTATE · SCROLL TO ZOOM';
    return;
  }
  var container = document.getElementById('mapContainer');
  var w = container.clientWidth;
  var h = container.clientHeight || 560;
  globe = Globe().width(w).height(h).globeImageUrl('//unpkg.com/three-globe@2.33.0/example/img/earth-night.jpg').bumpImageUrl('//unpkg.com/three-globe@2.33.0/example/img/earth-topology.png').backgroundImageUrl('').backgroundColor('rgba(0,0,0,0)').atmosphereColor('#64f0c8').atmosphereAltitude(0.18).showGraticules(true)
  // Points layer (main markers)
  .pointAltitude(function (d) {
    return d.alt || 0.01;
  }).pointRadius(function (d) {
    return d.size || 0.3;
  }).pointColor(function (d) {
    return d.color;
  }).pointLabel(function (d) {
    return "<b>".concat(d.popHead || '', "</b><br><span style=\"opacity:0.7\">").concat(d.popMeta || '', "</span>");
  }).onPointClick(function (pt, ev) {
    showPopup(ev, pt.popHead, pt.popText, pt.popMeta, pt.lat, pt.lng, pt.alt);
  }).onPointHover(function (pt) {
    document.getElementById('globeViz').style.cursor = pt ? 'pointer' : 'grab';
  })
  // Arcs layer (flight corridors)
  .arcColor(function (d) {
    return d.color;
  }).arcStroke(function (d) {
    return d.stroke || 0.4;
  }).arcDashLength(0.4).arcDashGap(0.2).arcDashAnimateTime(2000).arcAltitudeAutoScale(0.3).arcLabel(function (d) {
    return d.label || '';
  })
  // Rings layer (pulsing conflict events)
  .ringColor(function (d) {
    return function (t) {
      return "rgba(255,120,80,".concat(1 - t, ")");
    };
  }).ringMaxRadius(function (d) {
    return d.maxR || 3;
  }).ringPropagationSpeed(function (d) {
    return d.speed || 2;
  }).ringRepeatPeriod(function (d) {
    return d.period || 800;
  })
  // Labels layer
  .labelText(function (d) {
    return d.text;
  }).labelSize(function (d) {
    return d.size || 0.4;
  }).labelColor(function (d) {
    return d.color || 'rgba(106,138,130,0.9)';
  }).labelDotRadius(0).labelAltitude(0.012).labelResolution(2)(document.getElementById('globeViz'));

  // Style the WebGL scene
  var scene = globe.scene();
  var renderer = globe.renderer();
  renderer.setClearColor(0x000000, 0);

  // Add subtle stars background
  var starGeom = new THREE.BufferGeometry();
  var starVerts = [];
  for (var i = 0; i < 2000; i++) {
    var r = 800 + Math.random() * 200;
    var theta = Math.random() * Math.PI * 2;
    var phi = Math.acos(2 * Math.random() - 1);
    starVerts.push(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
  }
  starGeom.setAttribute('position', new THREE.Float32BufferAttribute(starVerts, 3));
  var starMat = new THREE.PointsMaterial({
    color: 0x88bbaa,
    size: 0.8,
    transparent: true,
    opacity: 0.6
  });
  scene.add(new THREE.Points(starGeom, starMat));

  // Customize graticule color
  scene.traverse(function (obj) {
    if (obj.material && obj.type === 'Line') {
      obj.material.color.set(0x1a3a2a);
      obj.material.opacity = 0.3;
      obj.material.transparent = true;
    }
  });

  // Set initial POV
  globe.pointOfView(regionPOV.world, 0);

  // Auto-rotate slowly
  globe.controls().autoRotate = !lowPerfMode;
  globe.controls().autoRotateSpeed = 0.3;
  globe.controls().enableDamping = true;
  globe.controls().dampingFactor = 0.1;

  // Stop auto-rotate on interaction, resume after 10s
  var rotateTimeout;
  var el = document.getElementById('globeViz');
  el.addEventListener('mousedown', function () {
    globe.controls().autoRotate = false;
    clearTimeout(rotateTimeout);
  });
  el.addEventListener('mouseup', function () {
    rotateTimeout = setTimeout(function () {
      if (globe && !lowPerfMode) globe.controls().autoRotate = true;
    }, 10000);
  });

  // Plot globe markers (preloaded but hidden)
  plotMarkers();

  // Start in flat mode — hide globe, show flat map
  if (isFlat) {
    document.getElementById('globeViz').style.display = 'none';
    document.getElementById('flatMapSvg').style.display = 'block';
    initFlatMap();
  } else {
    document.getElementById('globeViz').style.display = 'block';
    document.getElementById('flatMapSvg').style.display = 'none';
    document.getElementById('projToggle').textContent = 'FLAT MODE';
    document.getElementById('mapHint').textContent = 'DRAG TO ROTATE · SCROLL TO ZOOM';
  }
  globeInitialized = true;
}
function plotMarkers() {
  var _D$noaa, _D$epa, _D$space3, _D$gdelt, _D$acled3;
  if (!globe) return;
  var points = [];
  var labels = [];

  // === Air hotspots (green) ===
  var airCoords = [{
    lat: 30,
    lon: 44
  }, {
    lat: 24,
    lon: 120
  }, {
    lat: 49,
    lon: 32
  }, {
    lat: 57,
    lon: 24
  }, {
    lat: 14,
    lon: 114
  }, {
    lat: 37,
    lon: 127
  }, {
    lat: 25,
    lon: -80
  }, {
    lat: 4,
    lon: 2
  }, {
    lat: -34,
    lon: 18
  }, {
    lat: 10,
    lon: 51
  }];
  if (flightsVisible) D.air.forEach(function (a, i) {
    var c = airCoords[i];
    if (!c) return;
    points.push({
      lat: c.lat,
      lng: c.lon,
      size: 0.25 + a.total / 200,
      alt: 0.015,
      color: 'rgba(100,240,200,0.8)',
      type: 'air',
      priority: 1,
      label: a.region.replace(' Region', '') + ' ' + a.total,
      popHead: a.region,
      popMeta: 'Air Activity',
      popText: "".concat(a.total, " aircraft tracked<br>No callsign: ").concat(a.noCallsign, "<br>High altitude: ").concat(a.highAlt, "<br>Top: ").concat(a.top.slice(0, 3).map(function (t) {
        return t[0] + ' (' + t[1] + ')';
      }).join(', '))
    });
    labels.push({
      lat: c.lat,
      lng: c.lon + 2,
      text: a.region.replace(' Region', '') + ' ' + a.total,
      size: 0.35,
      color: 'rgba(106,138,130,0.8)'
    });
  });

  // === Thermal/fire (red) ===
  D.thermal.forEach(function (t) {
    t.fires.forEach(function (f) {
      points.push({
        lat: f.lat,
        lng: f.lon,
        size: 0.12 + Math.min(f.frp / 200, 0.3),
        alt: 0.008,
        color: 'rgba(255,95,99,0.7)',
        type: 'thermal',
        priority: 3,
        popHead: 'Thermal Detection',
        popMeta: 'FIRMS Satellite',
        popText: "Region: ".concat(t.region, "<br>FRP: ").concat(f.frp.toFixed(1), " MW<br>Total: ").concat(t.det.toLocaleString(), "<br>Night: ").concat(t.night.toLocaleString())
      });
    });
  });

  // === Maritime chokepoints (purple) ===
  D.chokepoints.forEach(function (cp) {
    points.push({
      lat: cp.lat,
      lng: cp.lon,
      size: 0.35,
      alt: 0.02,
      color: 'rgba(179,136,255,0.8)',
      type: 'maritime',
      priority: 1,
      popHead: cp.label,
      popMeta: 'Maritime Intelligence',
      popText: cp.note
    });
    labels.push({
      lat: cp.lat,
      lng: cp.lon + 1.5,
      text: cp.label,
      size: 0.3,
      color: 'rgba(179,136,255,0.6)'
    });
  });

  // === Nuclear sites (yellow) ===
  var nukeCoords = [{
    lat: 47.5,
    lon: 34.6
  }, {
    lat: 51.4,
    lon: 30.1
  }, {
    lat: 28.8,
    lon: 50.9
  }, {
    lat: 39.8,
    lon: 125.8
  }, {
    lat: 37.4,
    lon: 141
  }, {
    lat: 31.0,
    lon: 35.1
  }];
  D.nuke.forEach(function (n, i) {
    var _n$cpm;
    var c = nukeCoords[i];
    if (!c) return;
    points.push({
      lat: c.lat,
      lng: c.lon,
      size: 0.3,
      alt: 0.012,
      color: n.anom ? 'rgba(255,95,99,0.9)' : 'rgba(255,224,130,0.8)',
      type: 'nuke',
      priority: 2,
      popHead: n.site,
      popMeta: 'Radiation Monitoring',
      popText: "Status: ".concat(n.anom ? 'ANOMALY' : 'Normal', "<br>Avg CPM: ").concat(((_n$cpm = n.cpm) === null || _n$cpm === void 0 ? void 0 : _n$cpm.toFixed(1)) || 'No data', "<br>Readings: ").concat(n.n)
    });
  });

  // === SDR receivers (cyan) ===
  D.sdr.zones.forEach(function (z) {
    z.receivers.forEach(function (r) {
      points.push({
        lat: r.lat,
        lng: r.lon,
        size: 0.15,
        alt: 0.005,
        color: 'rgba(68,204,255,0.6)',
        type: 'sdr',
        priority: 3,
        popHead: 'SDR Receiver',
        popMeta: 'KiwiSDR Network',
        popText: "".concat(r.name, "<br>Zone: ").concat(z.region, "<br>").concat(z.count, " in zone")
      });
    });
  });

  // === OSINT events from Telegram (orange) ===
  var osintGeo = [{
    lat: 45,
    lon: 41,
    idx: 0
  }, {
    lat: 48,
    lon: 37,
    idx: 1
  }, {
    lat: 48.5,
    lon: 37.5,
    idx: 2
  }, {
    lat: 45,
    lon: 40.2,
    idx: 3
  }, {
    lat: 50.6,
    lon: 36.6,
    idx: 5
  }, {
    lat: 48.5,
    lon: 35,
    idx: 6
  }];
  osintGeo.forEach(function (o) {
    var _post$views, _post$text;
    var post = D.tg.urgent[o.idx];
    if (!post) return;
    points.push({
      lat: o.lat,
      lng: o.lon,
      size: 0.3,
      alt: 0.018,
      color: 'rgba(255,184,76,0.8)',
      type: 'osint',
      priority: 2,
      popHead: (post.channel || '').toUpperCase(),
      popMeta: "".concat(((_post$views = post.views) === null || _post$views === void 0 ? void 0 : _post$views.toLocaleString()) || '?', " views"),
      popText: cleanText(((_post$text = post.text) === null || _post$text === void 0 ? void 0 : _post$text.substring(0, 200)) || '')
    });
  });

  // === WHO health alerts (green) ===
  var whoGeo = [{
    lat: 0.3,
    lon: 32.6
  }, {
    lat: -6.2,
    lon: 106.8
  }, {
    lat: -4.3,
    lon: 15.3
  }, {
    lat: 35,
    lon: 105
  }, {
    lat: 12.5,
    lon: 105
  }, {
    lat: 35,
    lon: 105
  }, {
    lat: 28,
    lon: 84
  }, {
    lat: 24,
    lon: 45
  }, {
    lat: 30,
    lon: 70
  }, {
    lat: -0.8,
    lon: 11.6
  }];
  D.who.slice(0, 10).forEach(function (w, i) {
    var c = whoGeo[i];
    if (!c) return;
    points.push({
      lat: c.lat,
      lng: c.lon,
      size: 0.25,
      alt: 0.01,
      color: 'rgba(105,240,174,0.7)',
      type: 'health',
      priority: 2,
      popHead: w.title,
      popMeta: 'WHO Outbreak',
      popText: w.summary || ''
    });
  });

  // === News markers (light blue) ===
  (D.news || []).forEach(function (n) {
    points.push({
      lat: n.lat,
      lng: n.lon,
      size: 0.2,
      alt: 0.008,
      color: 'rgba(129,212,250,0.7)',
      type: 'news',
      priority: 3,
      popHead: n.source + ' NEWS',
      popMeta: n.region + ' · ' + getAge(n.date),
      popText: cleanText(n.title)
    });
  });

  // === NOAA severe weather alerts (orange) ===
  (((_D$noaa = D.noaa) === null || _D$noaa === void 0 ? void 0 : _D$noaa.alerts) || []).forEach(function (a) {
    points.push({
      lat: a.lat,
      lng: a.lon,
      size: 0.22,
      alt: 0.01,
      color: 'rgba(255,152,0,0.8)',
      type: 'weather',
      priority: 2,
      popHead: a.event,
      popMeta: 'NOAA/NWS · ' + a.severity,
      popText: a.headline || ''
    });
  });

  // === EPA RadNet stations (lime green) ===
  (((_D$epa = D.epa) === null || _D$epa === void 0 ? void 0 : _D$epa.stations) || []).forEach(function (s) {
    points.push({
      lat: s.lat,
      lng: s.lon,
      size: 0.18,
      alt: 0.006,
      color: 'rgba(205,220,57,0.7)',
      type: 'radiation',
      priority: 3,
      popHead: 'RadNet: ' + s.location,
      popMeta: 'EPA Radiation Monitor',
      popText: "".concat(s.analyte || '--', ": ").concat(s.result || '--', " ").concat(s.unit || '', "<br>State: ").concat(s.state)
    });
  });

  // === ISS + Space Stations (bright white, pulsing) ===
  (((_D$space3 = D.space) === null || _D$space3 === void 0 ? void 0 : _D$space3.stationPositions) || []).forEach(function (s) {
    points.push({
      lat: s.lat,
      lng: s.lon,
      size: 0.4,
      alt: 0.04,
      color: 'rgba(255,255,255,0.95)',
      type: 'space',
      priority: 1,
      popHead: s.name,
      popMeta: 'Space Station (approx.)',
      popText: "Orbital position estimate<br>Lat: ".concat(s.lat, "\xB0 Lon: ").concat(s.lon, "\xB0")
    });
    labels.push({
      lat: s.lat,
      lng: s.lon + 3,
      text: s.name.split('(')[0].trim(),
      size: 0.35,
      color: 'rgba(255,255,255,0.7)'
    });
  });

  // === GDELT geo events (steel blue) ===
  (((_D$gdelt = D.gdelt) === null || _D$gdelt === void 0 ? void 0 : _D$gdelt.geoPoints) || []).forEach(function (g) {
    points.push({
      lat: g.lat,
      lng: g.lon,
      size: 0.15 + Math.min(g.count / 50, 0.2),
      alt: 0.007,
      color: 'rgba(100,149,237,0.6)',
      type: 'gdelt',
      priority: 3,
      popHead: 'GDELT Event',
      popMeta: g.count + ' reports',
      popText: g.name || 'Global event detection'
    });
  });

  // Set points on globe
  globe.pointsData(points);
  globe.labelsData(labels);

  // === ACLED CONFLICT EVENTS (pulsing rings) ===
  var conflictRings = (((_D$acled3 = D.acled) === null || _D$acled3 === void 0 ? void 0 : _D$acled3.deadliestEvents) || []).filter(function (e) {
    return e.lat && e.lon;
  }).map(function (e) {
    var logFatal = Math.log2(Math.max(e.fatalities, 1));
    return {
      lat: e.lat,
      lng: e.lon,
      maxR: Math.max(2, Math.min(6, 1 + logFatal)),
      speed: 1.5 + Math.random(),
      period: 600 + Math.random() * 600,
      popHead: e.type || 'CONFLICT',
      popMeta: 'ACLED Conflict Data',
      popText: "".concat(e.fatalities, " fatalities<br>").concat(e.location, ", ").concat(e.country, "<br>Date: ").concat(e.date)
    };
  });
  globe.ringsData(conflictRings);

  // === FLIGHT CORRIDORS (3D arcs) ===
  var arcs = [];
  if (flightsVisible) {
    var airCoordsFlight = [{
      region: 'Middle East',
      lat: 30,
      lon: 44
    }, {
      region: 'Taiwan Strait',
      lat: 24,
      lon: 120
    }, {
      region: 'Ukraine Region',
      lat: 49,
      lon: 32
    }, {
      region: 'Baltic Region',
      lat: 57,
      lon: 24
    }, {
      region: 'South China Sea',
      lat: 14,
      lon: 114
    }, {
      region: 'Korean Peninsula',
      lat: 37,
      lon: 127
    }, {
      region: 'Caribbean',
      lat: 25,
      lon: -80
    }, {
      region: 'Gulf of Guinea',
      lat: 4,
      lon: 2
    }, {
      region: 'Cape Route',
      lat: -34,
      lon: 18
    }, {
      region: 'Horn of Africa',
      lat: 10,
      lon: 51
    }];
    var globalHubs = [{
      lat: 40.6,
      lon: -73.8
    }, {
      lat: 51.5,
      lon: -0.5
    }, {
      lat: 25.3,
      lon: 55.4
    }, {
      lat: 1.4,
      lon: 103.8
    }, {
      lat: -33.9,
      lon: 151.2
    }, {
      lat: -23.4,
      lon: -46.5
    }];
    // Inter-hotspot corridors
    for (var i = 0; i < D.air.length; i++) {
      for (var j = i + 1; j < D.air.length; j++) {
        var a = D.air[i],
          b = D.air[j];
        var from = airCoordsFlight[i],
          to = airCoordsFlight[j];
        if (!from || !to) continue;
        var traffic = a.total + b.total;
        if (traffic < 30) continue;
        var ncRatio = (a.noCallsign + b.noCallsign) / Math.max(traffic, 1);
        var color = ncRatio > 0.15 ? ['rgba(255,95,99,0.6)', 'rgba(255,95,99,0.15)'] : ncRatio > 0.05 ? ['rgba(255,184,76,0.5)', 'rgba(255,184,76,0.1)'] : ['rgba(100,240,200,0.4)', 'rgba(100,240,200,0.08)'];
        arcs.push({
          startLat: from.lat,
          startLng: from.lon,
          endLat: to.lat,
          endLng: to.lon,
          color: color,
          stroke: Math.max(0.3, Math.min(1.2, traffic / 120)),
          label: "".concat(from.region, " \u2194 ").concat(to.region, ": ").concat(traffic, " aircraft")
        });
      }
    }
    // Hub corridors
    D.air.forEach(function (a, i) {
      if (!airCoordsFlight[i] || a.total < 25) return;
      globalHubs.forEach(function (hub) {
        var dLat = Math.abs(airCoordsFlight[i].lat - hub.lat);
        var dLon = Math.abs(airCoordsFlight[i].lon - hub.lon);
        if (dLat + dLon < 20) return;
        arcs.push({
          startLat: airCoordsFlight[i].lat,
          startLng: airCoordsFlight[i].lon,
          endLat: hub.lat,
          endLng: hub.lon,
          color: ['rgba(100,240,200,0.2)', 'rgba(100,240,200,0.05)'],
          stroke: 0.3
        });
      });
    });
  }
  globe.arcsData(arcs);

  // Zoom-aware marker sizing: scale markers and labels with camera altitude
  var onGlobeZoom = function onGlobeZoom() {
    var alt = globe.pointOfView().altitude;
    var sf = Math.max(0.6, Math.min(2.5, 1.5 / alt));
    globe.pointRadius(function (d) {
      return (d.size || 0.3) * sf;
    });
    // Hide labels when zoomed far out to reduce clutter
    var showLabels = alt < 1.8;
    globe.labelSize(function (d) {
      return showLabels ? d.size || 0.4 : 0;
    });
    // Scale arc strokes with zoom
    globe.arcStroke(function (d) {
      return (d.stroke || 0.4) * Math.max(0.5, Math.min(1.5, 1.2 / alt));
    });
    globe.arcDashAnimateTime(lowPerfMode ? 0 : 2000);
    // Priority-based point visibility: hide low-priority markers when zoomed out
    if (alt > 2.0) {
      globe.pointsData(points.filter(function (p) {
        return (p.priority || 3) <= 1;
      }));
    } else if (alt > 1.2) {
      globe.pointsData(points.filter(function (p) {
        return (p.priority || 3) <= 2;
      }));
    } else {
      globe.pointsData(points);
    }
  };
  if (typeof globe.onZoom === 'function') globe.onZoom(onGlobeZoom);
}
function showPopup(event, head, text, meta, lat, lng, alt) {
  var popup = document.getElementById('mapPopup');
  var container = document.getElementById('mapContainer');
  var rect = container.getBoundingClientRect();
  var left, top;
  if (!isFlat && lat != null && globe && typeof globe.getScreenCoords === 'function') {
    var sc = globe.getScreenCoords(lat, lng, alt || 0.01);
    if (!sc || isNaN(sc.x) || isNaN(sc.y) || sc.x < 0 || sc.y < 0 || sc.x > rect.width || sc.y > rect.height) {
      if (event && event.clientX != null) {
        left = event.clientX - rect.left + 10;
        top = event.clientY - rect.top - 10;
      } else return;
    } else {
      left = sc.x + 10;
      top = sc.y - 10;
    }
  } else if (event && event.clientX != null) {
    left = event.clientX - rect.left + 10;
    top = event.clientY - rect.top - 10;
  } else {
    left = rect.width / 2 - 140;
    top = rect.height / 2 - 60;
  }
  if (left + 290 > rect.width) left = left - 300;
  if (top + 150 > rect.height) top = top - 160;
  if (left < 0) left = 10;
  if (top < 0) top = 10;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popup.querySelector('.pp-head').textContent = head || '';
  popup.querySelector('.pp-text').innerHTML = text || '';
  popup.querySelector('.pp-meta').textContent = meta || '';
  popup.classList.add('show');
}
function closePopup() {
  document.getElementById('mapPopup').classList.remove('show');
}

// === MAP CONTROLS ===
function toggleFlights() {
  flightsVisible = !flightsVisible;
  var btn = document.getElementById('flightToggle');
  btn.classList.toggle('off', !flightsVisible);
  if (isFlat) {
    if (flatG) {
      flatG.selectAll('*').remove();
      drawFlatMap();
    }
    return;
  }
  if (!globe) {
    return;
  }
  if (flightsVisible) {
    plotMarkers(); // re-render with arcs
  } else {
    globe.arcsData([]); // hide arcs
    // Remove air-type points
    var pts = globe.pointsData().filter(function (p) {
      return p.type !== 'air';
    });
    globe.pointsData(pts);
    var lbls = globe.labelsData().filter(function (l) {
      return l.text && !l.text.match(/\d+$/);
    });
    globe.labelsData(lbls);
  }
}

// === FLAT/GLOBE TOGGLE ===
var flatRegionBounds = {
  world: [[-180, -60], [180, 80]],
  americas: [[-130, 10], [-60, 55]],
  europe: [[-12, 34], [45, 72]],
  middleEast: [[24, 10], [65, 45]],
  asiaPacific: [[60, -12], [180, 55]],
  africa: [[-20, -36], [55, 38]]
};
function toggleMapMode() {
  isFlat = !isFlat;
  var btn = document.getElementById('projToggle');
  var hint = document.getElementById('mapHint');
  btn.textContent = isFlat ? 'GLOBE MODE' : 'FLAT MODE';
  hint.textContent = isFlat ? 'SCROLL TO ZOOM · DRAG TO PAN' : 'DRAG TO ROTATE · SCROLL TO ZOOM';
  var globeEl = document.getElementById('globeViz');
  var flatEl = document.getElementById('flatMapSvg');
  if (isFlat) {
    if (globe && typeof globe.pauseAnimation === 'function') globe.pauseAnimation();
    globeEl.style.display = 'none';
    flatEl.style.display = 'block';
    setMapLoading(false);
    if (!flatSvg) initFlatMap();else {
      flatG.selectAll('*').remove();
      drawFlatMap();
    }
  } else {
    flatEl.style.display = 'none';
    setMapLoading(true, 'Initializing 3D Globe');
    requestAnimationFrame(function () {
      try {
        initGlobe();
        if (globe && typeof globe.resumeAnimation === 'function') globe.resumeAnimation();
        globeEl.style.display = 'block';
        setMapLoading(false);
      } catch (_unused2) {
        isFlat = true;
        globeEl.style.display = 'none';
        flatEl.style.display = 'block';
        btn.textContent = 'GLOBE MODE';
        hint.textContent = '3D LOAD FAILED · FLAT MODE';
        if (!flatSvg) initFlatMap();else {
          flatG.selectAll('*').remove();
          drawFlatMap();
        }
        setMapLoading(false);
      }
    });
  }
}
function initFlatMap() {
  var container = document.getElementById('mapContainer');
  flatW = container.clientWidth;
  flatH = container.clientHeight || 560;
  flatSvg = d3.select('#flatMapSvg').attr('viewBox', "0 0 ".concat(flatW, " ").concat(flatH)).attr('preserveAspectRatio', 'xMidYMid meet');
  flatProjection = d3.geoNaturalEarth1().fitSize([flatW - 20, flatH - 20], {
    type: 'Sphere'
  }).translate([flatW / 2, flatH / 2]);
  flatPath = d3.geoPath(flatProjection);
  flatG = flatSvg.append('g');
  flatZoom = d3.zoom().scaleExtent([1, 12]).on('zoom', function (event) {
    flatG.attr('transform', event.transform);
    var k = event.transform.k;
    flatG.selectAll('.marker-circle').attr('r', function () {
      return +this.dataset.baseR / Math.sqrt(k);
    });
    flatG.selectAll('.marker-label').style('font-size', Math.max(7, 9 / Math.sqrt(k)) + 'px').style('display', k >= 2.5 ? 'block' : 'none');
  });
  flatSvg.call(flatZoom);
  drawFlatMap();
}
function drawFlatMap() {
  flatG.append('path').datum(d3.geoGraticule()()).attr('class', 'graticule').attr('d', flatPath);
  fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(function (r) {
    return r.json();
  }).then(function (world) {
    var countries = topojson.feature(world, world.objects.countries);
    flatG.selectAll('path.land').data(countries.features).enter().append('path').attr('class', 'land').attr('d', flatPath);
    flatG.append('path').datum(topojson.mesh(world, world.objects.countries, function (a, b) {
      return a !== b;
    })).attr('class', 'border').attr('d', flatPath);
    plotFlatMarkers();
  });
}
function plotFlatMarkers() {
  var _D$noaa2, _D$epa2, _D$space4, _D$gdelt2, _D$acled4;
  var mg = flatG.append('g').attr('class', 'markers');
  var proj = flatProjection;
  var addPt = function addPt(lat, lon, r, fill, stroke, onClick, priority) {
    var _proj = proj([lon, lat]),
      _proj2 = _slicedToArray(_proj, 2),
      x = _proj2[0],
      y = _proj2[1];
    if (!x || !y) return null;
    var g = mg.append('g').attr('transform', "translate(".concat(x, ",").concat(y, ")")).style('cursor', 'pointer').attr('data-priority', priority || 3);
    if (onClick) g.on('click', function (ev) {
      ev.stopPropagation();
      onClick(ev);
    });
    g.append('circle').attr('class', 'marker-circle').attr('r', r).attr('data-base-r', r).attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 0.8);
    return g;
  };
  // Air
  var airCoords = [{
    lat: 30,
    lon: 44
  }, {
    lat: 24,
    lon: 120
  }, {
    lat: 49,
    lon: 32
  }, {
    lat: 57,
    lon: 24
  }, {
    lat: 14,
    lon: 114
  }, {
    lat: 37,
    lon: 127
  }, {
    lat: 25,
    lon: -80
  }, {
    lat: 4,
    lon: 2
  }, {
    lat: -34,
    lon: 18
  }, {
    lat: 10,
    lon: 51
  }];
  if (flightsVisible) {
    D.air.forEach(function (a, i) {
      var c = airCoords[i];
      if (!c) return;
      var g = addPt(c.lat, c.lon, 4 + a.total / 40, 'rgba(100,240,200,0.7)', 'rgba(100,240,200,0.3)', function (ev) {
        return showPopup(ev, a.region, "".concat(a.total, " aircraft<br>No callsign: ").concat(a.noCallsign, "<br>High alt: ").concat(a.highAlt), 'Air Activity');
      }, 1);
      if (g) g.append('text').attr('class', 'marker-label').attr('x', 10).attr('y', 3).attr('fill', 'var(--dim)').attr('font-size', '9px').attr('font-family', 'var(--mono)').text(a.region.replace(' Region', '') + ' ' + a.total);
    });
  }
  // Thermal
  D.thermal.forEach(function (t) {
    return t.fires.forEach(function (f) {
      addPt(f.lat, f.lon, 2 + Math.min(f.frp / 50, 5), 'rgba(255,95,99,0.6)', 'rgba(255,95,99,0.2)', function (ev) {
        return showPopup(ev, 'Thermal', "".concat(t.region, "<br>FRP: ").concat(f.frp.toFixed(1), " MW"), 'FIRMS');
      }, 3);
    });
  });
  // Chokepoints
  D.chokepoints.forEach(function (cp) {
    var _proj3 = proj([cp.lon, cp.lat]),
      _proj4 = _slicedToArray(_proj3, 2),
      x = _proj4[0],
      y = _proj4[1];
    if (!x || !y) return;
    var g = mg.append('g').attr('transform', "translate(".concat(x, ",").concat(y, ")")).style('cursor', 'pointer').attr('data-priority', 1).on('click', function (ev) {
      ev.stopPropagation();
      showPopup(ev, cp.label, cp.note, 'Maritime');
    });
    g.append('rect').attr('x', -4).attr('y', -4).attr('width', 8).attr('height', 8).attr('fill', 'rgba(179,136,255,0.7)').attr('stroke', 'rgba(179,136,255,0.3)').attr('stroke-width', 0.5).attr('transform', 'rotate(45)');
    g.append('text').attr('class', 'marker-label').attr('x', 8).attr('y', 3).attr('fill', 'var(--dim)').attr('font-size', '8px').attr('font-family', 'var(--mono)').text(cp.label);
  });
  // Nuclear
  var nukeCoords = [{
    lat: 47.5,
    lon: 34.6
  }, {
    lat: 51.4,
    lon: 30.1
  }, {
    lat: 28.8,
    lon: 50.9
  }, {
    lat: 39.8,
    lon: 125.8
  }, {
    lat: 37.4,
    lon: 141
  }, {
    lat: 31.0,
    lon: 35.1
  }];
  D.nuke.forEach(function (n, i) {
    var c = nukeCoords[i];
    if (!c) return;
    addPt(c.lat, c.lon, 4, 'rgba(255,224,130,0.7)', 'rgba(255,224,130,0.3)', function (ev) {
      var _n$cpm2;
      return showPopup(ev, n.site, "CPM: ".concat(((_n$cpm2 = n.cpm) === null || _n$cpm2 === void 0 ? void 0 : _n$cpm2.toFixed(1)) || '--'), 'Radiation');
    }, 2);
  });
  // SDR
  D.sdr.zones.forEach(function (z) {
    return z.receivers.forEach(function (r) {
      addPt(r.lat, r.lon, 2.5, 'rgba(68,204,255,0.5)', 'rgba(68,204,255,0.2)', function (ev) {
        return showPopup(ev, 'SDR', "".concat(r.name, "<br>").concat(z.region), 'KiwiSDR');
      }, 3);
    });
  });
  // OSINT
  var osintGeo = [{
    lat: 45,
    lon: 41,
    idx: 0
  }, {
    lat: 48,
    lon: 37,
    idx: 1
  }, {
    lat: 48.5,
    lon: 37.5,
    idx: 2
  }, {
    lat: 45,
    lon: 40.2,
    idx: 3
  }, {
    lat: 50.6,
    lon: 36.6,
    idx: 5
  }, {
    lat: 48.5,
    lon: 35,
    idx: 6
  }];
  osintGeo.forEach(function (o) {
    var p = D.tg.urgent[o.idx];
    if (!p) return;
    addPt(o.lat, o.lon, 4, 'rgba(255,184,76,0.7)', 'rgba(255,184,76,0.3)', function (ev) {
      var _p$text;
      return showPopup(ev, (p.channel || '').toUpperCase(), cleanText(((_p$text = p.text) === null || _p$text === void 0 ? void 0 : _p$text.substring(0, 200)) || ''), "".concat(p.views || '?', " views"));
    }, 2);
  });
  // WHO
  var whoGeo = [{
    lat: 0.3,
    lon: 32.6
  }, {
    lat: -6.2,
    lon: 106.8
  }, {
    lat: -4.3,
    lon: 15.3
  }, {
    lat: 35,
    lon: 105
  }, {
    lat: 12.5,
    lon: 105
  }, {
    lat: 35,
    lon: 105
  }, {
    lat: 28,
    lon: 84
  }, {
    lat: 24,
    lon: 45
  }, {
    lat: 30,
    lon: 70
  }, {
    lat: -0.8,
    lon: 11.6
  }];
  D.who.slice(0, 10).forEach(function (w, i) {
    var c = whoGeo[i];
    if (!c) return;
    addPt(c.lat, c.lon, 3.5, 'rgba(105,240,174,0.6)', 'rgba(105,240,174,0.2)', function (ev) {
      return showPopup(ev, w.title, w.summary || '', 'WHO');
    }, 2);
  });
  // News
  (D.news || []).forEach(function (n) {
    addPt(n.lat, n.lon, 3, 'rgba(129,212,250,0.6)', 'rgba(129,212,250,0.2)', function (ev) {
      return showPopup(ev, n.source + ' NEWS', cleanText(n.title), n.region);
    }, 3);
  });
  // NOAA weather
  (((_D$noaa2 = D.noaa) === null || _D$noaa2 === void 0 ? void 0 : _D$noaa2.alerts) || []).forEach(function (a) {
    addPt(a.lat, a.lon, 4, 'rgba(255,152,0,0.7)', 'rgba(255,152,0,0.3)', function (ev) {
      return showPopup(ev, a.event, a.headline || '', 'NOAA/NWS');
    }, 2);
  });
  // EPA RadNet
  (((_D$epa2 = D.epa) === null || _D$epa2 === void 0 ? void 0 : _D$epa2.stations) || []).forEach(function (s) {
    addPt(s.lat, s.lon, 3, 'rgba(205,220,57,0.6)', 'rgba(205,220,57,0.2)', function (ev) {
      return showPopup(ev, 'RadNet: ' + s.location, "".concat(s.analyte || '--', ": ").concat(s.result || '--', " ").concat(s.unit || ''), 'EPA');
    }, 3);
  });
  // Space stations
  (((_D$space4 = D.space) === null || _D$space4 === void 0 ? void 0 : _D$space4.stationPositions) || []).forEach(function (s) {
    var g = addPt(s.lat, s.lon, 5, 'rgba(255,255,255,0.9)', 'rgba(255,255,255,0.4)', function (ev) {
      return showPopup(ev, s.name, 'Orbital position estimate', 'Space Station');
    }, 1);
    if (g) g.append('text').attr('class', 'marker-label').attr('x', 8).attr('y', 3).attr('fill', 'rgba(255,255,255,0.7)').attr('font-size', '8px').attr('font-family', 'var(--mono)').text(s.name.split('(')[0].trim());
  });
  // GDELT geo events
  (((_D$gdelt2 = D.gdelt) === null || _D$gdelt2 === void 0 ? void 0 : _D$gdelt2.geoPoints) || []).forEach(function (g) {
    addPt(g.lat, g.lon, 2.5, 'rgba(100,149,237,0.5)', 'rgba(100,149,237,0.2)', function (ev) {
      return showPopup(ev, 'GDELT Event', g.name || '', 'GDELT · ' + g.count + ' reports');
    }, 3);
  });
  // ACLED
  (((_D$acled4 = D.acled) === null || _D$acled4 === void 0 ? void 0 : _D$acled4.deadliestEvents) || []).filter(function (e) {
    return e.lat && e.lon;
  }).forEach(function (e) {
    var _proj5 = proj([e.lon, e.lat]),
      _proj6 = _slicedToArray(_proj5, 2),
      x = _proj6[0],
      y = _proj6[1];
    if (!x || !y) return;
    var r = Math.max(4, Math.min(14, 2 + Math.log2(Math.max(e.fatalities, 1)) * 1.5));
    var g = mg.append('g').attr('transform', "translate(".concat(x, ",").concat(y, ")")).style('cursor', 'pointer').attr('data-priority', 1).on('click', function (ev) {
      ev.stopPropagation();
      showPopup(ev, e.type || 'CONFLICT', "".concat(e.fatalities, " fatalities<br>").concat(e.location, ", ").concat(e.country), 'ACLED');
    });
    g.append('circle').attr('class', 'conflict-ring marker-circle').attr('r', r).attr('data-base-r', r).attr('fill', 'none').attr('stroke', 'rgba(255,120,80,0.7)').attr('stroke-width', 1.5);
    g.append('circle').attr('r', r * 0.4).attr('fill', 'rgba(255,120,80,0.3)');
  });
  // Flight corridors
  if (flightsVisible) {
    var airCoordsFlight = [{
      lat: 30,
      lon: 44
    }, {
      lat: 24,
      lon: 120
    }, {
      lat: 49,
      lon: 32
    }, {
      lat: 57,
      lon: 24
    }, {
      lat: 14,
      lon: 114
    }, {
      lat: 37,
      lon: 127
    }, {
      lat: 25,
      lon: -80
    }, {
      lat: 4,
      lon: 2
    }, {
      lat: -34,
      lon: 18
    }, {
      lat: 10,
      lon: 51
    }];
    var hubs = [{
      lat: 40.6,
      lon: -73.8
    }, {
      lat: 51.5,
      lon: -0.5
    }, {
      lat: 25.3,
      lon: 55.4
    }, {
      lat: 1.4,
      lon: 103.8
    }, {
      lat: -33.9,
      lon: 151.2
    }, {
      lat: -23.4,
      lon: -46.5
    }];
    var cG = flatG.append('g').attr('class', 'corridors-layer');
    for (var i = 0; i < D.air.length; i++) {
      for (var j = i + 1; j < D.air.length; j++) {
        var a = D.air[i],
          b = D.air[j],
          from = airCoordsFlight[i],
          to = airCoordsFlight[j];
        if (!from || !to) continue;
        var traffic = a.total + b.total;
        if (traffic < 30) continue;
        var ncR = (a.noCallsign + b.noCallsign) / Math.max(traffic, 1);
        var clr = ncR > 0.15 ? 'rgba(255,95,99,0.4)' : ncR > 0.05 ? 'rgba(255,184,76,0.35)' : 'rgba(100,240,200,0.25)';
        var interp = d3.geoInterpolate([from.lon, from.lat], [to.lon, to.lat]);
        var coords = [];
        for (var k = 0; k <= 40; k++) coords.push(interp(k / 40));
        var feat = {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: coords
          }
        };
        cG.append('path').datum(feat).attr('d', flatPath).attr('fill', 'none').attr('stroke', clr).attr('stroke-width', Math.max(0.8, Math.min(3, traffic / 80)));
      }
    }
    D.air.forEach(function (a, i) {
      if (!airCoordsFlight[i] || a.total < 25) return;
      hubs.forEach(function (hub) {
        if (Math.abs(airCoordsFlight[i].lat - hub.lat) + Math.abs(airCoordsFlight[i].lon - hub.lon) < 20) return;
        var interp = d3.geoInterpolate([airCoordsFlight[i].lon, airCoordsFlight[i].lat], [hub.lon, hub.lat]);
        var coords = [];
        for (var _k = 0; _k <= 40; _k++) coords.push(interp(_k / 40));
        cG.append('path').datum({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: coords
          }
        }).attr('d', flatPath).attr('fill', 'none').attr('stroke', 'rgba(100,240,200,0.15)').attr('stroke-width', 0.6);
      });
    });
  }
}

// Update setRegion for flat mode
var _origSetRegion = setRegion;

// Override mapZoom for flat mode
var _origMapZoom = mapZoom;
function setRegion(r) {
  currentRegion = r;
  document.querySelectorAll('.region-btn').forEach(function (b) {
    return b.classList.toggle('active', b.dataset.region === r);
  });
  closePopup();
  if (isFlat && flatSvg && flatZoom) {
    if (r === 'world') {
      flatSvg.transition().duration(750).call(flatZoom.transform, d3.zoomIdentity);
      return;
    }
    var bounds = flatRegionBounds[r];
    var p0 = flatProjection(bounds[0]),
      p1 = flatProjection(bounds[1]);
    if (!p0 || !p1) return;
    var dx = Math.abs(p1[0] - p0[0]),
      dy = Math.abs(p1[1] - p0[1]);
    var cx = (p0[0] + p1[0]) / 2,
      cy = (p0[1] + p1[1]) / 2;
    var scale = Math.min(flatW / dx, flatH / dy) * 0.85;
    flatSvg.transition().duration(750).call(flatZoom.transform, d3.zoomIdentity.translate(flatW / 2 - scale * cx, flatH / 2 - scale * cy).scale(scale));
  } else {
    var pov = regionPOV[r] || regionPOV.world;
    globe.pointOfView(pov, 1000);
  }
}
function mapZoom(factor) {
  if (isFlat && flatSvg && flatZoom) {
    flatSvg.transition().duration(300).call(flatZoom.scaleBy, factor);
  } else if (globe) {
    var pov = globe.pointOfView();
    globe.pointOfView({
      altitude: pov.altitude / factor
    }, 300);
  }
}

// Sparkline SVG generator
function mkSparkSvg(values, isGood) {
  if (!values || values.length < 2) return '';
  var w = 52,
    h = 18,
    pad = 2;
  var min = Math.min.apply(Math, _toConsumableArray(values)),
    max = Math.max.apply(Math, _toConsumableArray(values));
  var range = max - min || 1;
  var pts = values.map(function (v, i) {
    var x = pad + i / (values.length - 1) * (w - pad * 2);
    var y = pad + (max - v) / range * (h - pad * 2);
    return "".concat(x.toFixed(1), ",").concat(y.toFixed(1));
  });
  var cls = isGood ? 'spark-good' : 'spark-bad';
  var last = pts[pts.length - 1];
  return "<svg class=\"spark-svg\" viewBox=\"0 0 ".concat(w, " ").concat(h, "\"><polyline class=\"spark-line ").concat(cls, "\" points=\"").concat(pts.join(' '), "\"/><circle class=\"").concat(cls, " spark-dot\" cx=\"").concat(last.split(',')[0], "\" cy=\"").concat(last.split(',')[1], "\" r=\"2\" fill=\"").concat(isGood ? 'var(--accent)' : 'var(--danger)', "\"/></svg>");
}

// === LOWER GRID ===
function renderLower() {
  var _D$energy, _D$energy2, _D$energy3, _cpi$momChangePct, _metals$goldChangePct, _metals$silverChangeP;
  var mobile = isMobileLayout();
  var spread = D.fred.find(function (f) {
    return f.id === 'T10Y2Y';
  });
  var ff = D.fred.find(function (f) {
    return f.id === 'DFF';
  });
  var ue = D.bls.find(function (b) {
    return b.id === 'LNS14000000';
  });
  var cpi = D.bls.find(function (b) {
    return b.id === 'CUUR0000SA0';
  });
  var payrolls = D.bls.find(function (b) {
    return b.id === 'CES0000000001';
  });
  var gscpi = D.gscpi;
  var mkt = D.markets || {};
  var metals = D.metals || {};
  var wtiH = D.energy.wtiRecent || [];
  var wtiMax = Math.max.apply(Math, _toConsumableArray(wtiH)),
    wtiMin = Math.min.apply(Math, _toConsumableArray(wtiH));
  var sparkHtml = wtiH.map(function (v) {
    var pct = wtiMax === wtiMin ? 50 : (v - wtiMin) / (wtiMax - wtiMin) * 100;
    return "<div class=\"spark-bar\" style=\"height:".concat(Math.max(pct, 8), "%\"></div>");
  }).join('');

  // Helper: format market quote card
  var mktCard = function mktCard(q) {
    if (!q || q.error) return '';
    var clr = q.changePct >= 0 ? 'var(--accent)' : 'var(--warn)';
    var arrow = q.changePct >= 0 ? '&#9650;' : '&#9660;';
    return "<div class=\"mc\"><div class=\"ml\">".concat(q.name || q.symbol, "</div><span class=\"mv\" style=\"color:").concat(clr, "\">").concat(q.symbol.includes('BTC') || q.symbol.includes('ETH') ? '$' + q.price.toLocaleString() : '$' + q.price, "</span><span class=\"ms\" style=\"color:").concat(clr, "\">").concat(arrow, " ").concat(q.changePct >= 0 ? '+' : '').concat(q.changePct, "%</span></div>");
  };

  // VIX from Yahoo Finance live data (fallback to FRED)
  var vixLive = mkt.vix;
  var vixFred = D.fred.find(function (f) {
    return f.id === 'VIXCLS';
  });
  var vixVal = (vixLive === null || vixLive === void 0 ? void 0 : vixLive.value) || (vixFred === null || vixFred === void 0 ? void 0 : vixFred.value);
  var vixChg = (vixLive === null || vixLive === void 0 ? void 0 : vixLive.changePct) != null ? "".concat(vixLive.changePct >= 0 ? '+' : '').concat(vixLive.changePct, "%") : '';
  var fmtMarketPrice = function fmtMarketPrice(price) {
    return price != null ? "$".concat(price.toLocaleString(undefined, {
      maximumFractionDigits: 2
    })) : '--';
  };
  var dayMove = function dayMove(pct) {
    return pct != null ? "".concat(pct >= 0 ? '+' : '').concat(pct, "% today") : '';
  };
  var metrics = [{
    l: 'WTI Crude',
    v: "$".concat((_D$energy = D.energy) === null || _D$energy === void 0 ? void 0 : _D$energy.wti),
    s: '$/bbl',
    p: 70
  }, {
    l: 'Brent',
    v: "$".concat((_D$energy2 = D.energy) === null || _D$energy2 === void 0 ? void 0 : _D$energy2.brent),
    s: '$/bbl',
    p: 75
  }, {
    l: 'Nat Gas',
    v: "$".concat(((_D$energy3 = D.energy) === null || _D$energy3 === void 0 ? void 0 : _D$energy3.natgas) || '--'),
    s: '$/MMBtu',
    p: 30
  }, {
    l: 'VIX',
    v: vixVal ? vixVal.toFixed(1) : '--',
    s: vixChg || 'volatility index',
    p: vixVal ? Math.min(vixVal * 2.5, 100) : 30
  }, {
    l: 'Fed Funds',
    v: ff ? "".concat(ff.value, "%") : '--',
    s: (ff === null || ff === void 0 ? void 0 : ff.date) || '',
    p: 36
  }, {
    l: 'GSCPI',
    v: gscpi ? gscpi.value.toFixed(2) : '--',
    s: (gscpi === null || gscpi === void 0 ? void 0 : gscpi.interpretation) || '',
    p: 49
  }, {
    l: 'CPI MoM',
    v: cpi ? "+".concat((_cpi$momChangePct = cpi.momChangePct) === null || _cpi$momChangePct === void 0 ? void 0 : _cpi$momChangePct.toFixed(2), "%") : '--',
    s: (cpi === null || cpi === void 0 ? void 0 : cpi.date) || '',
    p: 37
  }, {
    l: 'Unemployment',
    v: ue ? "".concat(ue.value, "%") : '--',
    s: ue ? "".concat(ue.momChange > 0 ? '+' : '').concat(ue.momChange, " vs prior") : '',
    p: 44
  }];
  var metalsMetrics = [{
    l: 'Gold',
    v: fmtMarketPrice(metals.gold),
    s: dayMove(metals.goldChangePct) || 'COMEX proxy',
    p: 58
  }, {
    l: 'Silver',
    v: fmtMarketPrice(metals.silver),
    s: dayMove(metals.silverChangePct) || 'COMEX proxy',
    p: 54
  }];

  // Attach sparklines from FRED recent data
  var fredSpark = function fredSpark(id, up) {
    var _f$recent;
    var f = D.fred.find(function (f) {
      return f.id === id;
    });
    return (f === null || f === void 0 || (_f$recent = f.recent) === null || _f$recent === void 0 ? void 0 : _f$recent.length) > 1 ? {
      spark: f.recent,
      sparkUp: up
    } : {};
  };
  metalsMetrics[0] = _objectSpread(_objectSpread({}, metalsMetrics[0]), {}, {
    spark: metals.goldRecent,
    sparkUp: ((_metals$goldChangePct = metals.goldChangePct) !== null && _metals$goldChangePct !== void 0 ? _metals$goldChangePct : 0) >= 0
  });
  metalsMetrics[1] = _objectSpread(_objectSpread({}, metalsMetrics[1]), {}, {
    spark: metals.silverRecent,
    sparkUp: ((_metals$silverChangeP = metals.silverChangePct) !== null && _metals$silverChangeP !== void 0 ? _metals$silverChangeP : 0) >= 0
  });

  // Build live market cards from Yahoo Finance
  var indexCards = (mkt.indexes || []).map(mktCard).join('');
  var cryptoCards = (mkt.crypto || []).map(mktCard).join('');
  var rateCards = (mkt.rates || []).map(mktCard).join('');
  var hasMarkets = indexCards || cryptoCards;
  var srcHtml = D.health.map(function (s) {
    return "<div class=\"src-item\"><div class=\"sd ".concat(s.err ? 'err' : 'ok', "\"></div><span>").concat(s.n, "</span></div>");
  }).join('');

  // NEWS TICKER — merges RSS + GDELT + Telegram into flowing cards (moved from right rail)
  var feed = (D.newsFeed || []).slice(0, 20);
  var srcClass = function srcClass(s) {
    if (!s) return 'other';
    var sl = s.toLowerCase();
    // Africa-focused sources first (before generic DW/NYT)
    if (sl.includes('dw africa') || sl.includes('africa news') || sl.includes('nyt africa') || sl.includes('rfi')) return 'af';
    if (sl.includes('mercopress')) return 'sa';
    if (sl.includes('indian express') || sl.includes('the hindu')) return 'ind';
    if (sl.includes('sbs')) return 'anz';
    if (sl.includes('bbc')) return 'bbc';
    if (sl.includes('jazeera') || sl.includes('alj')) return 'alj';
    if (sl.includes('gdelt')) return 'gdelt';
    if (sl.includes('telegram')) return 'tg';
    if (sl.includes('npr')) return 'us';
    if (sl.includes('dw') || sl.includes('deutsche')) return 'dw';
    if (sl.includes('france') || sl.includes('euronews')) return 'eu';
    if (sl.includes('nyt') || sl.includes('times')) return 'nyt';
    return 'other';
  };
  var tickerCards = feed.map(function (n) {
    var sc = srcClass(n.source);
    var age = n.timestamp ? getAge(n.timestamp) : '';
    var urlAttr = n.url ? " data-url=\"".concat(String(n.url).replace(/&/g, '&amp;').replace(/"/g, '&quot;'), "\"") : '';
    return "<div class=\"tk-card ".concat(n.urgent ? 'urgent' : '', " ").concat(n.url ? 'clickable' : '', "\"").concat(urlAttr, "><span class=\"tk-src ").concat(sc, "\">").concat((n.source || 'NEWS').substring(0, 12), "</span><span class=\"tk-time\">").concat(age, "</span><div class=\"tk-head\">").concat(cleanText(n.headline || ''), "</div>").concat(n.url ? '<span class="tk-link">&#8599;</span>' : '', "</div>");
  }).join('');
  var tickerDuration = Math.max(20, feed.length * 2.5);

  // Leverageable Ideas (LLM-only feature)
  var hasIdeas = D.ideas && D.ideas.length > 0;
  var ideasHtml = hasIdeas ? (D.ideas || []).map(function (idea) {
    return "\n    <div class=\"idea-card\">\n      <span class=\"idea-type ".concat((idea.type || '').toLowerCase(), "\">").concat((idea.type || '').toUpperCase(), "</span>\n      ").concat(idea.ticker ? "<span class=\"idea-horizon\">".concat(idea.ticker, "</span>") : '', "\n      ").concat(idea.horizon ? "<span class=\"idea-horizon\">".concat(idea.horizon, "</span>") : '', "\n      <span class=\"idea-conf\">").concat(idea.confidence, " confidence</span>\n      <div class=\"idea-title\">").concat(idea.title, "</div>\n      <div class=\"idea-text\">").concat(idea.text || idea.rationale || '', "</div>\n      ").concat(idea.risk ? "<div class=\"idea-text\" style=\"color:var(--warn);margin-top:3px\">Risk: ".concat(idea.risk, "</div>") : '', "\n    </div>");
  }).join('') : "<div style=\"padding:20px;text-align:center;color:var(--dim);font-family:var(--mono);font-size:11px\">\n      <div style=\"font-size:24px;margin-bottom:8px;opacity:0.3\">&#9888;</div>\n      <div>LLM NOT CONFIGURED</div>\n      <div style=\"font-size:9px;margin-top:6px;opacity:0.6\">Set LLM_PROVIDER + credentials in .env to enable AI-powered trade ideas</div>\n    </div>";
  var tickerPanel = "<div class=\"g-panel lp-ticker\" style=\"display:flex;flex-direction:column\">\n      <div class=\"sec-head\"><h3>".concat(t('panels.newsTicker', 'Live News Ticker'), "</h3><span class=\"badge\">").concat(feed.length, " ").concat(t('badges.items', 'ITEMS'), "</span></div>\n      <div class=\"ticker-wrap\" style=\"--ticker-duration:").concat(tickerDuration, "s\">\n        <div class=\"ticker-track\">").concat(tickerCards).concat(lowPerfMode ? '' : tickerCards, "</div>\n      </div>\n    </div>");
  var osintPanel = mobile ? buildOsintPanel('lp-osint', 240) : '';
  var macroPanel = "<div class=\"g-panel lp-macro\">\n      <div class=\"sec-head\"><h3>".concat(t('panels.macroMarkets', 'Macro + Markets'), "</h3><span class=\"badge\">").concat(mkt.timestamp ? t('badges.live', 'LIVE') : t('badges.delayed', 'DELAYED'), "</span></div>\n      ").concat(hasMarkets ? "<div style=\"margin-bottom:8px\">\n        <div style=\"font-family:var(--mono);font-size:9px;color:var(--dim);margin-bottom:4px;letter-spacing:1px\">INDEXES</div>\n        <div class=\"metrics-row\">".concat(indexCards, "</div>\n      </div>\n      <div style=\"margin-bottom:8px\">\n        <div style=\"font-family:var(--mono);font-size:9px;color:var(--dim);margin-bottom:4px;letter-spacing:1px\">METALS</div>\n        <div class=\"metrics-row\">").concat(metalsMetrics.map(function (m) {
    var sparkSvg = m.spark ? mkSparkSvg(m.spark, m.sparkUp) : '';
    return "<div class=\"mc\"><div class=\"ml\">".concat(m.l, "</div><span class=\"mv\">").concat(m.v).concat(sparkSvg, "</span><span class=\"ms\">").concat(m.s, "</span><div class=\"mbar\"><span style=\"width:").concat(m.p, "%\"></span></div></div>");
  }).join(''), "</div>\n      </div>\n      <div style=\"margin-bottom:8px\">\n        <div style=\"font-family:var(--mono);font-size:9px;color:var(--dim);margin-bottom:4px;letter-spacing:1px\">CRYPTO</div>\n        <div class=\"metrics-row\">").concat(cryptoCards, "</div>\n      </div>") : '', "\n      <div style=\"margin-bottom:8px\">\n        <div style=\"font-family:var(--mono);font-size:9px;color:var(--dim);margin-bottom:4px;letter-spacing:1px\">ENERGY + MACRO</div>\n        <div class=\"metrics-row\">").concat(metrics.map(function (m) {
    var sparkSvg = m.spark ? mkSparkSvg(m.spark, m.sparkUp) : '';
    return "<div class=\"mc\"><div class=\"ml\">".concat(m.l, "</div><span class=\"mv\">").concat(m.v).concat(sparkSvg, "</span><span class=\"ms\">").concat(m.s, "</span><div class=\"mbar\"><span style=\"width:").concat(m.p, "%\"></span></div></div>");
  }).join(''), "</div>\n      </div>\n      <div style=\"margin-top:6px\">\n        <div style=\"font-family:var(--mono);font-size:10px;color:var(--dim);margin-bottom:4px\">WTI 5-DAY</div>\n        <div class=\"spark\">").concat(sparkHtml, "</div>\n      </div>\n    </div>");
  var ideasPanel = "<div class=\"g-panel lp-ideas\">\n      <div class=\"sec-head\"><h3>".concat(t('panels.tradeIdeas', 'Leverageable Ideas'), "</h3>").concat(D.ideasSource === 'llm' ? '<span class="ideas-src llm">' + t('ideas.aiEnhanced', 'AI ENHANCED') + '</span>' : D.ideasSource === 'disabled' ? '<span class="ideas-src static">' + t('ideas.llmOff', 'LLM OFF') + '</span>' : '<span class="ideas-src static">' + t('ideas.pending', 'PENDING') + '</span>', "</div>\n      ").concat(ideasHtml, "\n      <div class=\"disclosure\">FOR INFORMATIONAL PURPOSES ONLY. This is not financial advice, a recommendation to buy or sell any security, or a solicitation of any kind. All signal-based observations are derived from publicly available OSINT data and should not be relied upon for investment decisions. Consult a licensed financial advisor before making any investment. Past performance does not guarantee future results.</div>\n    </div>");
  document.getElementById('lowerGrid').innerHTML = "".concat(tickerPanel).concat(osintPanel).concat(macroPanel).concat(ideasPanel);
}

// === RIGHT RAIL ===
function renderRight() {
  var _delta$signals, _delta$signals2, _delta$signals3;
  var mobile = isMobileLayout();
  // CROSS-SOURCE SIGNALS — moved from lower grid to right rail
  var signals = D.tSignals.slice(0, 6).map(function (s, i) {
    return "<div class=\"signal-row\"><strong>Signal ".concat(i + 1, "</strong><p>").concat(s, "</p></div>");
  }).join('');

  // OSINT TICKER — Telegram + WHO as flowing cards
  var signalMetrics = [{
    l: 'Incident Tempo',
    v: D.tg.urgent.length,
    p: 70
  }, {
    l: 'Air Theaters',
    v: D.air.length,
    p: 60
  }, {
    l: 'Thermal Spikes',
    v: D.thermal.reduce(function (s, t) {
      return s + t.hc;
    }, 0),
    p: 80
  }, {
    l: 'SDR Nodes',
    v: D.sdr.total,
    p: 92
  }, {
    l: 'Chokepoints',
    v: D.chokepoints.length,
    p: 50
  }, {
    l: 'WHO Alerts',
    v: D.who.length,
    p: 40
  }];

  // DELTA PANEL — what changed since last sweep
  var delta = D.delta || {};
  var ds = delta.summary || {};
  var hasDelta = ds.totalChanges > 0;
  var dirEmoji = {
    'risk-off': '&#9650;',
    'risk-on': '&#9660;',
    'mixed': '&#9670;'
  }[ds.direction] || '&#9670;';
  var dirClass = {
    'risk-off': 'up',
    'risk-on': 'down',
    'mixed': ''
  }[ds.direction] || '';
  var escalated = (((_delta$signals = delta.signals) === null || _delta$signals === void 0 ? void 0 : _delta$signals.escalated) || []).slice(0, 6);
  var deescalated = (((_delta$signals2 = delta.signals) === null || _delta$signals2 === void 0 ? void 0 : _delta$signals2.deescalated) || []).slice(0, 4);
  var newSigs = (((_delta$signals3 = delta.signals) === null || _delta$signals3 === void 0 ? void 0 : _delta$signals3["new"]) || []).slice(0, 4);
  var deltaRows = [];
  var _iterator2 = _createForOfIteratorHelper(newSigs),
    _step2;
  try {
    for (_iterator2.s(); !(_step2 = _iterator2.n()).done;) {
      var s = _step2.value;
      deltaRows.push("<div class=\"delta-row new\"><span class=\"delta-badge new\">NEW</span><span class=\"delta-label\">".concat(s.reason || s.label || s.key, "</span></div>"));
    }
  } catch (err) {
    _iterator2.e(err);
  } finally {
    _iterator2.f();
  }
  var _iterator3 = _createForOfIteratorHelper(escalated),
    _step3;
  try {
    for (_iterator3.s(); !(_step3 = _iterator3.n()).done;) {
      var _s = _step3.value;
      var sev = _s.severity === 'critical' ? 'style="color:var(--warn);font-weight:600"' : _s.severity === 'high' ? 'style="color:#ffab40"' : '';
      var val = _s.pctChange !== undefined ? "".concat(_s.pctChange > 0 ? '+' : '').concat(_s.pctChange, "%") : "".concat(_s.change > 0 ? '+' : '').concat(_s.change);
      deltaRows.push("<div class=\"delta-row\"><span class=\"delta-badge up\">&#9650;</span><span class=\"delta-label\" ".concat(sev, ">").concat(_s.label, "</span><span class=\"delta-val\">").concat(_s.from, "\u2192").concat(_s.to, " (").concat(val, ")</span></div>"));
    }
  } catch (err) {
    _iterator3.e(err);
  } finally {
    _iterator3.f();
  }
  var _iterator4 = _createForOfIteratorHelper(deescalated),
    _step4;
  try {
    for (_iterator4.s(); !(_step4 = _iterator4.n()).done;) {
      var _s2 = _step4.value;
      var _val = _s2.pctChange !== undefined ? "".concat(_s2.pctChange, "%") : "".concat(_s2.change);
      deltaRows.push("<div class=\"delta-row\"><span class=\"delta-badge down\">&#9660;</span><span class=\"delta-label\">".concat(_s2.label || _s2.key, "</span><span class=\"delta-val\">").concat(_s2.from, "\u2192").concat(_s2.to, " (").concat(_val, ")</span></div>"));
    }
  } catch (err) {
    _iterator4.e(err);
  } finally {
    _iterator4.f();
  }
  var deltaHtml = hasDelta ? deltaRows.join('') : "<div style=\"padding:12px;text-align:center;color:var(--dim);font-family:var(--mono);font-size:10px\">".concat(t('delta.noChanges', 'No changes since last sweep'), "</div>");
  document.getElementById('rightRail').innerHTML = "\n    <div class=\"g-panel right-signals\">\n      <div class=\"sec-head\"><h3>".concat(t('panels.crossSourceSignals', 'Cross-Source Signals'), "</h3><span class=\"badge\">").concat(t('badges.worldview', 'WORLDVIEW'), "</span></div>\n      ").concat(signals, "\n    </div>\n    ").concat(mobile ? '' : buildOsintPanel('right-osint', 260), "\n    <div class=\"g-panel right-core\">\n      <div class=\"sec-head\"><h3>").concat(t('panels.signalCore', 'Signal Core'), "</h3><span class=\"badge\">").concat(t('badges.hotMetrics', 'HOT METRICS'), "</span></div>\n      ").concat(signalMetrics.map(function (s) {
    return "<div class=\"sm\"><span class=\"sml\">".concat(s.l, "</span><div class=\"smb\"><span style=\"width:").concat(s.p, "%\"></span></div><span class=\"smv\">").concat(s.v, "</span></div>");
  }).join(''), "\n    </div>\n    <div class=\"g-panel right-delta\">\n      <div class=\"sec-head\"><h3>").concat(t('panels.sweepDelta', 'Sweep Delta'), "</h3><span class=\"badge ").concat(dirClass, "\">").concat(dirEmoji, " ").concat(ds.direction ? t('delta.' + ds.direction, ds.direction.toUpperCase()) : t('delta.baseline', 'BASELINE'), "</span></div>\n      ").concat(hasDelta ? "<div style=\"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;font-family:var(--mono);font-size:10px\">\n        <span style=\"color:var(--dim)\">".concat(t('delta.changes', 'Changes'), ": <span style=\"color:var(--accent)\">").concat(ds.totalChanges, "</span></span>\n        <span style=\"color:var(--dim)\">").concat(t('delta.critical', 'Critical'), ": <span style=\"color:").concat(ds.criticalChanges > 0 ? 'var(--warn)' : 'var(--dim)', "\">").concat(ds.criticalChanges || 0, "</span></span>\n        ").concat(ds.signalBreakdown ? "<span style=\"color:var(--dim)\">".concat(t('delta.new', 'New'), ": <span style=\"color:#4dd0e1\">").concat(ds.signalBreakdown["new"], "</span> &#8593;").concat(ds.signalBreakdown.escalated, " &#8595;").concat(ds.signalBreakdown.deescalated, "</span>") : '', "\n      </div>") : '', "\n      <div class=\"delta-list\">").concat(deltaHtml, "</div>\n    </div>");
}

// === HELPERS ===
function getAge(d) {
  var ms = Date.now() - new Date(d).getTime();
  var h = Math.floor(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function cleanText(t) {
  return t.replace(/&#39;/g, "'").replace(/&#33;/g, "!").replace(/&amp;/g, "&").replace(/<[^>]+>/g, '');
}
function safeExternalUrl(raw) {
  try {
    var u = new URL(raw, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch (_unused3) {
    return null;
  }
}

// === BOOT SEQUENCE ===
function runBoot() {
  var _D$acled5;
  var acledStatus = ((_D$acled5 = D.acled) === null || _D$acled5 === void 0 ? void 0 : _D$acled5.totalEvents) > 0 ? "<span class=\"ok\">".concat(D.acled.totalEvents, " EVENTS</span>") : '<span style="color:var(--warn)">DEGRADED</span>';
  var lines = [{
    text: t('boot.initializing', 'INITIALIZING CRUCIX ENGINE v2.1.0'),
    delay: 0
  }, {
    text: t('boot.connecting', 'CONNECTING {count} OSINT SOURCES...').replace('{count}', D.meta.sourcesQueried),
    delay: 400
  }, {
    text: '&#9500;&#9472; ' + t('boot.sourceGroup1', 'OPENSKY · FIRMS · KIWISDR · MARITIME'),
    delay: 700
  }, {
    text: '&#9500;&#9472; ' + t('boot.sourceGroup2', 'FRED · BLS · EIA · TREASURY · GSCPI'),
    delay: 900
  }, {
    text: '&#9500;&#9472; ' + t('boot.sourceGroup3', 'TELEGRAM · SAFECAST · EPA · WHO · OFAC'),
    delay: 1100
  }, {
    text: '&#9492;&#9472; ' + t('boot.sourceGroup4', 'GDELT · NOAA · PATENTS · BLUESKY · REDDIT'),
    delay: 1300
  }, {
    text: t('boot.sweepComplete', 'SWEEP COMPLETE — {ok}/{total} SOURCES').replace('{ok}', "<span class=\"count\">".concat(D.meta.sourcesOk, "</span>")).replace('{total}', D.meta.sourcesQueried) + ' <span class="ok">' + t('boot.ok', 'OK') + '</span>',
    delay: 1700
  }, {
    text: t('boot.acledLayer', 'ACLED CONFLICT LAYER') + ': ' + acledStatus,
    delay: 1900
  }, {
    text: t('boot.flightCorridors', 'FLIGHT CORRIDORS') + ': <span class="ok">' + t('boot.active', 'ACTIVE') + '</span> &#183; ' + t('boot.dualProjection', 'DUAL PROJECTION') + ': <span class="ok">' + t('boot.ready', 'READY') + '</span>',
    delay: 2100
  }, {
    text: t('boot.intelligenceSynthesis', 'INTELLIGENCE SYNTHESIS') + ': <span class="ok">' + t('boot.active', 'ACTIVE') + '</span>',
    delay: 2400
  }];
  var container = document.getElementById('bootLines');
  document.getElementById('bootFinal').textContent = t('dashboard.terminalActive', 'TERMINAL ACTIVE');
  var tl = gsap.timeline();
  tl.to('.logo-ring', {
    opacity: 1,
    duration: 0.6,
    ease: 'power2.out'
  }, 0);
  tl.to(container, {
    opacity: 1,
    duration: 0.3
  }, 0.3);
  lines.forEach(function (line) {
    tl.call(function () {
      var div = document.createElement('div');
      div.innerHTML = line.text;
      div.style.opacity = '0';
      container.appendChild(div);
      gsap.to(div, {
        opacity: 1,
        duration: 0.2
      });
    }, [], line.delay / 1000 + 0.5);
  });
  tl.to('#bootFinal', {
    opacity: 1,
    duration: 0.4
  }, 3.1);
  tl.to('#boot', {
    opacity: 0,
    duration: 0.5,
    ease: 'power2.in'
  }, 3.7);
  tl.set('#boot', {
    display: 'none'
  }, 4.2);
  tl.to('#bgRadial', {
    opacity: 1,
    duration: 1
  }, 3.8);
  tl.to('#bgGrid', {
    opacity: 1,
    duration: 1.2
  }, 4.0);
  tl.to('#scanline', {
    opacity: 1,
    duration: 0.8
  }, 4.3);
  tl.to('#main', {
    opacity: 1,
    duration: 0.6
  }, 3.9);
  tl.call(function () {
    gsap.from('.g-panel,.topbar,.map-container', {
      opacity: 0,
      y: 20,
      scale: 0.97,
      duration: 0.5,
      stagger: 0.06,
      ease: 'power2.out'
    });
    setTimeout(function () {
      return gsap.from('.layer-item,.site-row,.econ-row', {
        opacity: 0,
        x: -12,
        duration: 0.25,
        stagger: 0.03,
        ease: 'power1.out'
      });
    }, 500);
    setTimeout(function () {
      return gsap.from('.ic', {
        opacity: 0,
        y: 12,
        duration: 0.25,
        stagger: 0.03,
        ease: 'power1.out'
      });
    }, 600);
    setTimeout(function () {
      return gsap.from('.mc', {
        opacity: 0,
        y: 8,
        duration: 0.25,
        stagger: 0.04,
        ease: 'power1.out'
      });
    }, 800);
    setTimeout(function () {
      return gsap.from('.idea-card', {
        opacity: 0,
        x: 12,
        duration: 0.3,
        stagger: 0.06,
        ease: 'power1.out'
      });
    }, 900);
    setTimeout(function () {
      document.querySelectorAll('.mbar span,.smb span').forEach(function (bar) {
        var w = bar.style.width;
        bar.style.width = '0%';
        gsap.to(bar, {
          width: w,
          duration: 1,
          ease: 'power2.out'
        });
      });
      document.querySelectorAll('.spark-bar').forEach(function (bar) {
        var h = bar.style.height;
        bar.style.height = '0%';
        gsap.to(bar, {
          height: h,
          duration: 0.8,
          ease: 'power2.out'
        });
      });
    }, 1000);
  }, [], 4.0);
}
function isMobileLayout() {
  return window.innerWidth <= 1100;
}
function buildOsintPanel() {
  var panelClass = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : '';
  var maxHeight = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 260;
  var allPosts = [].concat(_toConsumableArray(D.tg.urgent), _toConsumableArray(D.tg.topPosts)).sort(function (a, b) {
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  var whoItems = D.who.slice(0, 4).map(function (w) {
    return {
      channel: 'WHO ALERT',
      text: w.title,
      date: w.date,
      isWho: true
    };
  });
  var osintItems = [].concat(_toConsumableArray(allPosts.slice(0, 15)), _toConsumableArray(whoItems));
  var osintCards = osintItems.map(function (p) {
    var isU = p.urgentFlags && p.urgentFlags.length > 0;
    var views = p.views ? p.views >= 1000 ? "".concat((p.views / 1000).toFixed(0), "K") : p.views : '';
    var age = p.date ? getAge(p.date) : '';
    var flags = (p.urgentFlags || []).map(function (f) {
      return "<span class=\"tk-src tg\" style=\"margin-right:2px\">".concat(f, "</span>");
    }).join('');
    var srcCls = p.isWho ? 'style="color:#69f0ae;border-color:rgba(105,240,174,0.4)"' : 'class="tk-src tg"';
    return "<div class=\"tk-card ".concat(isU ? 'urgent' : '', "\"><span ").concat(srcCls, ">").concat((p.channel || 'OSINT').toUpperCase().substring(0, 14), "</span>").concat(views ? "<span class=\"tk-src other\">".concat(views, "</span>") : '', "<span class=\"tk-time\">").concat(age, "</span>").concat(flags, "<div class=\"tk-head\">").concat(cleanText((p.text || '').substring(0, 160)), "</div></div>");
  }).join('');
  var osintDuration = Math.max(25, osintItems.length * 3);
  return "<div class=\"g-panel ".concat(panelClass, "\" style=\"display:flex;flex-direction:column\">\n      <div class=\"sec-head\"><h3>").concat(t('panels.osintStream', 'OSINT Stream'), "</h3><span class=\"badge\">").concat(D.tg.urgent.length, " ").concat(t('badges.urgent', 'URGENT'), "</span></div>\n      <div class=\"ticker-wrap\" style=\"--ticker-duration:").concat(osintDuration, "s;max-height:").concat(maxHeight, "px\">\n        <div class=\"ticker-track\">").concat(osintCards).concat(lowPerfMode ? '' : osintCards, "</div>\n      </div>\n    </div>");
}
function renderGlossary() {
  var body = document.getElementById('glossaryBody');
  if (!body) return;
  body.innerHTML = signalGuideItems.map(function (item) {
    return "\n    <div class=\"glossary-card\">\n      <div class=\"glossary-term\">\n        <strong>".concat(item.term, "</strong>\n        <span class=\"glossary-tag\">").concat(item.category, "</span>\n      </div>\n      <div class=\"glossary-line\"><span class=\"glossary-label\">Meaning</span>").concat(item.meaning, "</div>\n      <div class=\"glossary-line\"><span class=\"glossary-label\">Why it matters</span>").concat(item.matters, "</div>\n      <div class=\"glossary-line\"><span class=\"glossary-label\">Not proof of</span>").concat(item.notMeaning, "</div>\n      <div class=\"glossary-line\"><span class=\"glossary-label\">Example</span>").concat(item.example, "</div>\n    </div>\n  ");
  }).join('');
}
function openGlossary() {
  var overlay = document.getElementById('glossaryOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  document.body.style.overflow = 'hidden';
}
function closeGlossary() {
  var overlay = document.getElementById('glossaryOverlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  document.body.style.overflow = '';
}
function refreshMapViewport() {
  var forceGlobeReflow = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
  var container = document.getElementById('mapContainer');
  if (!container) return;
  var width = container.clientWidth;
  var height = container.clientHeight || (isMobileLayout() ? 420 : 560);
  if (globe) {
    globe.width(width).height(height);
    if (forceGlobeReflow && !isFlat) {
      var globeEl = document.getElementById('globeViz');
      globeEl.style.display = 'none';
      requestAnimationFrame(function () {
        globeEl.style.display = 'block';
        globe.width(width).height(height);
      });
    }
  }
  if (flatSvg) {
    flatW = width;
    flatH = height;
    flatSvg.attr('viewBox', "0 0 ".concat(flatW, " ").concat(flatH)).attr('preserveAspectRatio', 'xMidYMid meet');
    if (flatProjection && flatG) {
      flatProjection = d3.geoNaturalEarth1().fitSize([flatW - 20, flatH - 20], {
        type: 'Sphere'
      }).translate([flatW / 2, flatH / 2]);
      flatPath = d3.geoPath(flatProjection);
      flatG.selectAll('*').remove();
      drawFlatMap();
    }
  }
}
var lastResponsiveMobile = null;
function syncResponsiveLayout() {
  var force = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
  var mobileNow = isMobileLayout();
  if (force || lastResponsiveMobile === null || mobileNow !== lastResponsiveMobile) {
    lastResponsiveMobile = mobileNow;
    renderTopbar();
    renderLeftRail();
    renderLower();
    renderRight();
  }
  refreshMapViewport(force && !isFlat);
}

// === REINIT (for live updates without boot sequence) ===
function reinit() {
  renderTopbar();
  renderLeftRail();
  renderLower();
  renderRight();
  plotMarkers();
}

// === SSE: Live Updates from Server ===
function connectSSE() {
  if (typeof EventSource === 'undefined') return;
  // Only connect if served from localhost (not file://)
  if (location.protocol === 'file:') return;
  var es = new EventSource('/events');
  es.onmessage = function (e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'update' && msg.data) {
        D = msg.data;
        reinit();
        // Flash the topbar to indicate update
        var topbar = document.querySelector('.topbar');
        if (topbar) {
          topbar.style.borderColor = 'var(--accent)';
          setTimeout(function () {
            return topbar.style.borderColor = '';
          }, 1500);
        }
      } else if (msg.type === 'sweep_start') {
        var badge = document.querySelector('.alert-badge');
        if (badge) {
          badge.textContent = 'SWEEPING...';
          badge.style.borderColor = 'var(--accent)';
        }
      }
    } catch (_unused4) {}
  };
  es.onerror = function () {
    // Reconnect after 5s on error
    es.close();
    setTimeout(connectSSE, 5000);
  };
}

// === INIT ===
var booted = false;
function init() {
  renderTopbar();
  renderLeftRail();
  renderLower();
  renderRight();
  renderGlossary();
  initMap();
  if (!booted) {
    runBoot();
    booted = true;
  }
  // Close popup on click outside markers
  document.getElementById('mapContainer').addEventListener('click', function (e) {
    if (!e.target.closest('.map-popup')) closePopup();
  });
  // Open article links from ticker cards
  document.addEventListener('click', function (e) {
    var card = e.target.closest('.tk-card[data-url]');
    if (card) {
      var url = safeExternalUrl(card.dataset.url);
      if (url) window.open(url, '_blank', 'noopener');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeGlossary();
  });
  syncResponsiveLayout(true);
}
document.addEventListener('DOMContentLoaded', function () {
  var _D;
  var hasInlineData = !!(D && (_D = D) !== null && _D !== void 0 && _D.meta);
  var canProbeApi = location.protocol !== 'file:';
  if (canProbeApi && !hasInlineData) {
    // Server mode: always fetch live data from API (ignore any stale inline D)
    fetch('/api/data').then(function (r) {
      return r.json();
    }).then(function (data) {
      D = data;
      init();
      connectSSE();
    })["catch"](function () {
      var _D2;
      // Should not reach here — server routes to loading.html when no data
      if (D && (_D2 = D) !== null && _D2 !== void 0 && _D2.meta) {
        init();
        connectSSE();
      }
    });
  } else if (hasInlineData) {
    // File mode: use inline data
    init();
  }
});
window.toggleFlights = toggleFlights;
window.toggleMapMode = toggleMapMode;
window.togglePerfMode = togglePerfMode;
window.mapZoom = mapZoom;
window.setRegion = setRegion;
window.openGlossary = openGlossary;
window.closeGlossary = closeGlossary;
window.closePopup = closePopup;
