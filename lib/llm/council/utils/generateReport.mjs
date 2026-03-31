import fs from 'fs';
import path from 'path';

/**
 * generateLocalReport
 * Robustly handles GeminiProvider outputs (Objects or Strings) and saves to disk.
 */
export async function generateLocalReport(symbol, transcript, scribeInput) {
    const reportDir = path.join(process.cwd(), 'reports');
    
    // 1. Ensure Directory Exists
    if (!fs.existsSync(reportDir)) {
        try {
            fs.mkdirSync(reportDir, { recursive: true });
            console.log(`[REPORTER] Created directory: ${reportDir}`);
        } catch (err) {
            console.error("❌ Failed to create reports directory:", err.message);
            return;
        }
    }

    // 2. UNWRAP SCRIBE CONTENT
    // Since GeminiProvider returns { text, ... }, but you might pass scribeReport.text directly:
    let scribeOutput = "";
    if (typeof scribeInput === 'object' && scribeInput !== null) {
        scribeOutput = scribeInput.text || JSON.stringify(scribeInput);
    } else {
        scribeOutput = String(scribeInput || "No analysis provided.");
    }

    // 3. GENERATE FILENAME
    // Format: YYYY-MM-DD_HH-mm-ss_SYMBOL_Report.md
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `${timestamp}_${symbol}_Report.md`;
    const filePath = path.join(reportDir, fileName);

    // 4. CONSTRUCT CONTENT
    // Extract verdict from the analysis text if present (e.g. "VERDICT: BUY")
    const verdictMatch = scribeOutput.match(/VERDICT:\s*(\w+)/i);
    const verdict = verdictMatch ? verdictMatch[1].toUpperCase() : "COMPLETE";

    const transcriptSection = Array.isArray(transcript) 
        ? transcript.map(m => `### **[${m.name || m.role?.toUpperCase() || 'UNKNOWN'}]**\n${m.content}`).join('\n\n')
        : "Transcript data unavailable or invalid format.";

    const fileContent = `
# 📜 COUNCIL POST-MORTEM: ${symbol}
**Date:** ${new Date().toLocaleString()}
**Scribe Verdict:** ${verdict}

---

## ✍️ SCRIBE'S ANALYSIS
${scribeOutput}

---

## 🗨️ FULL TRANSCRIPT
${transcriptSection}

---
*End of Report*
    `.trim();

    // 5. ATTEMPT WRITE
    try {
        // Use absolute path and explicit encoding
        fs.writeFileSync(filePath, fileContent, { encoding: 'utf8', flag: 'w' });
        
        // Double check the file exists after writing (verification step)
        if (fs.existsSync(filePath)) {
            console.log(`📂 [SUCCESS] Report saved to: ${filePath}`);
        } else {
            console.error(`❌ [ERROR] writeFileSync returned but file not found: ${filePath}`);
        }
    } catch (err) {
        console.error("❌ [CRITICAL] Failed to write report file:", err.message);
    }
}