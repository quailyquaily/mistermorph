// The Button's loading state (components/ui.tsx): the ui-kit's moving stripe shows for as long as
// the action is pending and on no idle button, presses are blocked meanwhile, the button keeps its
// size, and the stripe goes when the action ends, saved or failed.
import { expect, open, test } from "nsh/test";

async function openGallery() {
  return open("./fixtures/button-loading-app.tsx", { width: 900, height: 900, platform: "linux", locale: "en-US" });
}

test("a pending action shows the stripe until it is saved, and blocks a second press", async () => {
  const app = await openGallery();
  expect(app.count("id:save-loading")).toBe(0);
  expect(app.enabled("id:save")).toBe(true);
  const idle = app.texts().find((text) => text.startsWith("width="));

  await app.press("id:save");
  expect(app.shows("id:save-loading")).toBe(true);
  expect(app.enabled("id:save")).toBe(false);
  await expect(app.press("id:save")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(app.texts()).toContain("runs=1");
  // The stripe is drawn over the button: it lays out at the width it had idle.
  expect(app.texts().find((text) => text.startsWith("width="))).toBe(idle);
  expect(idle).not.toBe("width=0");

  await app.press("id:settle-ok");
  expect(app.texts()).toContain("result=saved");
  expect(app.count("id:save-loading")).toBe(0);
  expect(app.enabled("id:save")).toBe(true);
  expect(app.texts().find((text) => text.startsWith("width="))).toBe(idle);
});

test("a failed action clears the stripe too, and the button works again", async () => {
  const app = await openGallery();
  await app.press("id:save");
  expect(app.shows("id:save-loading")).toBe(true);
  await app.press("id:settle-fail");
  expect(app.texts()).toContain("result=failed");
  expect(app.count("id:save-loading")).toBe(0);
  expect(app.enabled("id:save")).toBe(true);

  await app.press("id:save");
  expect(app.texts()).toContain("runs=2");
  expect(app.shows("id:save-loading")).toBe(true);
  await app.press("id:settle-ok");
  expect(app.count("id:save-loading")).toBe(0);
});

test("every variant draws the stripe while loading, keeps its label, and none when idle", async () => {
  const app = await openGallery();
  for (const variant of ["primary", "outlined", "plain", "danger", "highlight", "ghost-danger"]) {
    expect(app.count(`id:idle-${variant}-loading`)).toBe(0);
    expect(app.shows(`id:held-${variant}-loading`)).toBe(true);
    expect(app.shows(`id:icon-${variant}-loading`)).toBe(true);
    expect(app.enabled(`id:held-${variant}`)).toBe(false);
    expect(app.enabled(`id:idle-${variant}`)).toBe(true);
  }
  expect(app.texts().filter((text) => text === "Held")).toHaveLength(6);

  await app.press("id:toggle-held");
  for (const variant of ["primary", "outlined", "plain", "danger", "highlight", "ghost-danger"]) {
    expect(app.count(`id:held-${variant}-loading`)).toBe(0);
    expect(app.count(`id:icon-${variant}-loading`)).toBe(0);
    expect(app.enabled(`id:held-${variant}`)).toBe(true);
  }
});
