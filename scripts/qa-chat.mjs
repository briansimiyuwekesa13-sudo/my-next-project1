#!/usr/bin/env node
/**
 * Regression check for the chat pipeline.
 *
 * Verifies the bug report "the app says it can't access its language module":
 *   1. a general-knowledge question must get a real answer (model or offline facts)
 *   2. no reply may contain the old "isn't connected" excuse
 *   3. device answers (unit conversion, time) still work with the model switched off
 *
 * Builds, boots `next start` on a private port, asserts, then exits nonzero on
 * any failure so it can be used as a CI check.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`FAIL  ${message}`);
}

function pass(message) {
  console.log(`PASS  ${message}`);
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
    /* asserted below */
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
  const server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], {
    stdio: "ignore",
    env: process.env,
  });

  try {
    await waitForServer(server);

    // 1. General knowledge must be answered.
    const general = await post({
      messages: [{ role: "user", content: "What is the capital of France?" }],
    });
    const generalReply = general.json?.reply ?? "";
    console.log(`info  general: mode=${general.json?.mode} provider=${general.json?.provider ?? "-"}`);
    console.log(`info  general reply: ${generalReply.slice(0, 160)}`);

    if (general.status !== 200) fail(`general question returned HTTP ${general.status}`);
    if (!/paris/i.test(generalReply)) fail("general question was not answered with Paris");
    else pass("general knowledge question answered");

    // 2. The reported bug: never blame a missing language module.
    for (const reply of [generalReply]) {
      if (/isn'?t connected|language module|can'?t access/i.test(reply)) {
        fail(`reply still blames a missing module: ${reply.slice(0, 120)}`);
      }
    }

    // 3. On-device answers still work with the network model switched off.
    const conversion = await post({
      messages: [{ role: "user", content: "convert 20 celsius to fahrenheit" }],
      useCommunityModel: false,
    });
    const conversionReply = conversion.json?.reply ?? "";
    console.log(`info  conversion: mode=${conversion.json?.mode} reply=${conversionReply.slice(0, 120)}`);
    if (conversion.json?.mode !== "offline") fail("conversion should be answered on-device");
    if (!/68/.test(conversionReply)) fail("20C should convert to 68F");
    else pass("unit conversion answered on-device");

    const time = await post({
      messages: [{ role: "user", content: "what time is it" }],
      useCommunityModel: false,
    });
    const timeReply = time.json?.reply ?? "";
    console.log(`info  time: mode=${time.json?.mode} reply=${timeReply.slice(0, 120)}`);
    if (!/\d{1,2}[:.]\d{2}/.test(timeReply)) fail("time question did not return a clock time");
    else pass("time answered on-device");

    // 4. Rejections stay sane.
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
