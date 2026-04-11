import fs from 'fs';
import path from 'path';

/**
 * generateLocalReport
 * Converts Scribe's post-mortem text into a styled HTML report saved to /reports.
 * Renders inline in the RedLine dashboard report viewer modal.
 *
 * Output format: YYYY-MM-DDTHH-mm-ss_SYMBOL_Report.html
 */
export async function generateLocalReport(symbol, transcript, scribeInput) {
  const reportDir = path.join(process.cwd(), 'reports');

  // 1. Ensure directory exists
  if (!fs.existsSync(reportDir)) {
    try {
      fs.mkdirSync(reportDir, { recursive: true });
    } catch (err) {
      console.error('❌ Failed to create reports directory:', err.message);
      return;
    }
  }

  // 2. Unwrap Scribe content
  let scribeOutput = '';
  if (typeof scribeInput === 'object' && scribeInput !== null) {
    scribeOutput = scribeInput.text || JSON.stringify(scribeInput);
  } else {
    scribeOutput = String(scribeInput || 'No analysis provided.');
  }

  // 3. Parse verdict from scribe output
  const verdictMatch  = scribeOutput.match(/VERDICT:\s*(\w+)/i);
  const verdict       = verdictMatch ? verdictMatch[1].toUpperCase() : 'COMPLETE';
  const actionMatch   = scribeOutput.match(/Action[:\s]+\*{0,2}(BUY|SELL|WAIT)\*{0,2}/i);
  const action        = actionMatch ? actionMatch[1].toUpperCase() : verdict;
  const actionColor   = action === 'BUY' ? '#00C896' : action === 'SELL' ? '#FF6B00' : action === 'WAIT' ? '#FFAA00' : '#aaaaaa';

  // Parse grade
  const gradeMatch  = scribeOutput.match(/Overall Session Grade[:\s]+\[?([A-F][+-]?)\]?/i);
  const grade       = gradeMatch ? gradeMatch[1] : '—';
  const gradeColor  = grade.startsWith('A') ? '#00C896' : grade.startsWith('B') ? '#7ED4AD' : grade.startsWith('C') ? '#FFAA00' : '#FF4444';

  // Parse council score
  const scoreMatch  = scribeOutput.match(/COUNCIL TOTAL SCORE[:\s]+\[?(\d+(?:\.\d+)?\/10)\]?/i);
  const totalScore  = scoreMatch ? scoreMatch[1] : '—';

  // Parse individual ratings
  const ratingRe = (name) => new RegExp(`${name}[^:]*:\\s*\\[?(\\d+(?:\\.\\d+)?)\\/10\\]?`, 'i');
  const scoutScore  = scribeOutput.match(ratingRe('SCOUT'))?.[1]  || '—';
  const phiScore    = scribeOutput.match(ratingRe('PHI'))?.[1]    || '—';
  const thetaScore  = scribeOutput.match(ratingRe('THETA'))?.[1]  || '—';
  const gregorScore = scribeOutput.match(ratingRe('GREGOR'))?.[1] || '—';

  // 4. Convert scribe text sections to HTML
  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderSection(title, content) {
    const escaped = escHtml(content.trim());
    const formatted = escaped
      // bold **text**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // bullet lines
      .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
      // wrap consecutive <li> in <ul>
      .replace(/(<li>[\s\S]*?<\/li>(\n)?)+/g, m => '<ul>' + m + '</ul>')
      // double newline → paragraph break
      .split(/\n{2,}/)
      .map(b => {
        const t = b.trim();
        if (!t) return '';
        if (/^<(ul|li|h[1-6])/.test(t)) return t;
        return '<p>' + t.replace(/\n/g, ' ') + '</p>';
      })
      .join('');

    return `
      <div class="rl-section">
        <div class="rl-section-title">${escHtml(title)}</div>
        <div class="rl-section-body">${formatted}</div>
      </div>`;
  }

  // Split Scribe output into sections by numbered headings (e.g. "1. Title", "2. Title")
  // Flexible: matches any number ≥1, any case after the dot, with variable whitespace.
  const rawSections = scribeOutput.split(/\n(?=\d+\.\s+\S)/);

  let sectionsHtml = '';
  for (const raw of rawSections) {
    // Match "1. Title text" optionally followed by a ━ divider or newline
    const titleMatch = raw.match(/^(\d+\.\s+[^\n━]+)/);
    if (titleMatch) {
      const title = titleMatch[1].replace(/━+/g, '').trim();
      const body  = raw.slice(titleMatch[0].length).replace(/━+/g, '').trim();
      if (body) {
        sectionsHtml += renderSection(title, body);
      }
    } else {
      // Fallback: render as plain body block
      const cleaned = raw.replace(/━+/g, '').trim();
      if (cleaned) sectionsHtml += renderSection('ANALYSIS', cleaned);
    }
  }

  // If section parsing failed, just render the whole thing
  if (!sectionsHtml.trim()) {
    sectionsHtml = renderSection('SCRIBE ANALYSIS', scribeOutput);
  }

  // 5. Build KPI bar
  function kpi(label, value, color = '#e0e0e0') {
    return `<div class="rl-kpi"><div class="rl-kpi-label">${label}</div><div class="rl-kpi-value" style="color:${color}">${value}</div></div>`;
  }

  const kpiBar = `
    <div class="rl-kpi-grid">
      ${kpi('TICKER',  symbol,     '#FF6B00')}
      ${kpi('ACTION',  action,     actionColor)}
      ${kpi('GRADE',   grade,      gradeColor)}
      ${kpi('SCORE',   totalScore, '#e0e0e0')}
      ${kpi('SCOUT',   scoutScore  !== '—' ? scoutScore + '/10' : '—')}
      ${kpi('PHI',     phiScore    !== '—' ? phiScore    + '/10' : '—')}
      ${kpi('THETA',   thetaScore  !== '—' ? thetaScore  + '/10' : '—')}
      ${kpi('GREGOR',  gregorScore !== '—' ? gregorScore + '/10' : '—')}
    </div>`;

  // 6. Build full HTML (no external deps — self-contained, renders in the dashboard modal)
  const dateLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const html = `<style>
.rl-trade{font-family:'Courier New',monospace;color:#e0e0e0;font-size:12px;line-height:1.7}
.rl-trade-header{margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #FF6B00}
.rl-trade-title{color:#FF6B00;font-size:17px;letter-spacing:3px;font-weight:bold;margin-bottom:4px}
.rl-trade-meta{color:#666;font-size:10px}
.rl-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;margin-bottom:20px}
.rl-kpi{background:#111;border:1px solid #222;padding:8px 10px;text-align:center}
.rl-kpi-label{color:#555;font-size:9px;letter-spacing:1px;margin-bottom:3px}
.rl-kpi-value{font-size:17px;font-weight:bold}
.rl-section{margin-bottom:20px}
.rl-section-title{color:#FF6B00;font-size:10px;letter-spacing:2px;font-weight:bold;
  border-bottom:1px solid #1e1e1e;padding-bottom:5px;margin-bottom:10px;text-transform:uppercase}
.rl-section-body{color:#ccc;font-size:11px;line-height:1.75}
.rl-section-body p{margin-bottom:8px}
.rl-section-body strong{color:#fff}
.rl-section-body ul{margin:4px 0 8px 16px;padding:0}
.rl-section-body li{margin-bottom:3px;color:#bbb}
.rl-divider{border:none;border-top:1px solid #1a1a1a;margin:18px 0}
</style>
<div class="rl-trade">
  <div class="rl-trade-header">
    <div class="rl-trade-title">◈ COUNCIL POST-MORTEM — ${symbol}</div>
    <div class="rl-trade-meta">Generated: ${dateLabel} &nbsp;|&nbsp; Verdict: ${verdict}</div>
  </div>
  ${kpiBar}
  <hr class="rl-divider">
  ${sectionsHtml}
</div>`;

  // 7. Write file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName  = `${timestamp}_${symbol}_Report.html`;
  const filePath  = path.join(reportDir, fileName);

  try {
    fs.writeFileSync(filePath, html, { encoding: 'utf8', flag: 'w' });
    if (fs.existsSync(filePath)) {
      console.log(`📂 [Scribe] Trade report saved: ${fileName}`);
    }
  } catch (err) {
    console.error('❌ [Scribe] Failed to write report:', err.message);
  }
}
