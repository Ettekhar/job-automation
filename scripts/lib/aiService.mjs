import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", "..", ".env");

// ── AI CONFIG & STATUS ───────────────────────────────────────────────────────
export function getAIConfig() {
  return {
    gemini: {
      id: "gemini",
      name: "Google Gemini",
      key: process.env.GEMINI_API_KEY || "",
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      configured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
      hasVision: true,
      freeTier: "15 RPM Free tier",
      signupUrl: "https://aistudio.google.com/apikey"
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      key: process.env.OPENROUTER_API_KEY || "",
      model: process.env.OPENROUTER_MODEL || "auto (free tier)",
      configured: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()),
      hasVision: true,
      freeTier: "Multiple Free Models",
      signupUrl: "https://openrouter.ai/keys"
    },
    groq: {
      id: "groq",
      name: "Groq (Ultra-Fast)",
      key: process.env.GROQ_API_KEY || "",
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      configured: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()),
      hasVision: true,
      freeTier: "30 RPM Free tier",
      signupUrl: "https://console.groq.com/keys"
    },
    cloudflare: {
      id: "cloudflare",
      name: "Cloudflare Workers AI",
      accountId: process.env.CF_ACCOUNT_ID || "",
      apiToken: process.env.CF_API_TOKEN || "",
      model: process.env.CF_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct",
      configured: Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN),
      hasVision: true,
      freeTier: "100,000 req/day free",
      signupUrl: "https://dash.cloudflare.com/"
    }
  };
}

// ── SAVE AI KEYS TO .ENV & PROCESS.ENV ───────────────────────────────────────
export async function saveAIConfig(newConfig) {
  let envText = "";
  try {
    envText = await fs.readFile(ENV_PATH, "utf-8");
  } catch {
    envText = "";
  }

  const updates = {};
  if (newConfig.geminiKey !== undefined) updates["GEMINI_API_KEY"] = newConfig.geminiKey.trim();
  if (newConfig.geminiModel !== undefined) updates["GEMINI_MODEL"] = newConfig.geminiModel.trim() || "gemini-3.6-flash";
  if (newConfig.openrouterKey !== undefined) updates["OPENROUTER_API_KEY"] = newConfig.openrouterKey.trim();
  if (newConfig.openrouterModel !== undefined) updates["OPENROUTER_MODEL"] = newConfig.openrouterModel.trim();
  if (newConfig.groqKey !== undefined) updates["GROQ_API_KEY"] = newConfig.groqKey.trim();
  if (newConfig.groqModel !== undefined) updates["GROQ_MODEL"] = newConfig.groqModel.trim() || "llama-3.3-70b-versatile";
  if (newConfig.cfAccountId !== undefined) updates["CF_ACCOUNT_ID"] = newConfig.cfAccountId.trim();
  if (newConfig.cfApiToken !== undefined) updates["CF_API_TOKEN"] = newConfig.cfApiToken.trim();
  if (newConfig.cfModel !== undefined) updates["CF_MODEL"] = newConfig.cfModel.trim();

  // 1. Immediately apply to active in-memory environment
  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }

  // 2. Cleanly deduplicate and persist to .env file
  let lines = envText.split(/\r?\n/);
  for (const [k, v] of Object.entries(updates)) {
    // Remove all old active and commented instances of this variable
    lines = lines.filter(line => !line.startsWith(`${k}=`) && !line.startsWith(`# ${k}=`));
    if (v) {
      lines.push(`${k}=${v}`);
    }
  }

  await fs.writeFile(ENV_PATH, lines.join("\n"), "utf-8");
  return getAIConfig();
}

