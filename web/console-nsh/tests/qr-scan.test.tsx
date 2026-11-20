// The app's side of a QR scan (lib/qrScan.ts): what of the scanner page's messages is heard, what
// of a code's text is a server address, and one scan from its opening to its end. The page itself
// is lib/qrScannerPage.test.mjs; the dialog that uses both is tests/login-server.test.tsx.
import { expect, test } from "nsh/test";
import { openScan, readScanMessage, type ScanEvent, scannedServer, SCAN_TEXT_MAX } from "../lib/qrScan";

test("only the page's three messages are heard, and an unknown failure is a plain one", () => {
  expect(readScanMessage('{"type":"ready"}')).toEqual({ type: "ready" });
  expect(readScanMessage('{"type":"result","text":"http://a.test"}')).toEqual({ type: "result", text: "http://a.test" });
  expect(readScanMessage('{"type":"error","code":"denied","detail":"NotAllowedError"}')).toEqual({ type: "error", code: "denied" });
  expect(readScanMessage('{"type":"error","code":"exploded"}')).toEqual({ type: "error", code: "failed" });
  for (const data of ["", "stop", "{", "null", "[]", '"ready"', '{"type":"result"}', '{"type":"result","text":7}', '{"type":"save","text":"http://a.test"}', 7, null, undefined, { type: "ready" }]) {
    expect({ data, heard: readScanMessage(data) }).toEqual({ data, heard: null });
  }
  expect(readScanMessage(JSON.stringify({ type: "result", text: "x".repeat(SCAN_TEXT_MAX * 4) }))).toBeNull();
});

test("a code's text is a server address by the typed address's rules, and nothing else is", () => {
  const cases: [unknown, string | null][] = [
    ["http://192.168.1.20:9080", "http://192.168.1.20:9080"],
    ["  https://morph.example.com/console/  ", "https://morph.example.com/console"],
    ["HTTPS://Morph.Example.com", "https://morph.example.com"],
    // Without a scheme, as typed: a local address is http, a name https.
    ["192.168.1.20:9080", "http://192.168.1.20:9080"],
    ["localhost:9080/console", "http://localhost:9080/console"],
    ["morph.example.com", "https://morph.example.com"],
    // What the address is saved as: no query, no fragment.
    ["http://10.0.0.5:9080/?token=abc#x", "http://10.0.0.5:9080"],
    // Not addresses.
    ["", null],
    ["   ", null],
    ["WIFI:S:home;T:WPA;P:secret;;", null],
    ["mailto:someone@example.com", null],
    ["tel:+15551234", null],
    ["ftp://files.example.com", null],
    ["javascript://alert(1)", null],
    ["morph://login?server=http://a.test", null],
    ['{"server":"http://a.test","password":"x"}', null],
    ["http://a.test http://b.test", null],
    ["http://a.test\nrm -rf /", null],
    ["hello world", null],
    // A name or a password is never taken from a code.
    ["http://admin:secret@192.168.1.20:9080", null],
    ["user@example.com", null],
    ["http://", null],
    [`http://a.test/${"x".repeat(SCAN_TEXT_MAX)}`, null],
    [42, null],
    [null, null],
    [{ text: "http://a.test" }, null],
  ];
  for (const [text, address] of cases) {
    expect({ text, address: scannedServer(text) }).toEqual({ text, address });
  }
});

function scanWith() {
  const heard: ScanEvent[] = [];
  const told: string[] = [];
  const scan = openScan((event) => heard.push(event));
  return { scan, heard, told, post: (message: string) => told.push(message) };
}

test("a scan hears ready once and then one code, tells its page to stop, and hears no more", () => {
  const { scan, heard, told, post } = scanWith();
  scan.attach(post);
  scan.receive("not json");
  scan.receive('{"type":"ready"}');
  scan.receive('{"type":"ready"}');
  expect(scan.state()).toBe("open");
  scan.receive('{"type":"result","text":"http://a.test"}');
  expect(scan.state()).toBe("done");
  expect(told).toEqual(["stop"]);
  scan.receive('{"type":"result","text":"http://b.test"}');
  scan.receive('{"type":"error","code":"denied"}');
  scan.fail("failed");
  expect(heard).toEqual([{ type: "ready" }, { type: "result", text: "http://a.test" }]);
  scan.close();
  expect(scan.state()).toBe("closed");
});

test("a failure ends a scan, from the page or from outside it", () => {
  const first = scanWith();
  first.scan.attach(first.post);
  first.scan.receive('{"type":"error","code":"no_camera"}');
  first.scan.receive('{"type":"ready"}');
  expect(first.heard).toEqual([{ type: "error", code: "no_camera" }]);
  expect(first.told).toEqual(["stop"]);

  const second = scanWith();
  second.scan.attach(second.post);
  second.scan.fail("interrupted");
  second.scan.receive('{"type":"result","text":"http://a.test"}');
  expect(second.heard).toEqual([{ type: "error", code: "interrupted" }]);
  expect(second.told).toEqual(["stop"]);
});

test("a closed scan tells its page to stop and drops what comes late: a permission answered, a code read", () => {
  const { scan, heard, told, post } = scanWith();
  scan.attach(post);
  scan.close();
  expect(told).toEqual(["stop"]);
  scan.receive('{"type":"ready"}');
  scan.receive('{"type":"result","text":"http://a.test"}');
  scan.receive('{"type":"error","code":"denied"}');
  scan.fail("failed");
  expect(heard).toEqual([]);
  // Closing again says nothing more.
  scan.close();
  expect(told).toEqual(["stop"]);
});

test("a scan closed before its web view exists stops the page as soon as it can be told", () => {
  const { scan, heard, told, post } = scanWith();
  scan.close();
  expect(told).toEqual([]);
  scan.attach(post);
  expect(told).toEqual(["stop"]);
  expect(heard).toEqual([]);
});

test("a page that cannot be told to stop does not break the scan's end", () => {
  const heard: ScanEvent[] = [];
  const scan = openScan((event) => heard.push(event));
  scan.attach(() => {
    throw new Error("the web view is gone");
  });
  scan.receive('{"type":"result","text":"http://a.test"}');
  expect(heard).toEqual([{ type: "result", text: "http://a.test" }]);
  scan.close();
  expect(scan.state()).toBe("closed");
});
