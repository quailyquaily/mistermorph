import { expect, test } from "nsh/test";
import { openConsole } from "./harness";

const usage = {
  updated_at: "2026-11-06T08:00:00Z",
  projected_records: 1234,
  skipped_records: 2,
  summary: {
    requests: 42,
    total_tokens: 8404,
    input_tokens: 6000,
    output_tokens: 2404,
    cached_input_tokens: 3000,
    total_cost: 53.58,
    input_cost: 40,
    output_cost: 13.58,
    cost_currency: "USD",
  },
  api_hosts: [
    {
      api_host: "api.openai.com",
      requests: 40,
      total_tokens: 8000,
      input_tokens: 5800,
      output_tokens: 2200,
      total_cost: 50,
      cost_currency: "USD",
      models: [{ model: "gpt-5.2", requests: 40, total_tokens: 8000, input_tokens: 5800, cached_input_tokens: 2900, total_cost: 50 }],
    },
  ],
  models: [
    { model: "gpt-5.2", requests: 40, total_tokens: 8000, input_tokens: 5800, cached_input_tokens: 2900, total_cost: 50 },
    { model: "claude-sonnet-4", requests: 2, total_tokens: 404, input_tokens: 200, total_cost: 3.58 },
  ],
};

function day(date: string, cost: number, extra: Record<string, unknown> = {}) {
  return {
    date,
    requests: cost > 0 ? 3 : 0,
    input_tokens: cost * 100,
    output_tokens: cost * 10,
    total_tokens: cost * 110,
    cached_input_tokens: cost * 20,
    total_cost: cost,
    models:
      cost > 0
        ? [
            { model: "gpt-5.2", requests: 2, total_tokens: cost * 100, input_tokens: cost * 90, total_cost: cost - 0.5 },
            { model: "claude-sonnet-4", requests: 1, total_tokens: cost * 10, input_tokens: cost * 10, total_cost: 0.5 },
          ]
        : [],
    ...extra,
  };
}

function daily(days: number) {
  const list = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 7 - (days - 1 - i)));
    return day(d.toISOString().slice(0, 10), i % 3 === 0 ? 2 : 0);
  });
  return {
    to: list[list.length - 1].date,
    days: list,
    summary: { requests: 30, input_tokens: 2000, cached_input_tokens: 400, total_cost: 20, cost_currency: "USD" },
    models: [
      { model: "gpt-5.2", requests: 20, total_tokens: 2000, input_tokens: 1800, cached_input_tokens: 400, total_cost: 15 },
      { model: "claude-sonnet-4", requests: 10, total_tokens: 200, input_tokens: 200, total_cost: 5 },
    ],
  };
}

test("usage shows the summary, the daily chart, and the hosts and models", async () => {
  const { app, calls } = await openConsole({
    location: "/e/default/stats",
    api: {
      "GET /proxy:/stats/llm/usage": { body: usage },
      "GET /proxy:/stats/llm/daily": (request) => ({ body: daily(Number(new URLSearchParams(request.uri!.split("?")[1]).get("days"))) }),
    },
  });
  await app.waitFor("id:stats-page");
  await app.waitFor("$53.58");
  await app.waitFor("8,404"); // total tokens
  await app.waitFor("api.openai.com");
  await app.waitFor("id:stats-daily-plot");
  // The chart opens on the last 7 days.
  await app.waitFor("3/7"); // active days
  const dailyCall = calls.find((call) => call.uri?.startsWith("/stats/llm/daily"));
  expect(dailyCall?.uri).toContain("days=7");

  // Another range asks again for that many days.
  await app.press("role:tab[30D]");
  await app.waitUntil(() => calls.some((call) => call.uri?.includes("days=30")));
  await app.waitFor("10/30"); // active days
  await app.waitFor("$20.00"); // range total

  // Hovering a day shows its models in the tooltip; pressing pins it.
  await app.hover("id:stats-daily-plot");
  await app.waitFor("2 req");
  await app.press("id:stats-daily-plot");

  // A legend entry shows only that model: the range total is its own.
  await app.press("id:stats-daily-legend-claude-sonnet-4");
  await app.waitFor("$0.1667"); // its average per day
  await app.press("id:stats-daily-legend-claude-sonnet-4");
  await app.waitFor("$0.6667");

  // The cache view shows the cache figures.
  await app.press("role:tab[Cache]");
  await app.waitFor("Uncached");

  // By model lists every model.
  await app.press("role:tab[By Model]");
  await app.waitFor("claude-sonnet-4");
});

test("an agent without the daily route says so, and a failing usage call shows its error", async () => {
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      "GET /proxy:/stats/llm/usage": { status: 500, body: { error: "usage store unavailable" } },
      "GET /proxy:/stats/llm/daily": { status: 404, body: { error: "not found" } },
    },
  });
  await app.waitFor("usage store unavailable");
  // Shown in mono caps, as Vue's .stats-daily-empty.
  await app.waitFor("THIS AGENT DOES NOT REPORT DAILY USAGE YET. UPDATE IT TO SEE THIS CHART.");
  await app.waitFor("NO USAGE RECORDS");
});

test("an empty range says there were no requests", async () => {
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      "GET /proxy:/stats/llm/usage": { body: { summary: {}, api_hosts: [], models: [] } },
      "GET /proxy:/stats/llm/daily": { body: { days: [], summary: {}, models: [] } },
    },
  });
  await app.waitFor("NO REQUESTS IN THIS RANGE");
  await app.waitFor("NO USAGE RECORDS");
});
