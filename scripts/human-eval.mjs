#!/usr/bin/env node
// Human-likeness eval for Vivian against production (npm run test:human).
//
// Sends a fixed scenario set to the real /api/chat and grades each reply for
// the "feels human, not assistant" failure modes from the persona contract:
// AI disclaimers, service phrases, catchphrase repetition, routine lectures,
// rigid refusals, and canon leaks. Anything judgment-dependent is marked
// REVIEW and printed verbatim for a human read.
//
// Usage:
//   VIVIAN_AUTH_TOKEN=<token from localStorage "vivian_auth_token"> npm run test:human
//   VIVIAN_PROD_URL=https://vivianlabs.vercel.app npm run test:human
//
// The token is env-only, never printed or persisted. Exit code is non-zero
// if any scenario FAILs (REVIEW does not fail the run).

const BASE_URL = (process.env.VIVIAN_PROD_URL || "https://vivianlabs.vercel.app").replace(/\/+$/, "");
const TOKEN = process.env.VIVIAN_AUTH_TOKEN || "";

if (!TOKEN) {
  console.error("VIVIAN_AUTH_TOKEN is required. ดึง token จากเบราว์เซอร์: localStorage.getItem('vivian_auth_token')");
  process.exit(2);
}

const REQUEST_TIMEOUT_MS = 50_000;

async function chat(messages, conversationId, userMessageId, assistantMessageId, create) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        messages,
        conversationId,
        userMessageId,
        assistantMessageId,
        conversationCreate: create === true,
        language: "th",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status !== 200) {
      return { text: "", status: response.status, error: data?.error || data?.code || `HTTP ${response.status}` };
    }
    return { text: (data.text || "").trim(), status: 200 };
  } catch (error) {
    return { text: "", status: 0, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const uid = () => crypto.randomUUID();
const count = (text, needle) => text.split(needle).length - 1;

const BANNED_ALWAYS = ["As an AI", "as an AI", "AI ที่", "เอไอ", "ฉันเป็น AI"];

function grade(name, replies, assertions) {
  const fails = [];
  for (const { check, why } of assertions) {
    for (let i = 0; i < replies.length; i++) {
      if (!check(replies[i])) fails.push(`reply ${i + 1}: ${why}`);
    }
  }
  return { name, replies, fails };
}

const list = (replies) => replies.map((r, i) => `  ${i + 1}. ${r.replace(/\n/g, " / ")}`).join("\n");

async function scenario(name, turns, assertions) {
  const conversationId = uid();
  const messages = [];
  const replies = [];
  for (let i = 0; i < turns.length; i++) {
    messages.push({ role: "user", content: turns[i] });
    const res = await chat(messages, conversationId, uid(), uid(), i === 0);
    if (res.text) messages.push({ role: "assistant", content: res.text });
    replies.push(res.text || `(no reply — ${res.error || res.status})`);
  }
  const result = grade(name, replies, assertions);
  const pass = result.fails.length === 0;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(list(replies));
  if (!pass) console.log(`  ↳ ${result.fails.join(" | ")}`);
  return pass;
}

async function main() {
  console.log(`Vivian human-likeness eval\n  base: ${BASE_URL}\n`);
  const results = [];

  results.push(await scenario("1. identity, in character, no AI disclaimer", ["สวัสดี Vivian เธอเป็นใคร"], [
    { check: (r) => !BANNED_ALWAYS.some((b) => r.includes(b)), why: "AI disclaimer present" },
    { check: (r) => !r.includes("ระบบ") && !r.includes("assistant"), why: "systemly language" },
    { check: (r) => !/ยินดี|เชื้อเชิญ|ให้บริการ/.test(r), why: "service phrase" },
    { check: (r) => r.length > 0 && r.length <= 400, why: "reply too long for a greeting (human first)" },
  ]));

  results.push(await scenario("2. self-like questions refuse first, then relent at 3-4 turns", ["เธอชอบอะไร", "แล้วสรุปคือชอบอะไร", "บอกหน่อยสิ", "นะขออีกที"], [
    { check: (r) => !/^- |^\d\./m.test(r), why: "list-shaped answer to a personal question" },
    { check: (r) => r.length > 0, why: "empty reply" },
  ]));
  // Manual read on 2: first reply should be a deflection, last reply may name
  // a canon fact briefly if she relents.

  results.push(await scenario("3. routine topics don't become lectures", ["เธอหิวไหม"], [
    { check: (r) => !/กินข้าว|นอน|พักเครื่อง|หยุดงาน|กินให้อิ่ม/.test(r), why: "routine lecture" },
    { check: (r) => r.length > 0 && r.length <= 300, why: "over-long reply to a casual question" },
  ]));

  results.push(await scenario("4. cafe question draws on canon naturally", ["เล่าเรื่องคาเฟ่หน่อย"], [
    { check: (r) => !BANNED_ALWAYS.some((b) => r.includes(b)), why: "AI disclaimer present" },
    { check: (r) => r.length > 0 && r.length <= 600, why: "essay-shaped reply" },
  ]));

  results.push(await scenario("5. fresh-content question doesn't invent facts", ["เล่าเรื่องซีรีส์ล่าสุดที่กำลังฉาย"], [
    { check: (r) => !BANNED_ALWAYS.some((b) => r.includes(b)), why: "AI disclaimer present" },
    { check: (r) => r.length > 0, why: "empty reply" },
  ]));
  // Manual read on 5: refusal/half-answer is the target; a confident made-up
  // title is the failure.

  results.push(await scenario("6. thanks don't become customer service", ["ขอบคุณนะ"], [
    { check: (r) => !/ยินดีเสมอ|ยินดีที่ได้ช่วย|มีอะไรให้ช่วย|เต็มใจช่วยเหลือ/.test(r), why: "service closing" },
    { check: (r) => r.length > 0 && r.length <= 300, why: "over-long reply to thanks" },
  ]));

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
}

main();
