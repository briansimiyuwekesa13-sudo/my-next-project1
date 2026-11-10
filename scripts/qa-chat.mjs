#!/usr/bin/env node
/**
 * Regression check for the chat pipeline.
 *
 * Covers the reported bug ("the app says it can't access its language module")
 * and the contract the Groq upgrade establishes:
 *   1. device questions (facts, maths, time, conversions) answer instantly,
 *      with no key and no network
 *   2. an open-ended question with no key returns an honest no_key message that
 *      asks for a key — it never quietly uses a shared community model
 *   3. no reply may contain the old "isn't connected" / "language module" excuse
 *
 * Model connectivity, the saved key, conversation context and every Groq error
 * path are asserted separately by `npm run qa:groq`, which runs against a mock
 * of Groq's API so no quota is spent.
 *
 * Builds, boots `next start` on a private port, asserts, then exits nonzero on
 * any failure so it can be used as a CI check.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];

const OPEN_ENDED = "Explain in one sentence why the sky looks blue.";

function fail(message) {
  failures.push(message);
  console.error(`FAIL  ${message}`);
}

function pass(message) {
  console.log(`PASS  ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(payload) {
  const response = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* asserted by callers */
  }
  return { status: response.status, json, text };
}

async function waitForServer(child) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error("server exited early");
    try {
      const response = await fetch(`${BASE}/api/status`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("server did not become ready in 60s");
}

async function main() {
  console.log("building…");
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    console.error("build failed");
    process.exit(1);
  }

  const nextBin = path.join("node_modules", "next", "dist", "bin", "next");
  const env = { ...process.env };
  delete env.GROQ_API_KEY;

  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    stdio: "ignore",
    env,
  });

  const replies = [];

  try {
    await waitForServer(server);

    // 1. A known fact is answered instantly on-device, with no key at all.
    const fact = await post({ message: "What is the capital of France?" });
    const factReply = fact.json?.reply ?? "";
    replies.push(factReply);
    console.log(`info  fact: mode=${fact.json?.mode} source=${fact.json?.source} reply=${factReply.slice(0, 120)}`);
    if (fact.status !== 200) fail(`fact question returned HTTP ${fact.status}`);
    else if (!/paris/i.test(factReply)) fail("fact question was not answered with Paris");
    else if (fact.json?.source !== "device") fail("a known fact should be answered on-device");
    else pass("known fact answered on-device");

    // 2. No key: an open-ended question must say so, not fake an answer.
    const open = await post({ message: OPEN_ENDED });
    const openReply = open.json?.reply ?? "";
    replies.push(openReply);
    console.log(`info  open: status=${open.status} code=${open.json?.code} source=${open.json?.source}`);
    console.log(`info  open reply: ${openReply.slice(0, 200)}`);
    if (open.status !== 503) fail(`open-ended question without a key should be 503, got ${open.status}`);
    else if (open.json?.code !== "no_key") fail("open-ended question without a key should report no_key");
    else if (!/key/i.test(openReply)) fail("the no-key reply should ask for a Groq key");
    else if (open.json?.source === "community") fail("there must be no community-model fallback");
    else pass("open-ended question without a key asks for a key instead of falling back");

    // 3. The old excuse must never come back.
    for (const reply of replies) {
      if (/isn'?t connected|language module|can'?t access/i.test(reply)) {
        fail(`reply still blames a missing module: ${reply.slice(0, 120)}`);
      }
    }
    pass("no reply blames a missing language module");

    // 4. Utilities keep working offline.
    const conversion = await post({ message: "convert 20 celsius to fahrenheit" });
    const conversionReply = conversion.json?.reply ?? "";
    console.log(`info  conversion: mode=${conversion.json?.mode} reply=${conversionReply.slice(0, 120)}`);
    if (conversion.json?.mode !== "offline") fail("conversion should be answered on-device");
    else if (!/68/.test(conversionReply)) fail("20C should convert to 68F");
    else pass("unit conversion answered on-device");

    const time = await post({ message: "what time is it" });
    const timeReply = time.json?.reply ?? "";
    console.log(`info  time: mode=${time.json?.mode} reply=${timeReply.slice(0, 120)}`);
    if (!/\d{1,2}[:.]\d{2}/.test(timeReply)) fail("time question did not return a clock time");
    else pass("time answered on-device");

    // 5. A device intent is decided locally, so the words and the action agree.
    const alarm = await post({ message: "set an alarm for 7am" });
    console.log(`info  alarm: action=${alarm.json?.action?.type ?? "none"} reply=${(alarm.json?.reply ?? "").slice(0, 80)}`);
    if (alarm.json?.action?.type !== "alarm") fail("an alarm request should produce an alarm action");
    else pass("alarm request routed to the phone action");

    // 6. Rejections stay sane.
    const empty = await post({ messages: [] });
    if (empty.status !== 400) fail(`empty message should be 400, got ${empty.status}`);
    else pass("empty message rejected");
  } finally {
    server.kill("SIGKILL");
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall chat pipeline checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
