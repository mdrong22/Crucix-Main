/**
 * Compute RSI-14 from an array of closing prices.
 * @param {number[]} closes - Array of closing prices, NEWEST FIRST (desc order from Alpaca).
 * @param {number} period   - RSI period (default 14)
 * @returns {number|null}   - RSI value 0-100, or null if insufficient data
 */
function calcRSI(closes, period = 14) {
  // Need at least period+1 values to calculate period differences
  if (!closes || closes.length < period + 1) return null;

  // closes[0] = most recent, closes[1] = one bar ago, etc.
  // differences: diff[i] = closes[i] - closes[i+1]  (positive = gain, negative = loss)
  let gains = 0;
  let losses = 0;
  for (let i = 0; i < period; i++) {
    const diff = closes[i] - closes[i + 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100; // No losses → fully overbought
  const rs = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(1));
}

/**
 * Fetches historical bar data from Alpaca and computes technicals including RSI-14.
 * @param {string} symbol    - Ticker symbol
 * @param {string} timeframe - '1Min', '5Min', '1Day' etc.
 * @param {number} limit     - Number of bars (15+ for RSI-14, default 20)
 */
export async function getHistoricalTechnicals(symbol, timeframe = '5Min', limit = 20) {
  const now = new Date();
  // Extend lookback to 3 hours to ensure we get enough 5-min bars during regular sessions
  const lookbackMs = timeframe === '1Min' ? 60 * 60 * 1000 : 3 * 60 * 60 * 1000;
  const startTime = new Date(now.getTime() - lookbackMs).toISOString();

  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_SECRET;
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=${timeframe}&limit=${limit}&adjustment=raw&feed=sip&sort=desc&start=${startTime}`;

  try {
    const response = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
        'accept': 'application/json'
      }
    });
    const data = await response.json();

    const bars = data.bars?.[symbol] || [];
    if (bars.length === 0) return null;

    const latestClose = bars[0].c;
    const previousClose = bars[bars.length - 1].c;
    const momentum = ((latestClose - previousClose) / previousClose) * 100;

    // RSI-14 computed from close prices (bars sorted desc → newest first)
    const closes = bars.map(b => b.c);
    const rsi = calcRSI(closes, 14);

    return {
      symbol,
      latestClose,
      momentum: momentum.toFixed(2),
      rsi: rsi !== null ? rsi : null,
      bars, // full bar array — callers slice as needed
    };
  } catch (error) {
    console.error(`[REDLINE] Bar Fetch Error for ${symbol}:`, error);
    return null;
  }
}

export async function getLongTermTechnicals(symbol) {
  const now = new Date();
  // We go back ~300 days to guarantee 200 trading days (accounting for weekends/holidays)
  const nearlyOneYearAgo = new Date(now.setDate(now.getDate() - 300)).toISOString();

  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_SECRET;
  
  // Note: We use timeframe=1Day and limit=200
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&limit=200&adjustment=split&feed=sip&sort=desc&start=${nearlyOneYearAgo}`;

  try {
    const response = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
        'accept': 'application/json'
      }
    });
    
    const data = await response.json();
    const bars = data.bars[symbol] || [];

    if (bars.length < 200) {
      console.warn(`[REDLINE] Insufficient data for 200MA on ${symbol}: Found ${bars.length}`);
      return null;
    }

    // Calculate Simple Moving Average (SMA)
    const sum = bars.reduce((acc, bar) => acc + bar.c, 0);
    const ma200 = sum / bars.length;

    return {
      symbol,
      ma200: ma200.toFixed(2),
      isBelowMA200: bars[0].c < ma200, // Comparison with latest close
      dataPoints: bars.length
    };
  } catch (error) {
    console.error(`[REDLINE] 200MA Fetch Error for ${symbol}:`, error);
    return null;
  }
}

