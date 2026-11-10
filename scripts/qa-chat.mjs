#!/usr/bin/env node
/**
 * Regression check for the chat pipeline.
 *
 * Covers the reported bug ("the app says it can't access its language module")
 * and the design that fixes it:
 *   1. device questions (facts, maths, time) are answered instantly, offline
 *   2. a genuinely open-ended question reaches the model
 *   3. repeating it is served from cache instead of spending model quota
 *   4. no reply may contain the old "isn't connected" excuse
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

async function askOpenEnded() {
  let result = await post({ messages: [{ role: "user", content: OPEN_ENDED }] });
  if (result.json?.mode !== "ai") {
    // The shared model allows roughly one reply per 45s per IP; wait it out once.
    console.log("info  open-ended fell back, waiting out the shared-model window…");
    await sleep(50_000);
    result = await post({ messages: [{ role: "user", content: OPEN_ENDED }] });
  }
  return result;
}

async function main() {
  console.log("building…");
  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    console.error("build failed");
    process.exit(1);
  }

  const nextBin = path.join("node_modules", "next", "dist", "bin", "next");
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    stdio: "ignore",
    env: process.env,
  });

  try {
    await waitForServer(server);

    // 1. A known fact is answered instantly on-device.
    const fact = await post({
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });
    const factReply = fact.json?.reply ?? "";
    console.log(`info  fact: mode=${fact.json?.mode} source=${fact.json?.source} reply=${factReply.slice(0, 120)}`);
    if (fact.status !== 200) fail(`fact question returned HTTP ${fact.status}`);
    else if (!/paris/i.test(factReply)) fail("fact question was not answered with Paris");
    else if (fact.json?.source !== "device") fail("a known fact should be answered on-device");
    else pass("known fact answered on-device");

    // 2. An open-ended question must reach the model.
    const open = await askOpenEnded();
    const openReply = open.json?.reply ?? "";
    console.log(`info  open: mode=${open.json?.mode} source=${open.json?.source} provider=${open.json?.provider ?? "-"}`);
    console.log(`info  open reply: ${openReply.slice(0, 200)}`);
    if (open.json?.mode !== "ai") {
      fail(`open-ended question did not reach a model (note: ${open.json?.note ?? "none"})`);
    } else if (openReply.length < 15) {
      fail("open-ended reply was too short to be a real answer");
    } else {
      pass("open-ended question answered by the model");
    }

    // 3. Repeating it must come from cache, not the rate-limited model.
    const repeat = await post({ messages: [{ role: "user", content: OPEN_ENDED }] });
    console.log(`info  repeat: mode=${repeat.json?.mode} source=${repeat.json?.source}`);
    if (repeat.json?.source !== "cache") fail("repeated question should be served from cache");
    else pass("repeated question served from cache");

    // 4. The reported bug: never blame a missing module.
    for (const reply of [factReply, openReply, repeat.json?.reply ?? ""]) {
      if (/isn'?t connected|language module|can'?t access/i.test(reply)) {
        fail(`reply still blames a missing module: ${reply.slice(0, 120)}`);
      }
    }

    // 5. On-device answers still work with the network model switched off.
    const conversion = await post({
      messages: [{ role: "user", content: "convert 20 celsius to fahrenheit" }],
      useCommunityModel: false,
    });
    const conversionReply = conversion.json?.reply ?? "";
    console.log(`info  conversion: mode=${conversion.json?.mode} reply=${conversionReply.slice(0, 120)}`);
    if (conversion.json?.mode !== "offline") fail("conversion should be answered on-device");
    else if (!/68/.test(conversionReply)) fail("20C should convert to 68F");
    else pass("unit conversion answered on-device");

    const time = await post({
      messages: [{ role: "user", content: "what time is it" }],
      useCommunityModel: false,
    });
    const timeReply = time.json?.reply ?? "";
    console.log(`info  time: mode=${time.json?.mode} reply=${timeReply.slice(0, 120)}`);
    if (!/\d{1,2}[:.]\d{2}/.test(timeReply)) fail("time question did not return a clock time");
    else pass("time answered on-device");

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
