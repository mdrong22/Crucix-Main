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