import { expect, test } from "nsh/test";
import { type LoginFrame, loginProbe, openConsole } from "./harness";

test("without a password the console logs in by itself and opens the agent's chat", async () => {
  const { app, calls } = await openConsole({ location: "/" });
  await app.waitUntil(() => calls.some((call) => call.path === "/auth/me"));
  expect(calls.some((call) => call.path === "/auth/login")).toBe(true);
  await app.waitFor("id:nav-chat"); // the workspace sidebar
});

test("a wrong password says so, and the right one goes on to the page asked for", async () => {
  const { app } = await openConsole({ location: "/e/default/todo", password: true });
  await app.waitFor("id:login-password");
  await app.press("role:button[Login]");
  await app.waitFor("Please enter password");
  await app.type("id:login-password", "nope");
  await app.press("role:button[Login]");
  await app.waitFor("invalid password");
  await app.clear("id:login-password");
  await app.type("id:login-password", "secret");
  await app.press("role:button[Login]");
  await app.waitFor("id:nav-todo");
});

// The eye in the password field: a 32pt button in the 44pt box, as far from the box's end as from
// its top and bottom, so it is centred in the field's end and never on the typed text.
for (const item of [
  { name: "a narrow phone", width: 320, height: 640 },
  { name: "a phone", width: 390, height: 844 },
  { name: "a desktop", width: 1280, height: 800 },
]) {
  test(`on ${item.name} the eye is centred in the password field's end, and showing the password moves nothing and keeps it`, async () => {
    const { app } = await openConsole({ location: "/e/default/todo", password: true, loginProbe: true, width: item.width, height: item.height });
    const probe = loginProbe(app);
    await app.waitFor("id:login-password");
    const parts = ["column", "password.box", "password.end", "password.reveal"];
    const eye = (frames: Record<string, LoginFrame>) => {
      const box = frames["password.box"];
      const end = frames["password.end"];
      const button = frames["password.reveal"];
      // The button in the box: its row's place in the box, and its own in the row.
      const x = end.x + button.x;
      const y = end.y + button.y;
      return { box, end, x, y, w: button.w, h: button.h, right: box.w - (x + button.w), bottom: box.h - (y + button.h) };
    };
    const check = (frames: Record<string, LoginFrame>, when: string) => {
      const at = eye(frames);
      expect({ when, h: Math.round(at.box.h) }).toEqual({ when, h: 44 });
      expect({ when, w: Math.round(at.w), h: Math.round(at.h) }).toEqual({ when, w: 32, h: 32 });
      // Centred in the box's height.
      expect({ when, off: Math.abs(at.y + at.h / 2 - at.box.h / 2) <= 0.5 }).toEqual({ when, off: true });
      // As far from the end as from the top and the bottom (6pt: the hairline and 5pt).
      expect({ when, top: Math.round(at.y), bottom: Math.round(at.bottom), right: Math.round(at.right) }).toEqual({ when, top: 6, bottom: 6, right: 6 });
      // Inside the box, after the room the text has (the 12pt padding and some of the password).
      expect({ when, inside: at.end.x + at.end.w <= at.box.w + 0.5 && at.end.x >= 12 + 80 }).toEqual({ when, inside: true });
      // The field is as wide as the card's column lets it be, and no wider than the window.
      expect({ when, fits: at.box.w <= frames.column.w && frames.column.x + frames.column.w <= item.width - 16 + 0.5 }).toEqual({ when, fits: true });
      return at;
    };
    const masked = check(await probe.frames(parts), "masked");

    await app.type("id:login-password", "secret");
    await app.press("role:button[Show password]");
    await app.waitFor("role:button[Hide password]");
    expect(app.value("id:login-password")).toBe("secret");
    const shown = check(await probe.frames(parts), "shown");
    expect({ x: shown.x, y: shown.y, box: shown.box }).toEqual({ x: masked.x, y: masked.y, box: masked.box });

    await app.press("role:button[Hide password]");
    await app.waitFor("role:button[Show password]");
    expect(app.value("id:login-password")).toBe("secret");
    const again = check(await probe.frames(parts), "masked again");
    expect({ x: again.x, y: again.y, box: again.box }).toEqual({ x: masked.x, y: masked.y, box: masked.box });

    // A wrong password's error sits under the box and moves neither it nor the eye.
    await app.clear("id:login-password");
    await app.type("id:login-password", "nope");
    await app.press("role:button[Show password]");
    await app.press("id:login-submit");
    await app.waitFor("invalid password");
    const failed = check(await probe.frames(parts), "with an error");
    expect({ x: failed.x, y: failed.y, box: failed.box }).toEqual({ x: masked.x, y: masked.y, box: masked.box });
    expect(app.value("id:login-password")).toBe("nope");

    // The password shown is the one sent.
    await app.clear("id:login-password");
    await app.type("id:login-password", "secret");
    await app.press("id:login-submit");
    await app.waitFor("id:login-password", { state: "gone" });
  });
}

test("in a browser the card names the console's server, and offers no button to change what the page's address decides", async () => {
  const { app } = await openConsole({ location: "/e/default/todo", password: true, width: 390, height: 844 });
  await app.waitFor("id:login-password");
  await app.waitFor("id:login-server >> text:SERVER");
  await app.waitFor("id:login-server >> text:http://console.test");
  expect(app.shows("id:login-server-open")).toBe(false);
  expect(app.shows("text:The Morph console this app signs in to.")).toBe(false);
  expect(app.count("role:button[Scan QR code]")).toBe(0);
});
