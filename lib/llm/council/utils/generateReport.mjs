import fs from 'fs';
import path from 'path';

export async function generateLocalReport(symbol, transcript, scribeOutput) {
    // 1. Create a /reports folder if it doesn't exist
    const reportDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir);
    }

    // 2. Format the filename with a timestamp (e.g., 2026-03-26_TSLA.md)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `${timestamp}_${symbol}_Report.md`;
    const filePath = path.join(reportDir, fileName);

    // 3. Construct the Document Content
    const fileContent = `
# 📜 COUNCIL POST-MORTEM: ${symbol}
**Date:** ${new Date().toLocaleString()}
**Verdict:** ${scribeOutput.match(/VERDICT:\s*(\w+)/i)?.[1] || "RESOLVED"}

---

## ✍️ SCRIBE'S ANALYSIS
${scribeOutput}

---

## 🗨️ FULL TRANSCRIPT
${transcript.map(m => `### **[${m.name || m.role.toUpperCase()}]**\n${m.content}`).join('\n\n')}

---
*End of Report*
    `;

    // 4. Write to disk
    try {
        fs.writeFileSync(filePath, fileContent, 'utf8');
        console.log(`📂 Report saved to: ${filePath}`);
    } catch (err) {
        console.error("❌ Failed to save report to folder:", err.message);
    }
}