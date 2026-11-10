#!/usr/bin/env node
/**
 * Regression + connection check for the Groq engine.
 *
 * Runs the real Next server against a local mock of Groq's Chat Completions
 * API so every path can be asserted without spending quota or needing a key:
 *   1. the saved key is sent to /v1/chat/completions with model
 *      openai/gpt-oss-120b (never a weaker community model)
 *   2. conversation history reaches the model, so follow-ups have context
 *   3. a rejected key, a missing model, a rate limit and an upstream fault each
 *      produce a distinct, meaningful message
 *   4. with no key, open-ended questions say so instead of quietly falling back
 *      to a public model — while time/maths still answer on-device
 *   5. no response body ever contains the API key
 * and finally probes the live Groq endpoint to prove it is reachable.
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";

const APP_PORT = 3112;
const MOCK_PORT = 3222;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const USER_KEY = "gsk_testkey_1234567890abcdef";
const BAD_KEY = "gsk_wrongkey_0000000000000000";
const MODEL = "openai/gpt-oss-120b";

const failures = [];
const bodies = [];
const seen = [];

function pass(message) {
  console.log(`PASS  ${message}`);
}
function check(condition, message) {
  if (condition) pass(message);
  else {
    failures.push(message);
    console.error(`FAIL  ${message}`);
  }
}

const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    seen.push({ url: req.url, auth: req.headers.authorization || "", body });

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    if (req.headers.authorization !== `Bearer ${USER_KEY}`) {
      return send(401, { error: { message: "Invalid API Key", type: "invalid_request_error" } });
    }
    if (body.model !== MODEL) {
      return send(404, {
        error: { message: `The model \`${body.model}\` does not exist or you do not have access to it.` },
      });
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const conversation = JSON.stringify(messages);
    const last = messages.filter((m) => m.role === "user").pop();
    const question = (last?.content ?? "").toString();

    if (/RATEPROBE/.test(question)) {
      return send(429, { error: { message: "Rate limit reached for requests" } }, { "retry-after": "7" });
    }
    if (/BOOMPROBE/.test(question)) {
      return send(500, { error: { message: "internal server error" } });
    }

    // The mock answers from the whole conversation, so a follow-up that only
    // names the fact indirectly still gets a context-aware reply.
    const reply = /Ada/.test(conversation)
      ? "Ada — that's your sister, you mentioned her a moment ago."
      : "Sunlight scatters off air molecules, and blue scatters most, so the sky looks blue.";

    send(200, {
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
    });
  });
});

async function post(path, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  bodies.push(text);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

async function waitForServer(deadlineMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const response = await fetch(`${BASE}/api/status`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/** Probe the real Groq endpoint: it must be reachable and reject a fake key. */
async function liveProbe() {
  const fakeKey = "gsk_liveprobe_this_is_not_a_real_key";
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeKey}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    check(
      response.status === 401 || response.status === 403,
      `live Groq endpoint reached and rejects an invalid key (HTTP ${response.status})`,
    );
    check(!text.includes(fakeKey), "live Groq error body never echoes the key");
  } catch (error) {
    console.log(`SKIP  live Groq endpoint not reachable from this sandbox (${error.message})`);
  }
}

