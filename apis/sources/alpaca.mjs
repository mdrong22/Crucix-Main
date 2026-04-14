/**
 * Fetches historical bar data from Alpaca to calculate technicals.
 * @param {string} symbol - Ticker symbol
 * @param {string} timeframe - '1Min', '5Min', '1Day' etc.
 * @param {number} limit - Number of bars (default 14 for RSI)
 */
export async function getHistoricalTechnicals(symbol, timeframe = '1Min', limit = 14) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - (60 * 60 * 1000)).toISOString();

  const apiKey = process.env.ALPACA_API_KEY; // Provided by environment
  const apiSecret = process.env.ALPACA_SECRET; // Provided by environment
  const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=${timeframe}&limit=${limit}&adjustment=raw&feed=sip&sort=desc&start=${oneHourAgo}`;

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
    if (bars.length === 0) return null;

    // Basic RSI calculation logic would go here using bars.map(b => b.c)
    const latestClose = bars[0].c;
    const previousClose = bars[bars.length - 1].c;
    const momentum = ((latestClose - previousClose) / previousClose) * 100;

    return {
      symbol,
      latestClose,
      momentum: momentum.toFixed(2),
      bars: bars.slice(0, 5) // Return last few for context
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