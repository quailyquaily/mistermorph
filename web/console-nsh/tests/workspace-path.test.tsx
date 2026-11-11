// How the workspace panel writes a path (components/chat/workspacePath.ts): the workspace host's
// home as `~` (only the home itself and what is inside it), and a path too long for its line cut in
// the middle with a literal "...", keeping its beginning and its end.
import { describe, expect, test } from "nsh/test";
import {
  abbreviateHomePath,
  fitPath,
  PATH_ELLIPSIS,
  textUnits,
  unitsThatFit,
  workspacePathDisplay,
} from "../components/chat/workspacePath";

describe("abbreviateHomePath", () => {
  const CASES: { name: string; path: string; home: string | null; want: string }[] = [
    { name: "the home itself", path: "/home/me", home: "/home/me", want: "~" },
    { name: "the home with a trailing slash", path: "/home/me/", home: "/home/me", want: "~" },
    { name: "a home given with a trailing slash", path: "/home/me/code", home: "/home/me/", want: "~/code" },
    { name: "a folder in the home", path: "/home/me/code", home: "/home/me", want: "~/code" },
    { name: "a deep folder in the home", path: "/home/me/code/app/src", home: "/home/me", want: "~/code/app/src" },
    { name: "a sibling that starts like the home", path: "/home/me2/code", home: "/home/me", want: "/home/me2/code" },
    { name: "a sibling with a suffix", path: "/home/me-old", home: "/home/me", want: "/home/me-old" },
    { name: "the home's parent", path: "/home", home: "/home/me", want: "/home" },
    { name: "the home's text further in", path: "/srv/home/me/code", home: "/home/me", want: "/srv/home/me/code" },
    { name: "a path outside the home", path: "/var/www/site", home: "/home/me", want: "/var/www/site" },
    { name: "no home known", path: "/home/me/code", home: "", want: "/home/me/code" },
    { name: "no home at all", path: "/home/me/code", home: null, want: "/home/me/code" },
    { name: "a root home", path: "/srv/code", home: "/", want: "/srv/code" },
    { name: "a POSIX backslash is a name, not a separator", path: "/home/me\\code", home: "/home/me", want: "/home/me\\code" },
    { name: "case matters on POSIX", path: "/Home/Me/code", home: "/home/me", want: "/Home/Me/code" },
    { name: "a Windows home", path: "C:\\Users\\Me\\code", home: "C:\\Users\\Me", want: "~\\code" },
    { name: "a Windows home in another case", path: "c:\\users\\me\\code", home: "C:\\Users\\Me", want: "~\\code" },
    { name: "a Windows home itself", path: "C:\\Users\\Me\\", home: "C:\\Users\\Me", want: "~" },
    { name: "a Windows sibling", path: "C:\\Users\\Me2\\code", home: "C:\\Users\\Me", want: "C:\\Users\\Me2\\code" },
    { name: "a Windows drive root home", path: "C:\\code", home: "C:\\", want: "C:\\code" },
    { name: "spaces around", path: "  /home/me/code  ", home: " /home/me ", want: "~/code" },
  ];
  for (const item of CASES) {
    test(item.name, () => {
      expect(abbreviateHomePath(item.path, item.home)).toBe(item.want);
    });
  }
});

describe("workspacePathDisplay", () => {
  test("marks where the last part starts, after the home", () => {
    expect(workspacePathDisplay("/home/me/code/app", "/home/me")).toEqual({ text: "~/code/app", leafStart: 7 });
    expect(workspacePathDisplay("/home/me", "/home/me")).toEqual({ text: "~", leafStart: 0 });
    expect(workspacePathDisplay("/var/www/", "/home/me")).toEqual({ text: "/var/www", leafStart: 5 });
    expect(workspacePathDisplay("/", "/home/me")).toEqual({ text: "/", leafStart: 0 });
  });
  test("counts code points, not UTF-16 units", () => {
    expect(workspacePathDisplay("/home/me/𝒳/notes", "/home/me")).toEqual({ text: "~/𝒳/notes", leafStart: 4 });
  });
});

