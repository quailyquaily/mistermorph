// The page's side of morph.favicon (host.js `createFavicon`, `drawFavicon`): the build's icon until
// an avatar loads, the avatar drawn small and round, the build's own link elements put back as
// they were, and only the latest request counting. A small stand-in for the page's <head> and
// images, since headless runs have no browser page.
import { expect, test } from "nsh/test";
import { createFavicon, drawFavicon } from "../host.js";

type Attrs = Record<string, string>;

class FakeNode {
  parent: FakeHead | null = null;
  before(node: FakeNode) {
    const parent = this.parent!;
    node.remove();
    parent.children.splice(parent.children.indexOf(this), 0, node);
    node.parent = parent;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(node: FakeNode) {
    this.before(node);
    this.remove();
  }
}

class FakeElement extends FakeNode {
  constructor(
    public tagName: string,
    public attrs: Attrs = {},
  ) {
    super();
  }
  getAttribute(name: string) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = String(value);
  }
  removeAttribute(name: string) {
    delete this.attrs[name];
  }
  cloneNode() {
    return new FakeElement(this.tagName, { ...this.attrs });
  }
}

class FakeComment extends FakeNode {
  constructor(public text: string) {
    super();
  }
}

class FakeHead {
  children: FakeNode[] = [];
  append(node: FakeNode) {
    node.remove();
    this.children.push(node);
    node.parent = this;
  }
  querySelectorAll(tag: string) {
    return this.children.filter((node) => node instanceof FakeElement && node.tagName === tag);
  }
}

/** A head as the build writes it: the manifest, the 32px icon, the touch icon. */
function page() {
  const head = new FakeHead();
  const manifest = new FakeElement("link", { rel: "manifest", href: "manifest.webmanifest" });
  const icon = new FakeElement("link", { rel: "icon", type: "image/png", sizes: "32x32", href: "icons/32.abc.png" });
  const touch = new FakeElement("link", { rel: "apple-touch-icon", href: "icons/180.def.png" });
  for (const node of [manifest, icon, touch]) head.append(node);
  const document = {
    head,
    createElement: (tag: string) => new FakeElement(tag),
    createComment: (text: string) => new FakeComment(text),
  };
  /** The head's elements as `rel href` strings, in order. */
  const links = () =>
    head.children
      .filter((node): node is FakeElement => node instanceof FakeElement)
      .map((node) => `${node.attrs.rel} ${node.attrs.href}`);
  const avatar = () =>
    head.children.find((node): node is FakeElement => node instanceof FakeElement && "data-morph-favicon" in node.attrs) ?? null;
  return { document, head, icon, touch, links, avatar };
}