/**
 * Pre-breakout SETUP scan — the "timing trigger" for forward-paced thesis picks.
 * Reuses the 200×1Day fetch pattern from getLongTermTechnicals; computes the classic
 * "emerging leader" signature so a thesis only fires when a name is actually setting up:
 *   - rising 50/200 MA stack (trend intact)
 *   - coiling near the 52-week high (not extended, not broken)
 *   - RSI waking up but not overbought
 *   - volume expansion vs its own average
 *   - relative strength vs SPY (outperforming before the news)
 *
 * @param {string} symbol
 * @param {{ret1m:number, ret3m:number}|null} spyRef - SPY returns for RS comparison.
 *        Caller computes once per cycle (getSetupTechnicals('SPY')) and passes it in.
 * @returns {object|null} setup profile, or null on fetch failure / insufficient data.
 */
export async function getSetupTechnicals(symbol, spyRef = null) {
  const now = new Date();
  const start = new Date(now.setDate(now.getDate() - 300)).toISOString();
  const apiKey = process.env.ALPACA_API_KEY;
  const apiSecret = process.env.ALPACA_SECRET;
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&limit=200&adjustment=split&feed=sip&sort=desc&start=${start}`;

  try {
    const response = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
        'accept': 'application/json',
      },
    });
    if (!response.ok) {
      console.warn(`[REDLINE] Setup scan ${symbol}: HTTP ${response.status} — skipping.`);
      return null;
    }
    const data = await response.json();
    const bars = data.bars?.[symbol] || []; // newest-first (sort=desc)
    if (bars.length < 63) {
      return { symbol, setup: 'NONE', insufficient: true, bars: bars.length };
    }

    const closes = bars.map(b => b.c);
    const highs  = bars.map(b => b.h);
    const vols   = bars.map(b => b.v ?? 0);
    const latest = closes[0];

    const avg = (arr, n) => {
      const s = arr.slice(0, n);
      return s.reduce((a, b) => a + b, 0) / s.length;
    };
    const ma50  = avg(closes, 50);
    const ma200 = avg(closes, Math.min(200, closes.length));
    const aboveStack = latest > ma50 && ma50 > ma200; // rising stack

    const high52 = Math.max(...highs);
    const pctFrom52wHigh = ((latest - high52) / high52) * 100; // negative = below high

    const rsi = calcRSI(closes, 14);

    const volAvg50 = avg(vols.slice(1), 50);            // prior-50 avg (exclude today)
    const volSurge = volAvg50 > 0 ? vols[0] / volAvg50 : 1;

    const ret = n => closes.length > n ? ((latest - closes[n]) / closes[n]) * 100 : 0;
    const ret1m = ret(21);   // ~1 trading month
    const ret3m = ret(63);   // ~3 trading months
    const rsVsSpy = spyRef && Number.isFinite(spyRef.ret3m) ? ret3m - spyRef.ret3m : null; // >0 = outperform

    // ── Setup classification ────────────────────────────────────────────────
    const nearHigh   = pctFrom52wHigh > -15;
    const buildHigh  = pctFrom52wHigh > -25;
    const rsiHot     = rsi != null && rsi >= 50 && rsi <= 70;
    const rsiOk      = rsi != null && rsi >= 45 && rsi < 75;
    const volPop     = volSurge > 1.3;
    const volWarm    = volSurge > 1.1;
    const rsGood     = rsVsSpy == null || rsVsSpy > 0;

    let setup = 'NONE';
    if (aboveStack && nearHigh && rsiHot && volPop && rsGood) {
      setup = 'STRONG';
    } else if (aboveStack && buildHigh && rsiOk && (volWarm || (rsVsSpy != null && rsVsSpy > 0))) {
      setup = 'BUILDING';
    }

    return {
      symbol,
      setup,
      ma50:  parseFloat(ma50.toFixed(2)),
      ma200: parseFloat(ma200.toFixed(2)),
      aboveStack,
      high52: parseFloat(high52.toFixed(2)),
      pctFrom52wHigh: parseFloat(pctFrom52wHigh.toFixed(1)),
      rsi,
      volSurge: parseFloat(volSurge.toFixed(2)),
      ret1m: parseFloat(ret1m.toFixed(1)),
      ret3m: parseFloat(ret3m.toFixed(1)),
      rsVsSpy: rsVsSpy == null ? null : parseFloat(rsVsSpy.toFixed(1)),
    };
  } catch (error) {
    console.error(`[REDLINE] Setup scan error for ${symbol}:`, error.message);
    return null;
  }
}