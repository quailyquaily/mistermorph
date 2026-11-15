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
  // A payload without sources (an older agent) is the single stack: one total, one bar a day.
  await app.waitFor("RANGE TOTAL");
  expect(await app.shows("id:stats-daily-key-coder")).toBe(false);
  expect(await app.shows("AGENT TOTAL")).toBe(false);
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

// A range as an agent that splits the usage by source reports it: every day has the agent's own
// calls and coder runs, with claude-opus-5-5 on both sides.
function sourcedDaily(days: number, withCoder = true) {
  const totals = (requests: number, cost: number, extra: Record<string, unknown> = {}) => ({
    requests,
    total_cost: cost,
    total_tokens: cost * 100,
    input_tokens: cost * 100,
    cost_currency: "USD",
    ...extra,
  });
  const model = (name: string, requests: number, cost: number) => ({ model: name, ...totals(requests, cost) });
  const coderCost = withCoder ? 3 : 0;
  const agentDay = { totals: totals(3, 2), models: [model("claude-opus-5-5", 1, 0.5), model("gpt-5.2", 2, 1.5)] };
  const coderDay = withCoder
    ? { totals: totals(2, 3, { cost_estimated: true }), models: [model("claude-opus-5-5", 2, 3)] }
    : { totals: { requests: 0 }, models: [] };
  const list = Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.UTC(2026, 10, 15 - (days - 1 - i))).toISOString().slice(0, 10),
    ...totals(withCoder ? 5 : 3, 2 + coderCost),
    models: [model("claude-opus-5-5", withCoder ? 3 : 1, 0.5 + coderCost), model("gpt-5.2", 2, 1.5)],
    sources: { agent: agentDay, coder: coderDay },
  }));
  return {
    to: list[list.length - 1].date,
    days: list,
    summary: totals(days * (withCoder ? 5 : 3), days * (2 + coderCost)),
    models: [model("claude-opus-5-5", days * (withCoder ? 3 : 1), days * (0.5 + coderCost)), model("gpt-5.2", days * 2, days * 1.5)],
    sources: {
      agent: { summary: totals(days * 3, days * 2), models: [model("claude-opus-5-5", days, days * 0.5), model("gpt-5.2", days * 2, days * 1.5)] },
      coder: withCoder
        ? { summary: totals(days * 2, days * 3, { cost_estimated: true }), models: [model("claude-opus-5-5", days * 2, days * 3)] }
        : { summary: { requests: 0 }, models: [] },
    },
  };
}

test("the daily chart shows agent and coder apart when the range has coder runs", async () => {
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      "GET /proxy:/stats/llm/usage": { body: usage },
      "GET /proxy:/stats/llm/daily": (request) => ({ body: sourcedDaily(Number(new URLSearchParams(request.uri!.split("?")[1]).get("days"))) }),
    },
  });
  await app.waitFor("id:stats-daily-plot");
  // Two bars a day; the legend ends with the key to which is whose (full tone, lighter tone).
  await app.waitFor("id:stats-daily-key-agent");
  await app.waitFor("id:stats-daily-key-coder");
  // Two totals and two averages, in place of the one; the coder's cost is marked as list price.
  await app.waitFor("AGENT TOTAL");
  await app.waitFor("CODER TOTAL");
  await app.waitFor("$14.00"); // the agent's 7 days
  await app.waitFor("$21.00"); // the coder's
  await app.waitFor("list price");
  await app.waitFor("AGENT AVG / DAY");
  await app.waitFor("CODER AVG / DAY");
  await app.waitFor("$2.00");
  await app.waitFor("$3.00");
  expect(await app.shows("RANGE TOTAL")).toBe(false);

  // The tooltip has a group per source, each under its subtotal.
  await app.hover("id:stats-daily-plot");
  await app.waitFor("id:stats-daily-tip-agent:head");
  await app.waitFor("id:stats-daily-tip-coder:head");
  await app.waitFor("1 req"); // the agent's claude-opus-5-5
  await app.waitFor("2 req"); // gpt-5.2, and the coder's claude-opus-5-5
  await app.press("id:stats-daily-plot");

  // A legend entry isolates that model in both bars: each total is its own.
  await app.press("id:stats-daily-legend-claude-opus-5-5");
  await app.waitFor("$3.50"); // the agent's claude-opus-5-5 over the range
  await app.waitFor("$21.00");
  await app.press("id:stats-daily-legend-claude-opus-5-5");
  await app.press("id:stats-daily-legend-gpt-5.2");
  await app.waitFor("$10.50"); // the agent's gpt-5.2; the coder ran none
  expect(await app.shows("$21.00")).toBe(false);
  await app.press("id:stats-daily-legend-gpt-5.2");
  await app.waitFor("$14.00");

  // Tokens are not money: no list price mark.
  await app.press("role:tab[Tokens]");
  await app.waitFor("CODER TOTAL");
  expect(await app.shows("list price")).toBe(false);
  // The cache view keeps the two bars and its own figures.
  await app.press("role:tab[Cache]");
  await app.waitFor("Uncached");
  await app.waitFor("id:stats-daily-key-coder");

  // The other ranges ask again and stay split.
  await app.press("role:tab[Cost]");
  await app.press("role:tab[90D]");
  await app.waitFor("$180.00"); // the agent's 90 days
  await app.waitFor("$270.00");
  await app.waitFor("id:stats-daily-key-coder");
});

test("a range without coder runs draws the single stack", async () => {
  const { app } = await openConsole({
    location: "/e/default/stats",
    api: {
      "GET /proxy:/stats/llm/usage": { body: usage },
      "GET /proxy:/stats/llm/daily": (request) => ({ body: sourcedDaily(Number(new URLSearchParams(request.uri!.split("?")[1]).get("days")), false) }),
    },
  });
  await app.waitFor("id:stats-daily-plot");
  await app.waitFor("RANGE TOTAL");
  await app.waitFor("$14.00");
  await app.waitFor("7/7");
  expect(await app.shows("id:stats-daily-key-agent")).toBe(false);
  expect(await app.shows("id:stats-daily-key-coder")).toBe(false);
  expect(await app.shows("CODER TOTAL")).toBe(false);
  // The tooltip is the day's models under its one total, without groups.
  await app.hover("id:stats-daily-plot");
  await app.waitFor("2 req");
  expect(await app.shows("id:stats-daily-tip-agent:head")).toBe(false);
});
