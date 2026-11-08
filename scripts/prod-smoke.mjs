#!/usr/bin/env node
// Remote production smoke test for Vivian (npm run test:prod).
//
// Hits the deployed app directly — no API keys on the terminal, no secrets
// written to disk. The vivianAuth bearer token is read ONLY from env
// (VIVIAN_AUTH_TOKEN) and is never printed or persisted.
//
// Usage:
//   VIVIAN_AUTH_TOKEN=<token from localStorage "vivian_auth_token"> npm run test:prod
//   VIVIAN_PROD_URL=https://vivianlabs.vercel.app npm run test:prod
//
// What it checks:
//   1. GET /                       -> 200 (shell renders)
//   2. GET /api/memory (no token)  -> 401 (auth guard is up)
//   3. GET /api/memory (token)     -> < 500 (auth + route healthy)
//   4. POST /api/chat (token, real -> 200 with a non-empty reply,
//      production schema)             within the timeout budget
// Exit code is non-zero if any step fails. Timings are printed per step.

const BASE_URL = (process.env.VIVIAN_PROD_URL || "https://vivianlabs.vercel.app").replace(/\/+$/, "");
const TOKEN = process.env.VIVIAN_AUTH_TOKEN || "";
const REQUEST_TIMEOUT_MS = 60_000;

function step(name, pass, detail) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

async function request(path, options = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.withToken && TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.text();
    return { status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, body: String(error), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function uuid() {
  return crypto.randomUUID();
}

async function main() {
  console.log(`Vivian production smoke test\n  base:    ${BASE_URL}\n  token:   ${TOKEN ? "(provided, never printed)" : "(missing — auth steps will fail)"}\n`);

  const results = [];

  const home = await request("/");
  results.push(step("GET / renders", home.status === 200, `status ${home.status} in ${home.ms}ms`));

  const guard = await request("/api/memory");
  results.push(step("GET /api/memory without token is rejected", guard.status === 401, `status ${guard.status} in ${guard.ms}ms`));

  if (TOKEN) {
    const authed = await request("/api/memory", { withToken: true });
    results.push(step("GET /api/memory with token", authed.status < 500, `status ${authed.status} in ${authed.ms}ms`));

    const chat = await request("/api/chat", {
      withToken: true,
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "สวัสดี Vivian อยู่ไหม" }],
        conversationId: uuid(),
        userMessageId: uuid(),
        assistantMessageId: uuid(),
        conversationCreate: true,
        language: "th",
      }),
    });
    let text = "";
    try {
      text = (JSON.parse(chat.body).text || "").trim();
    } catch {
      // Non-JSON response: leave empty so the step fails with the raw page.
    }
    results.push(step("POST /api/chat answers in production", chat.status === 200 && text.length > 0, `status ${chat.status} in ${chat.ms}ms, reply ${text.length} chars`));
    if (!text) console.log(`       (response: ${chat.body.slice(0, 200)})`);
  } else {
    console.log("SKIP  authenticated steps — set VIVIAN_AUTH_TOKEN to run them");
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} steps passed`);
  if (!TOKEN) {
    console.log("tip: ดึง token จากเบราว์เซอร์ได้ที่ localStorage.getItem('vivian_auth_token') แล้วรันพร้อม VIVIAN_AUTH_TOKEN=<token>");
  }
  process.exit(failed ? 1 : 0);
}

main();