/** A promise settled from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ORIGIN = "http://console.test";
const BLOB = `blob:${ORIGIN}/0b6c`;
const drawnFrom = (image: { src: string }) => `data:image/png;base64,DRAWN-${image.src}`;

test("the build's icon stays until an avatar loads; the avatar is drawn and the build's icon comes back as it was", async () => {
  const p = page();
  const loads: { url: string; crossOrigin: string | null }[] = [];
  const pending = deferred<{ src: string }>();
  const favicon = createFavicon({
    document: p.document,
    pageOrigin: ORIGIN,
    loadImage: (url: string, crossOrigin: string | null) => {
      loads.push({ url, crossOrigin });
      return pending.promise;
    },
    draw: drawnFrom,
  });
  const before = p.links();
  expect(favicon.current()).toBe("app");

  const shown = favicon.show(BLOB);
  // Loading: still the build's icon.
  expect(p.links()).toEqual(before);
  expect(favicon.current()).toBe("app");
  pending.resolve({ src: BLOB });
  expect(await shown).toBe("avatar");
  // The app's blob URL is read as it is (same origin: no CORS request).
  expect(loads).toEqual([{ url: BLOB, crossOrigin: null }]);
  // One round 32px PNG in the icon's place; the touch icon and the manifest untouched.
  expect(p.links()).toEqual(["manifest manifest.webmanifest", `icon data:image/png;base64,DRAWN-${BLOB}`, "apple-touch-icon icons/180.def.png"]);
  expect(p.avatar()?.attrs.type).toBe("image/png");
  expect(p.avatar()?.attrs.sizes).toBe("32x32");
  expect(p.icon.parent).toBe(null);
  expect(p.touch.parent).toBe(p.head);

  // No avatar: the very element the build wrote, with its attributes, where it was.
  expect(await favicon.show("")).toBe("app");
  expect(p.links()).toEqual(before);
  expect(p.icon.parent).toBe(p.head);
  expect(p.icon.attrs).toEqual({ rel: "icon", type: "image/png", sizes: "32x32", href: "icons/32.abc.png" });
  expect(p.avatar()).toBe(null);
  expect(favicon.current()).toBe("app");
});

test("an avatar that fails to load leaves the build's icon, also after another avatar", async () => {
  const p = page();
  const favicon = createFavicon({
    document: p.document,
    pageOrigin: ORIGIN,
    loadImage: (url: string) => (url.includes("broken") ? Promise.reject(new Error("decode failed")) : Promise.resolve({ src: url })),
    draw: drawnFrom,
  });
  const before = p.links();
  expect(await favicon.show("blob:http://console.test/broken")).toBe("app");
  expect(p.links()).toEqual(before);

  expect(await favicon.show(BLOB)).toBe("avatar");
  expect(favicon.current()).toBe(`data:image/png;base64,DRAWN-${BLOB}`);
  // The next agent's avatar fails: the build's icon, not the previous agent's.
  expect(await favicon.show("blob:http://console.test/broken-too")).toBe("app");
  expect(p.links()).toEqual(before);
});

test("only the latest request counts: an older load that ends later changes nothing", async () => {
  const p = page();
  const loads = new Map<string, ReturnType<typeof deferred<{ src: string }>>>();
  const favicon = createFavicon({
    document: p.document,
    pageOrigin: ORIGIN,
    loadImage: (url: string) => {
      const load = deferred<{ src: string }>();
      loads.set(url, load);
      return load.promise;
    },
    draw: drawnFrom,
  });
  const before = p.links();
  const first = favicon.show("blob:http://console.test/agent-a");
  const second = favicon.show("blob:http://console.test/agent-b");
  loads.get("blob:http://console.test/agent-b")!.resolve({ src: "agent-b" });
  expect(await second).toBe("avatar");
  loads.get("blob:http://console.test/agent-a")!.resolve({ src: "agent-a" });
  expect(await first).toBe("stale");
  expect(favicon.current()).toBe("data:image/png;base64,DRAWN-agent-b");

  // Switched to an agent without an avatar while one loads: the build's icon stays.
  const third = favicon.show("blob:http://console.test/agent-c");
  expect(await favicon.show("")).toBe("app");
  loads.get("blob:http://console.test/agent-c")!.resolve({ src: "agent-c" });
  expect(await third).toBe("stale");
  expect(p.links()).toEqual(before);

  // A stale failure does not undo the current avatar either.
  const failing = favicon.show("blob:http://console.test/agent-d");
  const current = favicon.show("blob:http://console.test/agent-e");
  loads.get("blob:http://console.test/agent-e")!.resolve({ src: "agent-e" });
  await current;
  loads.get("blob:http://console.test/agent-d")!.reject(new Error("revoked"));
  expect(await failing).toBe("stale");
  await flush();
  expect(favicon.current()).toBe("data:image/png;base64,DRAWN-agent-e");
});

test("data: and same-origin images load without CORS; another origin's falls back to the plain URL", async () => {
  const p = page();
  const loads: { url: string; crossOrigin: string | null }[] = [];
  const favicon = createFavicon({
    document: p.document,
    pageOrigin: ORIGIN,
    loadImage: (url: string, crossOrigin: string | null) => {
      loads.push({ url, crossOrigin });
      // The other origin sends no CORS headers: an anonymous request fails, a plain one loads.
      if (url.startsWith("https://cdn.example.com") && crossOrigin) return Promise.reject(new Error("CORS"));
      return Promise.resolve({ src: url });
    },
    draw: drawnFrom,
  });
  const data = "data:image/webp;base64,UklGRg==";
  expect(await favicon.show(data)).toBe("avatar");
  expect(await favicon.show(`${ORIGIN}/api/avatar.png`)).toBe("avatar");
  expect(loads).toEqual([
    { url: data, crossOrigin: null },
    { url: `${ORIGIN}/api/avatar.png`, crossOrigin: null },
  ]);
  loads.length = 0;
  expect(await favicon.show("https://cdn.example.com/a.png")).toBe("avatar");
  expect(loads).toEqual([
    { url: "https://cdn.example.com/a.png", crossOrigin: "anonymous" },
    { url: "https://cdn.example.com/a.png", crossOrigin: null },
  ]);
  // The browser draws that one itself: no PNG type or size claimed.
  expect(favicon.current()).toBe("https://cdn.example.com/a.png");
  expect(p.avatar()?.attrs.type).toBe(undefined);
  expect(p.avatar()?.attrs.sizes).toBe(undefined);
});

test("an image the canvas cannot read is shown as it is", async () => {
  const p = page();
  const favicon = createFavicon({
    document: p.document,
    pageOrigin: ORIGIN,
    loadImage: (url: string) => Promise.resolve({ src: url }),
    draw: () => {
      throw new Error("SecurityError: tainted canvas");
    },
  });
  expect(await favicon.show(BLOB)).toBe("avatar");
  expect(favicon.current()).toBe(BLOB);
});

test("a page without an icon of its own gets the avatar and then none again", async () => {
  const head = new FakeHead();
  const document = {
    head,
    createElement: (tag: string) => new FakeElement(tag),
    createComment: (text: string) => new FakeComment(text),
  };
  const favicon = createFavicon({ document, pageOrigin: ORIGIN, loadImage: (url: string) => Promise.resolve({ src: url }), draw: drawnFrom });
  expect(await favicon.show(BLOB)).toBe("avatar");
  expect(head.children.filter((node) => node instanceof FakeElement).length).toBe(1);
  expect(await favicon.show("")).toBe("app");
  expect(head.children.filter((node) => node instanceof FakeElement).length).toBe(0);
});

/** A canvas that records what is drawn on it. */
function recordingCanvas() {
  const ops: unknown[][] = [];
  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    beginPath: () => ops.push(["beginPath"]),
    arc: (...args: unknown[]) => ops.push(["arc", ...args]),
    closePath: () => ops.push(["closePath"]),
    clip: () => ops.push(["clip"]),
    drawImage: (...args: unknown[]) => ops.push(["drawImage", ...args.slice(1)]),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === "2d" ? context : null),
    toDataURL: (type: string) => `data:${type};base64,ICON`,
  };
  return { canvas, context, ops };
}

test("the icon is the image's centre square, scaled to 32px and cut round", () => {
  const wide = recordingCanvas();
  expect(drawFavicon({ naturalWidth: 200, naturalHeight: 100 }, 32, () => wide.canvas)).toBe("data:image/png;base64,ICON");
  expect([wide.canvas.width, wide.canvas.height]).toEqual([32, 32]);
  expect(wide.context.imageSmoothingQuality).toBe("high");
  expect(wide.ops).toEqual([
    ["beginPath"],
    ["arc", 16, 16, 16, 0, Math.PI * 2],
    ["closePath"],
    ["clip"],
    ["drawImage", 50, 0, 100, 100, 0, 0, 32, 32],
  ]);

  const tall = recordingCanvas();
  drawFavicon({ naturalWidth: 90, naturalHeight: 150 }, 32, () => tall.canvas);
  expect(tall.ops.at(-1)).toEqual(["drawImage", 0, 30, 90, 90, 0, 0, 32, 32]);

  // An SVG without a size of its own scales to fit.
  const svg = recordingCanvas();
  drawFavicon({ naturalWidth: 0, naturalHeight: 0 }, 32, () => svg.canvas);
  expect(svg.ops.at(-1)).toEqual(["drawImage", 0, 0, 32, 32]);
});