describe("fitPath", () => {
  const LONG = "~/code/clients/acme/monorepo/services/billing-gateway/internal/reconciliation-worker";
  const LEAF = LONG.lastIndexOf("/") + 1;

  test("a path that fits stays whole", () => {
    const fit = fitPath("~/notes", 2, 40);
    expect(fit).toEqual({
      text: "~/notes",
      truncated: false,
      runs: [
        { text: "~/", strong: false },
        { text: "notes", strong: true },
      ],
    });
    expect(fitPath(LONG, LEAF, null).text).toBe(LONG);
    expect(fitPath(LONG, LEAF, LONG.length).text).toBe(LONG);
  });

  test("the home alone is one strong run", () => {
    expect(fitPath("~", 0, 10)).toEqual({ text: "~", truncated: false, runs: [{ text: "~", strong: true }] });
  });

  test("a long path keeps its beginning and its end around a literal ellipsis", () => {
    for (let max = 6; max < LONG.length; max += 1) {
      const fit = fitPath(LONG, LEAF, max);
      expect(fit.truncated).toBe(true);
      expect(fit.text.length).toBeLessThanOrEqual(max);
      expect(fit.text.split(PATH_ELLIPSIS)).toHaveLength(2);
      const [head, tail] = fit.text.split(PATH_ELLIPSIS);
      expect(head.length).toBeGreaterThan(0);
      expect(tail.length).toBeGreaterThan(0);
      expect(LONG.startsWith(head)).toBe(true);
      expect(LONG.endsWith(tail)).toBe(true);
      expect(fit.text).not.toContain("…");
      // The end gets at least half of the room.
      expect(tail.length).toBeGreaterThanOrEqual(head.length);
      expect(fit.runs.map((run) => run.text).join("")).toBe(fit.text);
    }
  });

  test("the end keeps the whole last part when it takes up to two thirds of the room", () => {
    const fit = fitPath(LONG, LEAF, 40);
    expect(fit.text).toBe("~/code/clients/.../reconciliation-worker");
    expect(fit.runs).toEqual([
      { text: "~/code/clients/.../", strong: false },
      { text: "reconciliation-worker", strong: true },
    ]);
  });

  test("a narrow line cuts into the last part, the ellipsis drawn with it", () => {
    const fit = fitPath(LONG, LEAF, 20);
    expect(fit.text).toBe("~/cod...ation-worker");
    const veryNarrow = fitPath(LONG, LEAF, 5);
    expect(veryNarrow.text).toBe("~...r");
    // Narrower than that still keeps a character on each side.
    expect(fitPath(LONG, LEAF, 2).text).toBe("~...r");
  });

  test("an ellipsis inside the last part is strong", () => {
    const fit = fitPath("~/a/an-extremely-long-folder-name-that-goes-on", 4, 20);
    expect(fit.runs[0]).toEqual({ text: "~/a/", strong: false });
    expect(fit.runs[1].strong).toBe(true);
    expect(fit.runs[1].text).toContain(PATH_ELLIPSIS);
  });

  test("wide characters take two cells and are never split", () => {
    const wide = "~/文档/项目/客户资料/二零二六年度/季度报告/财务部门最终版本";
    expect(textUnits("文档")).toBe(4);
    for (let max = 6; max < textUnits(wide); max += 1) {
      const fit = fitPath(wide, wide.lastIndexOf("/") + 1, max);
      expect(fit.truncated).toBe(true);
      expect(textUnits(fit.text)).toBeLessThanOrEqual(Math.max(max, 5));
      const [head, tail] = fit.text.split(PATH_ELLIPSIS);
      expect(wide.startsWith(head)).toBe(true);
      expect(wide.endsWith(tail)).toBe(true);
    }
  });

  test("surrogate pairs stay whole", () => {
    const path = "~/𝒳𝒳𝒳𝒳𝒳𝒳𝒳𝒳𝒳𝒳/𝒴𝒴𝒴𝒴𝒴𝒴𝒴𝒴𝒴𝒴";
    const fit = fitPath(path, 13, 12);
    expect(fit.truncated).toBe(true);
    expect(fit.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("unitsThatFit", () => {
  test("turns the room into monospace cells from a measured line", () => {
    // 10 cells laid out at 72pt: 7.2pt a cell.
    expect(unitsThatFit(72, "0123456789", 72)).toBe(10);
    expect(unitsThatFit(144, "0123456789", 72)).toBe(20);
    expect(unitsThatFit(100, "0123456789", 72)).toBe(13);
    // Half a point of slack: a room a hair short of a cell still holds it.
    expect(unitsThatFit(71.6, "0123456789", 72)).toBe(10);
    expect(unitsThatFit(36, "文档项目一", 72)).toBe(5);
  });
  test("is unknown until both widths are", () => {
    expect(unitsThatFit(0, "abc", 30)).toBeNull();
    expect(unitsThatFit(100, "abc", 0)).toBeNull();
    expect(unitsThatFit(100, "", 30)).toBeNull();
  });
});