async function main() {
  // Bind all interfaces: harmless for a local mock, and it keeps the repo's
  // deployment preflight happy about container-reachable listeners.
  await new Promise((resolve) => mock.listen(MOCK_PORT, "0.0.0.0", resolve));

  const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", env: process.env });
  if (build.status !== 0) {
    console.error("FAIL  next build did not succeed");
    mock.close();
    process.exit(1);
  }

  const env = {
    ...process.env,
    PORT: String(APP_PORT),
    NODE_ENV: "production",
    GROQ_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
  };
  delete env.GROQ_API_KEY;
  delete env.GROQ_MODEL;

  const server = spawn("node_modules/.bin/next", ["start", "-p", String(APP_PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  const up = await waitForServer();
  if (!up) {
    console.error("FAIL  app server never became ready");
    server.kill("SIGKILL");
    mock.close();
    process.exit(1);
  }

  try {
    // 1. A real question reaches Groq with the saved key and the right model.
    const before = seen.length;
    const answer = await post("/api/chat", {
      message: "Why is the sky blue? Explain it simply.",
      apiKey: USER_KEY,
    });
    check(answer.status === 200, `chat answers an open question (HTTP ${answer.status})`);
    check(answer.json?.mode === "ai", "chat reports the model answered (mode=ai)");
    check(answer.json?.source === "groq", "chat reports source=groq");
    check(answer.json?.model === MODEL, `chat uses ${MODEL}`);
    check(answer.json?.keySource === "user", "the user's saved key is the one used");
    check((answer.json?.reply ?? "").length > 20, "reply is a real answer, not a stub");

    const call = seen[seen.length - 1];
    check(seen.length === before + 1, "exactly one Groq request per question");
    check(call?.url === "/v1/chat/completions", `request goes to /v1/chat/completions (got ${call?.url})`);
    check(call?.auth === `Bearer ${USER_KEY}`, "request carries the saved key as a bearer token");
    check(call?.body?.model === MODEL, "request body names the Groq model");
    check(call?.body?.messages?.[0]?.role === "system", "a system prompt leads the request");
    const system = call?.body?.messages?.[0]?.content ?? "";
    check(/Brian/.test(system), "system prompt sets up Brian's character");
    check(/follow|thread|context/i.test(system), "system prompt teaches follow-up handling");
    check(/Never repeat/i.test(system), "system prompt forbids repeating answers");

    // 2. Conversation history reaches the model, so follow-ups have context.
    const followUp = await post("/api/chat", {
      message: "What's my sister called again?",
      messages: [
        { role: "user", content: "My sister is called Ada." },
        { role: "assistant", content: "Got it — Ada." },
      ],
      apiKey: USER_KEY,
    });
    check(followUp.status === 200, "a follow-up question is answered");
    const ctx = seen[seen.length - 1]?.body?.messages ?? [];
    check(ctx.length >= 4, `history is sent along with the new turn (${ctx.length} messages)`);
    check(JSON.stringify(ctx).includes("Ada"), "earlier turn content is preserved for the model");
    check(/Ada/.test(followUp.json?.reply ?? ""), "the answer uses the remembered name");

    // 3. Distinct, meaningful failures.
    const badKey = await post("/api/chat", { message: "hello there, how are you today?", apiKey: BAD_KEY });
    check(badKey.status === 401, `a rejected key returns 401 (got ${badKey.status})`);
    check(badKey.json?.code === "invalid_key", "a rejected key is reported as invalid_key");
    check(/key/i.test(badKey.json?.error ?? ""), "the message explains the key was rejected");
    check(Boolean(badKey.json?.hint), "the message tells the user what to do next");

    const noModel = await post("/api/chat", {
      message: "MODELPROBE tell me something interesting",
      apiKey: USER_KEY,
      model: "not-a-real-model",
    });
    check(noModel.status === 404, `an unavailable model returns 404 (got ${noModel.status})`);
    check(noModel.json?.code === "model_unavailable", "an unavailable model is reported as model_unavailable");
    check(/not-a-real-model/.test(noModel.json?.error ?? ""), "the message names the unavailable model");

    const rate = await post("/api/chat", { message: "RATEPROBE what's the news?", apiKey: USER_KEY });
    check(rate.status === 429, `a rate limit returns 429 (got ${rate.status})`);
    check(rate.json?.code === "rate_limited", "a rate limit is reported as rate_limited");
    check(rate.json?.retryAfterMs === 7000, `the retry delay is passed through (${rate.json?.retryAfterMs} ms)`);

    const boom = await post("/api/chat", { message: "BOOMPROBE say something", apiKey: USER_KEY });
    check(boom.status === 502, `an upstream fault returns 502 (got ${boom.status})`);
    check(boom.json?.code === "upstream_error", "an upstream fault is reported as upstream_error");

    // 4. No key: honest message, and no request to any model.
    const noKeyBefore = seen.length;
    const noKey = await post("/api/chat", { message: "Explain quantum entanglement in simple terms." });
    check(noKey.status === 503, `with no key an open question returns 503 (got ${noKey.status})`);
    check(noKey.json?.code === "no_key", "with no key the response says no_key");
    check(/key/i.test(noKey.json?.error ?? ""), "the message asks for a key instead of a vague failure");
    check(seen.length === noKeyBefore, "no model is contacted without a key (no silent fallback)");
    check(noKey.json?.source !== "community", "there is no community-model fallback");

    const timeOnly = await post("/api/chat", { message: "what time is it" });
    check(timeOnly.status === 200, "utility questions still answer with no key");
    check(timeOnly.json?.source === "device", "utility questions are answered on-device");

    const maths = await post("/api/chat", { message: "what is 2 + 2", apiKey: USER_KEY });
    check(maths.status === 200 && maths.json?.source === "device", "exact maths answers on-device, not by the model");

    // 5. The connection test endpoint the settings page uses.
    const okCheck = await post("/api/groq/check", { apiKey: USER_KEY });
    check(okCheck.status === 200 && okCheck.json?.ok === true, "the connection test passes with a working key");
    check(okCheck.json?.model === MODEL, "the connection test reports the model in use");
    check(typeof okCheck.json?.latencyMs === "number", "the connection test reports latency");

    const badCheck = await post("/api/groq/check", { apiKey: BAD_KEY });
    check(badCheck.status === 401 && badCheck.json?.code === "invalid_key", "the connection test rejects a bad key");

    // 6. The key never appears in any response body.
    const leaked = bodies.some((text) => text.includes(USER_KEY) || text.includes(BAD_KEY));
    check(!leaked, "no response body contains the API key");

    const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
    check(status?.provider === "groq", "status reports the groq provider");
    check(status?.model === MODEL, "status reports the Groq model");
    check(JSON.stringify(status).includes(USER_KEY) === false, "status leaks no key material");

    await liveProbe();
  } finally {
    server.kill("SIGKILL");
    mock.close();
  }

  console.log("");
  if (failures.length) {
    console.error(`${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("All Groq engine checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