// ── TEST A SINGLE PROVIDER ──────────────────────────────────────────────────
export async function testAIProvider(providerName, overrides = {}) {
  const start = Date.now();
  const testPrompt = "Respond with only the word OK.";

  try {
    let responseText = null;
    const key = overrides.key;

    if (providerName === "gemini") {
      const apiKey = key !== undefined ? key : process.env.GEMINI_API_KEY;
      const model = overrides.model || process.env.GEMINI_MODEL || "gemini-3.6-flash";
      if (!apiKey) throw new Error("Gemini API Key is empty");
      responseText = await callGeminiAPI(testPrompt, null, { key: apiKey, model });
    } else if (providerName === "openrouter") {
      const apiKey = key !== undefined ? key : process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("OpenRouter API Key is empty");
      responseText = await callOpenRouterAPI(testPrompt, null, { key: apiKey });
    } else if (providerName === "groq") {
      const apiKey = key !== undefined ? key : process.env.GROQ_API_KEY;
      const model = overrides.model || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
      if (!apiKey) throw new Error("Groq API Key is empty");
      responseText = await callGroqAPI(testPrompt, null, { key: apiKey, model });
    } else if (providerName === "cloudflare") {
      const accountId = overrides.accountId !== undefined ? overrides.accountId : process.env.CF_ACCOUNT_ID;
      const apiToken = overrides.apiToken !== undefined ? overrides.apiToken : process.env.CF_API_TOKEN;
      if (!accountId || !apiToken) throw new Error("Cloudflare Account ID or API Token is empty");
      responseText = await callCloudflareAPI(testPrompt, null, { accountId, apiToken });
    } else {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    const latencyMs = Date.now() - start;
    if (!responseText) throw new Error("Provider returned empty response");

    return {
      success: true,
      provider: providerName,
      latencyMs,
      message: `Active & Connected (${latencyMs}ms)`,
      sampleResponse: responseText.slice(0, 60)
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      success: false,
      provider: providerName,
      latencyMs,
      error: err.message
    };
  }
}

// ── CALL AI PROVIDER IMPLEMENTATIONS ─────────────────────────────────────────

export async function callGeminiAPI(prompt, base64Image = null, opts = {}) {
  const apiKey = (opts.key || process.env.GEMINI_API_KEY || "").trim();
  let requestedModel = opts.model || process.env.GEMINI_MODEL || "gemini-3.6-flash";
  if (!apiKey) return null;

  const candidateModels = [requestedModel, "gemini-3.6-flash", "gemini-3.7-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
  const uniqueModels = Array.from(new Set(candidateModels.filter(Boolean)));

  const parts = [{ text: prompt }];
  if (base64Image) {
    parts.push({ inline_data: { mime_type: "image/png", data: base64Image } });
  }

  let lastErr = null;
  for (const model of uniqueModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`Gemini (${model}) HTTP ${res.status}: ${errText.slice(0, 150)}`);
        if (res.status === 401 || res.status === 403) throw err; // Auth failure: stop trying models
        lastErr = err;
        continue;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) return text;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

export async function callOpenRouterAPI(prompt, base64Image = null, opts = {}) {
  const apiKey = (opts.key || process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) return null;

  const content = base64Image
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
      ]
    : [{ type: "text", text: prompt }];

  const modelCandidates = base64Image
    ? [
        "google/gemini-2.0-flash-lite-preview-02-05:free",
        "meta-llama/llama-3.2-11b-vision-instruct:free",
        "mistralai/pixtral-12b:free",
        "google/gemma-4-26b-a4b-it:free",
        "openrouter/auto"
      ]
    : [
        "meta-llama/llama-3.3-70b-instruct:free",
        "google/gemma-2-9b-it:free",
        "qwen/qwen-2.5-72b-instruct:free",
        "liquid/lfm-2.5-2.6b:free",
        "openrouter/auto"
      ];

  let lastErr = null;
  for (const model of modelCandidates) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "Teletalk Job Notifier"
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 512 }),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`OpenRouter (${model}) HTTP ${res.status}: ${errText.slice(0, 120)}`);
        if (res.status === 401 || res.status === 403) throw err; // Auth failure: stop trying models
        lastErr = err;
        continue;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

