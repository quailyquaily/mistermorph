// ModelRoutesPanel, AuthProfilesPanel, LLMConfigForm, InferenceProviderPicker and the Markdown
// editor, mounted on their own.
import { expect, test } from "nsh/test";
import { openFixture, out } from "./fixtures/settings-fields-open";

test("routes: select a route, split it, step the shares and save", async () => {
  const { app } = await openFixture("/routes");
  await app.waitFor("id:route-main_loop");
  // A legacy route stays visible while set, and a route to an unknown profile shows it as missing.
  expect(app.texts()).toContain("LEGACY");
  expect(app.shows("text:No profile has this name.")).toBe(true);
  await app.press("id:route-main_loop");
  await app.waitFor("text:Reset to default");
  await app.press("id:profile-smart >> label:Split");
  await app.waitUntil(() => out(app, "dirty") === "true");
  await app.press("id:line-more-smart");
  await app.press("id:routes-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  const saved = JSON.parse(out(app, "saved"));
  expect(saved.config_changes["llm.routes.main_loop"]).toEqual({
    candidates: [
      { profile: "cheap", weight: 45 },
      { profile: "smart", weight: 55 },
    ],
  });
});

test("routes: a fallback is added in order, and a problem blocks the save", async () => {
  const { app } = await openFixture("/routes");
  await app.waitFor("id:route-main_loop");
  await app.press("id:route-main_loop");
  await app.press("id:profile-default >> label:Fallback");
  await app.waitFor("text:FALLBACK 1");
  await app.press("text:Done");
  // Addressing names a profile that does not exist: saving says so.
  await app.press("id:route-addressing");
  await app.press("id:profile-smart >> label:Fallback");
  await app.press("id:routes-save");
  await app.waitFor('text:Addressing: No profile is named "ghost".');
  expect(out(app, "saved")).toBe("null");
});

test("routes: Add profile asks the page to start one", async () => {
  const { app } = await openFixture("/routes");
  // The dashed add button is a plus, named "Add profile".
  await app.waitFor("label:Add profile");
  expect(app.texts()).not.toContain("Add profile");
  await app.press("label:Add profile");
  await app.waitUntil(() => out(app, "added") === "1");
});

test("auth profiles: Save waits for a complete profile and sends the list", async () => {
  const { app } = await openFixture("/auth");
  await app.waitFor("text:AUTH PROFILES");
  await app.press("label:Add auth profile");
  expect(app.enabled("id:auth-save")).toBe(false);
  await app.type("label:Name 2", "slack");
  await app.type("label:Credential secret 2", "xoxb-1");
  await app.type("label:Allowed URL prefixes 2", "https://slack.com/api/");
  await app.press("id:auth >> label:POST >> nth=1");
  await app.waitUntil(() => app.enabled("id:auth-save"));
  await app.press("id:auth-save");
  await app.waitUntil(() => out(app, "saved") !== "null");
  const saved = JSON.parse(out(app, "saved"));
  expect(saved).toHaveLength(2);
  expect(saved[0].original_name).toBe("github");
  expect(saved[1]).toMatchObject({
    name: "slack",
    credential_secret: "xoxb-1",
    url_prefixes: ["https://slack.com/api/"],
    methods: ["POST"],
    deny_private_ips: true,
  });
  expect(saved[1].bindings.url_fetch.inject).toEqual({ location: "header", name: "Authorization", format: "bearer" });
});

test("auth profiles: bad bindings JSON is reported, and a profile can be removed", async () => {
  const { app } = await openFixture("/auth");
  await app.waitFor("text:Advanced bindings (JSON)");
  await app.press("text:Advanced bindings (JSON)");
  await app.type("label:Advanced bindings 1", "}");
  await app.press("id:auth-save");
  await app.waitFor("text:Bindings must be valid JSON.");
  await app.press("id:auth-profile-remove-1");
  await app.press("id:auth-save");
  await app.waitUntil(() => out(app, "saved") === "[]");
});

test("llm form: changing provider clears the endpoint and shows that provider's fields", async () => {
  const { app } = await openFixture("/llm");
  await app.waitFor("id:llm-provider-trigger");
  expect(app.shows("text:OpenAI")).toBe(true);
  // The context window comes from a variable: shown locked.
  expect(app.shows("text:CTX=200000")).toBe(true);
  await app.press("id:llm-provider-trigger");
  await app.waitFor("id:inference-provider-dialog");
  await app.type("id:inference-provider-filter", "grok");
  await app.press("text:xAI Grok OAuth");
  await app.waitUntil(() => out(app, "events").includes("model=grok-4.5"));
  const events = JSON.parse(out(app, "events"));
  expect(events.slice(0, 3)).toEqual(["inference_provider=xai_oauth", "endpoint=", "api_key="]);
  // xAI OAuth signs in instead of taking a key.
  await app.waitFor("id:llm-xai-auth");
  expect(app.shows("id:llm-api_key")).toBe(false);
  await app.press("id:llm-xai-auth");
  await app.waitUntil(() => out(app, "events").includes("xai-auth"));
});

test("llm form: the model picker waits for a key, and fields report their edits", async () => {
  const { app } = await openFixture("/llm");
  await app.waitFor("id:llm-model");
  expect(app.enabled("id:llm-model-picker")).toBe(false);
  await app.type("id:llm-api_key-input", "sk-1");
  await app.waitUntil(() => app.enabled("id:llm-model-picker"));
  await app.press("id:llm-model-picker");
  await app.waitUntil(() => out(app, "events").includes("model-picker"));
  await app.press("label:image");
  await app.waitUntil(() => out(app, "events").includes("abilities=text,image"));
});

test("provider picker: groups by tab, and a filter that matches nothing says so", async () => {
  const { app } = await openFixture("/llm");
  await app.press("id:llm-provider-trigger");
  await app.waitFor("text:Google Gemini");
  expect(app.shows("text:Magpie")).toBe(false);
  await app.press("role:tab[Gateway]");
  await app.waitFor("text:Magpie");
  await app.type("id:inference-provider-filter", "zzz");
  await app.waitFor("text:No matching providers");
});

test("markdown editor: inserts a reference at the caret and previews", async () => {
  const { app } = await openFixture("/markdown");
  await app.waitFor("id:md");
  await app.press("id:insert");
  await app.waitUntil(() => out(app, "doc") === "# Title\n\nHello [Bob](tg:7)");
  await app.press("id:md-preview");
  await app.waitFor("text:Title");
  expect(app.shows("text:Markdown is supported.")).toBe(true);
});

test("markdown editor: a contact is mentioned from the toolbar", async () => {
  const { app } = await openFixture("/markdown", {
    "GET /proxy": () => ({ body: { items: [{ contact_id: "tg:42", nickname: "Alice", channel: "telegram" }] } }),
  });
  await app.waitFor("id:markdown-editor-mention");
  await app.press("id:markdown-editor-mention");
  await app.waitFor("id:markdown-editor-mention-dialog");
  await app.waitFor("text:Alice");
  await app.press("text:Alice");
  await app.waitUntil(() => out(app, "doc").endsWith("[Alice](tg:42)"));
});

test("markdown editor: conversations that fail to load say so, and read-only blocks the toolbar", async () => {
  const { app } = await openFixture("/markdown", { "GET /proxy": { status: 500, body: { error: "down" } } });
  await app.waitFor("id:markdown-editor-conversation");
  await app.press("id:markdown-editor-conversation");
  await app.waitFor("text:Could not load conversations.");
  await app.press("id:markdown-editor-conversation-dialog >> label:Close");
  await app.press("id:readonly");
  await app.waitUntil(() => !app.enabled("id:markdown-editor-mention"));
});

test("markdown editor: typing in the source reports the text", async () => {
  const { app } = await openFixture("/markdown");
  await app.waitFor("id:md-source");
  await app.type("id:md-source", "!");
  await app.waitUntil(() => out(app, "doc") === "!# Title\n\nHello");
});

test("textarea editor: typing reports the text; no Edit / Preview switch, the toolbar stays", async () => {
  const { app } = await openFixture("/textarea");
  await app.waitFor("id:ta-source");
  expect(app.value("id:ta-source")).toBe("Ask Alice");
  expect(app.shows("id:ta-edit")).toBe(false);
  expect(app.shows("id:ta-preview")).toBe(false);
  expect(app.shows("id:ta-frame")).toBe(false);
  expect(app.shows("id:markdown-editor-mention")).toBe(true);
  expect(app.shows("id:markdown-editor-conversation")).toBe(true);
  await app.type("id:ta-source", " **now**");
  await app.waitUntil(() => out(app, "doc") === "Ask Alice **now**");
  await app.press("id:insert");
  await app.waitUntil(() => out(app, "doc") === "Ask Alice **now** [Bob](tg:7)");
  expect(app.value("id:ta-source")).toBe("Ask Alice **now** [Bob](tg:7)");
});

test("textarea editor: read-only and disabled take no typing, no insertion and no toolbar", async () => {
  const { app } = await openFixture("/textarea");
  await app.waitFor("id:ta-source");
  for (const toggle of ["readonly", "disabled"]) {
    await app.press(`id:${toggle}`);
    await app.waitUntil(() => !app.enabled("id:markdown-editor-mention"));
    expect(app.enabled("id:markdown-editor-conversation")).toBe(false);
    // The field itself is read-only: typing is refused.
    let refused = "";
    await app.type("id:ta-source", "x").catch((error: unknown) => (refused = String(error)));
    expect(refused).toContain("not editable");
    await app.press("id:insert");
    await app.waitUntil(() => out(app, "inserted") === "false");
    expect(out(app, "doc")).toBe("Ask Alice");
    expect(app.value("id:ta-source")).toBe("Ask Alice");
    await app.press(`id:${toggle}`);
    await app.waitUntil(() => app.enabled("id:markdown-editor-mention"));
  }
  await app.press("id:insert");
  await app.waitUntil(() => out(app, "doc") === "Ask Alice [Bob](tg:7)");
  expect(out(app, "inserted")).toBe("true");
});

test("textarea editor: another document's text replaces the field's, and an insertion goes at its end", async () => {
  const { app } = await openFixture("/textarea");
  await app.waitFor("id:ta-source");
  await app.type("id:ta-source", " soon");
  await app.press("id:other");
  await app.waitUntil(() => app.value("id:ta-source") === "Other text");
  await app.press("id:insert");
  await app.waitUntil(() => out(app, "doc") === "Other text [Bob](tg:7)");
});

// The Editor's rows are as tall as its text: a press in the room below it (the middle of this
// 320pt editor) reaches the view around the Editor, which focuses it with the caret at the end.
test("markdown editor: a press below the text focuses it at the end", async () => {
  const { app } = await openFixture("/markdown");
  await app.waitFor("id:md-frame");
  await app.press("id:md-frame");
  await app.keyboard.press("x");
  await app.waitUntil(() => out(app, "doc") === "# Title\n\nHellox");
  // The reference goes in at the caret the press placed.
  await app.press("id:insert");
  await app.waitUntil(() => out(app, "doc") === "# Title\n\nHellox [Bob](tg:7)");
});

test("markdown editor: a press below the text of a read-only editor changes nothing; the preview has none", async () => {
  const { app } = await openFixture("/markdown");
  await app.waitFor("id:md-frame");
  await app.press("id:readonly");
  await app.press("id:md-frame");
  await app.keyboard.press("x");
  await app.wait(100);
  expect(out(app, "doc")).toBe("# Title\n\nHello");
  await app.press("id:readonly");
  await app.press("id:md-preview");
  await app.waitFor("text:Title");
  expect(app.shows("id:md-frame")).toBe(false);
  await app.press("id:md-edit");
  await app.press("id:md-frame");
  await app.keyboard.press("y");
  await app.waitUntil(() => out(app, "doc") === "# Title\n\nHelloy");
});
