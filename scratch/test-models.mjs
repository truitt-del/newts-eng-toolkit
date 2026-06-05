import fs from 'fs';
import path from 'path';

// Simple dotenv parser
function loadEnv() {
  const envPath = path.resolve('.env.local');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
          process.env[key] = value;
        }
      }
    }
  }
}

async function main() {
  loadEnv();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY not found in .env.local');
    process.exit(1);
  }

  console.log('Using API key:', apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 4));

  // Comprehensive test roster (both Pro/heavy and Flash/light models)
  const modelsToTest = [
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-pro-exp-02-05',
    'gemini-3-pro-preview'
  ];

  console.log('\n--- Testing exact models for usability with NEW API key ---');
  for (const model of modelsToTest) {
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: "Hello! Reply with 'OK' and nothing else." }] }]
    };

    const startTime = Date.now();
    try {
      const response = await fetch(testUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const latency = Date.now() - startTime;

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(No text)';
        console.log(`✅ [SUCCESS] Model: ${model} | Latency: ${latency}ms | Response: "${text}"`);
      } else {
        const errText = await response.text();
        let errJson;
        try { errJson = JSON.parse(errText); } catch(e) {}
        const msg = errJson?.error?.message || errText;
        console.log(`❌ [FAILED]  Model: ${model} | Latency: ${latency}ms | Status ${response.status}: ${msg}`);
      }
    } catch (err) {
      console.log(`❌ [FAILED]  Model: ${model} | Error: ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error('Unhandled rejection:', err);
});
