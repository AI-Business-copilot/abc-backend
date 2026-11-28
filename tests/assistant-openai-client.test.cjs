const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const { requestOpenAiText } = require("../src/modules/assistant/openai-client");
const prompt = { instructions: "Respond briefly.", input: "Synthetic example only." };

async function withMockFetch(fetchMock, run) {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "fake-key-for-local-test";
  process.env.OPENAI_MODEL = "fake-model";
  global.fetch = fetchMock;
  try {
    await run();
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = originalModel;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("sends a bounded Responses API request and extracts text after reasoning output", async () => {
  let captured;
  await withMockFetch(async (url, options) => {
    captured = { url, options };
    return jsonResponse({
      status: "completed",
      output: [
        { type: "reasoning" },
        { type: "message", role: "assistant", content: [
          { type: "output_text", text: "Hello" },
          { type: "output_text", text: "world" },
        ] },
      ],
    });
  }, async () => {
    assert.equal(await requestOpenAiText(prompt), "Hello\nworld");
    assert.equal(captured.url, "https://api.openai.com/v1/responses");
    assert.equal(captured.options.headers.Authorization, "Bearer fake-key-for-local-test");
    assert.equal(captured.options.redirect, "error");
    assert.deepEqual(JSON.parse(captured.options.body), {
      model: "fake-model", instructions: prompt.instructions, input: prompt.input,
      store: false, max_output_tokens: 1024,
    });
  });
});

test("rejects missing configuration and invalid inputs without sending a request", async () => {
  let called = false;
  await withMockFetch(async () => { called = true; throw new Error("unexpected request"); }, async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(requestOpenAiText(prompt), { statusCode: 503 });
    process.env.OPENAI_API_KEY = "fake-key-for-local-test";
    await assert.rejects(requestOpenAiText({ ...prompt, input: " " }), { statusCode: 400 });
    await assert.rejects(requestOpenAiText({ ...prompt, input: "a".repeat(12_001) }), { statusCode: 400 });
    process.env.OPENAI_MODEL = "invalid model";
    await assert.rejects(requestOpenAiText(prompt), { statusCode: 503 });
    assert.equal(called, false);
  });
});

test("rejects refusals, incomplete responses, unexpected calls and invalid JSON", async () => {
  const responses = [
    jsonResponse({ status: "incomplete", output: [] }),
    jsonResponse({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] }),
    jsonResponse({ status: "completed", output: [{ type: "function_call" }] }),
    jsonResponse({ status: "completed", output: [] }),
    new Response("{bad json", { status: 200 }),
    new Response("a".repeat(256_001), { status: 200 }),
  ];
  await withMockFetch(async () => responses.shift(), async () => {
    for (let i = 0; i < 6; i += 1) {
      await assert.rejects(requestOpenAiText(prompt), { statusCode: 502 });
    }
  });
});

test("reports API errors and timeouts without exposing provider response details", async () => {
  const responses = [
    jsonResponse({ error: "private details" }, 401),
    jsonResponse({ error: "private details" }, 429),
  ];
  await withMockFetch(async () => {
    if (responses.length) return responses.shift();
    throw new DOMException("timeout", "TimeoutError");
  }, async () => {
    await assert.rejects(requestOpenAiText(prompt), (error) => error.statusCode === 502 && !error.message.includes("private details"));
    await assert.rejects(requestOpenAiText(prompt), { statusCode: 503 });
    await assert.rejects(requestOpenAiText(prompt), { statusCode: 504 });
  });
});
