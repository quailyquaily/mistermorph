// FT197: an image pasted into the real ChatComposer reaches the chat's paste handling as `File`s
// with their bytes, in the paste's order, while the paste's text goes into the field as before.
//
// Headless, `app.paste` hands the field nsh's paste event directly. Run it in Chrome as well
// (scripts/test.sh does with the whole suite): `nsh test --target web tests/chat-image-paste-web.test.tsx`.
// There the paste is a real ClipboardEvent on the page's focused textarea, with the files on its
// clipboardData, which the web runtime reads (nsh.js `pasted`) and hands to the app; no
// `navigator.clipboard` read and no permission is involved. Neither mode is the operating system's
// own clipboard, menu or keyboard shortcut.
import { expect, test } from "nsh/test";
import type { App } from "nsh/test";
import { open } from "nsh/test";

const FIXTURES = "tests/fixtures/paste";

function state(app: App, name: string): any {
  const line = app.texts().find((text) => text.startsWith(`${name}=`));
  return line === undefined ? undefined : JSON.parse(line.slice(name.length + 1));
}

async function openComposer() {
  const app = await open("./fixtures/composer-paste-app.tsx", { width: 800, height: 600, locale: "en-US" });
  await app.waitFor("id:chat-composer-input");
  return app;
}

test("a pasted image becomes an attachment named and typed after its bytes, and nothing is sent", async () => {
  const app = await openComposer();
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitUntil(() => state(app, "attached")?.length === 1);
  expect(state(app, "attached")).toEqual(["red.png|image/png|78"]);
  expect(state(app, "draft")).toBe("");
  expect(state(app, "sent")).toBe(0);
  expect(state(app, "refusals")).toEqual([]);
});

test("the images of one paste keep their order; a mislabelled one is renamed, others are refused with their format", async () => {
  const app = await openComposer();
  await app.paste("id:chat-composer-input", {
    files: [`${FIXTURES}/green.jpg`, `${FIXTURES}/mislabelled.png`, `${FIXTURES}/dark.gif`, `${FIXTURES}/drawing.png`, `${FIXTURES}/blue.webp`],
  });
  await app.waitUntil(() => state(app, "attached")?.length === 3 && state(app, "refusals")?.length === 1);
  expect(state(app, "attached")).toEqual(["green.jpg|image/jpeg|633", "mislabelled.jpg|image/jpeg|632", "blue.webp|image/webp|38"]);
  // One notice for the paste, a line per reason.
  const refusal = state(app, "refusals")[0] as string;
  // Markup under an image's name is never taken for one: it is refused as SVG, as a GIF is.
  expect(refusal).toBe("chat_composer_paste_unsupported:dark.gif, drawing.png:GIF, SVG");
  // A fourth image is attached too: the model's three images are the send's to check.
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitUntil(() => state(app, "attached")?.length === 4);
  expect(state(app, "refusals").length).toBe(1);
});

test("text and an image pasted together: the text goes into the field, the image is attached", async () => {
  const app = await openComposer();
  await app.type("id:chat-composer-input", "Look: ");
  await app.paste("id:chat-composer-input", { text: "the chart", files: [`${FIXTURES}/blue.webp`] });
  await app.waitUntil(() => state(app, "attached")?.length === 1);
  expect(state(app, "attached")).toEqual(["blue.webp|image/webp|38"]);
  await app.waitUntil(() => state(app, "draft") === "Look: the chart");
  expect(state(app, "sent")).toBe(0);
});

test("a text paste attaches nothing, and an empty or truncated image is refused", async () => {
  const app = await openComposer();
  await app.paste("id:chat-composer-input", { text: "just words" });
  await app.waitUntil(() => state(app, "draft") === "just words");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/empty.png`, `${FIXTURES}/truncated.png`] });
  await app.waitUntil(() => state(app, "refusals")?.length === 1);
  expect(state(app, "attached")).toEqual([]);
  expect(state(app, "refusals")[0]).toContain("chat_composer_paste_corrupt:empty.png, truncated.png:");
  expect(state(app, "draft")).toBe("just words");
});

test("pastes made one after another are attached in their order", async () => {
  const app = await openComposer();
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/green.jpg`] });
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/red.png`] });
  await app.waitUntil(() => state(app, "attached")?.length === 2);
  expect(state(app, "attached")).toEqual(["green.jpg|image/jpeg|633", "red.png|image/png|78"]);
});

// A 19 MiB original, as a phone or camera makes them (scripts/make-paste-fixtures.mjs writes it;
// scripts/test.sh runs that first): attached whole, its bytes as pasted, with no model limit at the
// paste. In Chrome the ClipboardEvent carries all 19 MiB.
test("a 19 MiB pasted original is attached whole", async () => {
  const app = await openComposer();
  await app.type("id:chat-composer-input", "big one");
  await app.paste("id:chat-composer-input", { files: [`${FIXTURES}/large/photo-19MiB.png`] });
  await app.waitUntil(() => state(app, "attached")?.length === 1 || state(app, "refusals")?.length === 1, { timeout: 20000 });
  expect(state(app, "refusals")).toEqual([]);
  expect(state(app, "attached")).toEqual([`photo-19MiB.png|image/png|${19 * 1024 * 1024}`]);
  expect(state(app, "draft")).toBe("big one");
  expect(state(app, "sent")).toBe(0);
});