export async function callGroqAPI(prompt, base64Image = null, opts = {}) {
  const apiKey = (opts.key || process.env.GROQ_API_KEY || "").trim();
  const requestedModel = (opts.model || process.env.GROQ_MODEL || "").trim();
  if (!apiKey) return null;

  const content = base64Image
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
      ]
    : [{ type: "text", text: prompt }];

  const modelCandidates = base64Image
    ? [
        ...(requestedModel ? [requestedModel] : []),
        "llama-3.2-11b-vision-preview",
        "llama-3.2-90b-vision-preview",
        "llama-3.3-70b-versatile"
      ]
    : [
        ...(requestedModel ? [requestedModel] : []),
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant"
      ];

  const uniqueModels = Array.from(new Set(modelCandidates.filter(Boolean)));

  let lastErr = null;
  for (const model of uniqueModels) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: 512 }),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Groq Authentication Failed (HTTP ${res.status}): Please check your Groq API Key at console.groq.com`);
        }
        const err = new Error(`Groq (${model}) HTTP ${res.status}: ${errText.slice(0, 120)}`);
        lastErr = err;
        continue;
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      if (e.message?.includes("Groq Authentication Failed")) throw e;
      lastErr = e;
    }
  }

  if (lastErr) throw lastErr;
  return null;
}

export async function callCloudflareAPI(prompt, base64Image = null, opts = {}) {
  const accountId = (opts.accountId || process.env.CF_ACCOUNT_ID || "").trim();
  const apiToken = (opts.apiToken || process.env.CF_API_TOKEN || "").trim();
  if (!accountId || !apiToken) return null;

  let model, body;
  if (base64Image) {
    model = "@cf/meta/llama-3.2-11b-vision-instruct";
    body = JSON.stringify({
      prompt: prompt,
      image: Array.from(Buffer.from(base64Image, "base64")),
      max_tokens: 512
    });
  } else {
    model = "@cf/meta/llama-3.1-8b-instruct";
    body = JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512
    });
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`
    },
    body,
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Cloudflare AI HTTP ${res.status}: ${errText.slice(0, 120)}`);
  }

  const data = await res.json();
  const raw = data?.result?.response ?? data?.result?.description ?? data?.result;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && raw[0]?.text) return raw[0].text.trim();
  if (typeof raw === "object" && raw !== null) return JSON.stringify(raw);
  return null;
}

// ── SESSION-LEVEL PROVIDER BLACKLIST ─────────────────────────────────────────
// Tracks providers that have failed this process run so they are never retried.
// Reset by restarting the script. Exported so callers can also read/clear it.
export const sessionBlacklist = new Set();

// ── UNIFIED MULTI-PROVIDER CASCADE ───────────────────────────────────────────
// Priority order: Gemini → Groq → Cloudflare → OpenRouter
// - Skips providers in sessionBlacklist (failed earlier this run)
// - On failure, adds provider to sessionBlacklist so it won't be tried again
// - Accepts optional external blacklist array for per-call overrides
export async function callAIWithCascade(prompt, base64Image = null, opts = {}) {
  const extraBlacklist = opts.blacklist || []; // caller-supplied extra skip list
  const ignoreSessionBlacklist = Boolean(opts.fresh || opts.isCaptcha);

  const providers = [
    { name: "Gemini",      fn: callGeminiAPI,     hasKey: Boolean(process.env.GEMINI_API_KEY?.trim()) },
    { name: "Groq",        fn: callGroqAPI,        hasKey: Boolean(process.env.GROQ_API_KEY?.trim()) },
    { name: "Cloudflare",  fn: callCloudflareAPI,  hasKey: Boolean(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) },
    { name: "OpenRouter",  fn: callOpenRouterAPI,  hasKey: Boolean(process.env.OPENROUTER_API_KEY?.trim()) }
  ];

  const eligible = providers.filter(p =>
    p.hasKey &&
    (ignoreSessionBlacklist || !sessionBlacklist.has(p.name)) &&
    !extraBlacklist.includes(p.name)
  );

  if (eligible.length === 0) {
    const reason = providers.some(p => p.hasKey)
      ? "all configured providers are blacklisted for this session"
      : "no AI provider API keys configured in .env";
    console.log(`[🤖 AI Cascade] ⚠️ Cannot call AI — ${reason}.`);
    return null;
  }

  for (let i = 0; i < eligible.length; i++) {
    const { name, fn } = eligible[i];
    try {
      console.log(`[🤖 AI Cascade] Attempting request via ${name}...`);
      const start = Date.now();
      const result = await fn(prompt, base64Image);
      if (result) {
        const ms = Date.now() - start;
        console.log(`[🤖 AI Cascade] ✅ ${name} responded in ${ms}ms!`);
        return result;
      }
      // Empty response counts as a soft failure — blacklist & try next
      console.log(`[🤖 AI Cascade] ⚠️ ${name} returned empty response — blacklisting for this session.`);
      sessionBlacklist.add(name);
    } catch (err) {
      console.log(`[🤖 AI Cascade] ⚠️ ${name} error: ${err.message}`);
      sessionBlacklist.add(name);
      const remaining = eligible.slice(i + 1).filter(p => !sessionBlacklist.has(p.name));
      if (remaining.length > 0) {
        console.log(`[🤖 AI Cascade] 🔄 Falling back to ${remaining[0].name}...`);
      }
    }
  }

  console.log("[🤖 AI Cascade] ❌ All available AI providers failed for this request.");
  return null;
}
