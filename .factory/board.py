#!/usr/bin/env python3
"""Render a repository's .factory/ board as one static HTML page.

    board.py [REPO] [-o board.html]

REPO is a checkout of the factory_board branch, where the board lives; it
defaults to the current directory. references/board-pages.yml runs it on
GitHub Actions to publish the board on GitHub Pages. The page draws the line as
one rail with a stage per folder (not stop/: parked items are left out; backlog/
is the owner's and waits for nobody), an entry per item (whose turn it is, how
long it has waited) and, behind each entry, the item's thread and the times it
moved between folders, read from git. With -o, older done items move to a
done.html beside the page, so the board stays small however long the factory
runs; their threads are the item files on GitHub. It needs only Python 3.11 and
git, and loads nothing from the network. Item files are other people's text:
everything is escaped.
"""

import argparse
import datetime as dt
import html
import os
import re
import subprocess
import sys
import tomllib
from zoneinfo import ZoneInfo

FOLDERS = ["backlog", "new", "review", "ready", "done"]  # stop/ is parked: not shown
# <PREFIX><N>-<slug>.md, or <NNNN>-<slug>.md from before prefixes. Owners add
# backlog/<slug>.md or new/<slug>.md; the factory numbers it. Prefixes are capitals and slugs are
# lower case, so a slug can't be read as a number.
ITEM = re.compile(r"^(?:(?:[A-Z]+(\d+)|(\d{4}))-)?([a-z0-9]+(?:-[a-z0-9]+)*)\.md$")
SECTION = re.compile(r"^## (.+?) · (?:(plan|question|review) · )?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$")
DONE_SHOWN = 4
ARCHIVE = "done.html"
BOARD_BRANCH = "factory_board"
TZ = None  # factory.toml's timezone; the machine's own when unset


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def parse(text, signers=()):
    """The header, title and sections of an item file, and what is wrong with it.

    Only `## name · time` starts a section; other headings are body text. A
    `## ` line starting with a signer's name (factory, an owner) that is not
    a valid heading is a mistyped signature, reported as a problem.
    """
    lines = text.splitlines()
    header, problems, i = {}, [], 0
    if lines and lines[0].strip() == "---":
        for j in range(1, len(lines)):
            if lines[j].strip() == "---":
                for line in lines[1:j]:
                    key, sep, value = line.partition(":")
                    if sep:
                        header[key.strip()] = value.strip()
                i = j + 1
                break
        else:
            problems.append("the header has no closing ---")
    while i < len(lines) and not lines[i].strip():
        i += 1
    title = ""
    if i < len(lines) and lines[i].startswith("# "):
        title = lines[i][2:].strip()
        i += 1
    else:
        problems.append("no # title line")
    sections, current = [], None
    for line in lines[i:]:
        m = SECTION.match(line) if line.startswith("## ") else None
        if m:
            current = {"who": m.group(1), "kind": m.group(2) or "", "time": m.group(3), "body": []}
            sections.append(current)
        elif line.startswith("## ") and line[3:].split(" ", 1)[0].strip("·:,") in signers:
            # A signer's name but not a valid heading: a typo, which would
            # otherwise hide their answer inside the section above.
            problems.append("a section heading not in the form ## name · YYYY-MM-DD HH:MM")
            current = {"who": line[3:].strip(), "kind": "", "time": "", "body": []}
            sections.append(current)
        elif current is not None:
            current["body"].append(line)
        elif line.strip():
            problems.append("text before the first section")
    if not sections:
        problems.append("no sections")
    for s in sections:
        s["body"] = "\n".join(s["body"]).strip("\n")
    return header, title, sections, problems


def moves(repo):
    """When each item entered each folder: {file name: [(folder, unix time)]}, oldest first.

    Reads added files with renames off, because a move usually edits the file
    too: appending a long review drops it below git's rename similarity, and
    `git log --follow` then loses every folder before that commit. An item keeps
    its file name between folders, except when numbered (<slug>.md becomes
    <ID>-<slug>.md in one commit), which carries its history across.
    """
    out = git(repo, "log", "--reverse", "--no-renames", "--name-status", "--format=%x00%ct", "--", ".factory")
    history = {}
    for chunk in out.split("\x00")[1:]:
        lines = chunk.strip().splitlines()
        if not lines:
            continue
        t, added, deleted = int(lines[0]), [], set()
        for line in lines[1:]:
            status, _, path = line.partition("\t")
            parts = path.split("/")
            if len(parts) != 3 or parts[0] != ".factory":
                continue
            if status == "D":
                deleted.add(parts[2])
            elif status == "A" or parts[2] not in history:  # M with no A: the log is cut short
                added.append((parts[1], parts[2]))
        for folder, name in added:
            m = ITEM.match(name)
            bare = f"{m.group(3)}.md" if m else name
            if name not in history and bare != name and bare in deleted and bare in history:
                history[name] = history.pop(bare)
            steps = history.setdefault(name, [])
            if not steps or steps[-1][0] != folder:
                steps.append((folder, t))
    return history


def turn(folder, sections):
    """Who acts next: "you", "agent" or "" (nobody).

    new/ waits for a build and review/ for a review, unless the latest review
    found P0 or P1: then you decide. ready/ waits for you to check it.
    """
    if folder in ("backlog", "done"):
        return ""
    if folder == "new":
        return "agent"
    if folder == "review":
        mine = [s for s in sections if s["who"] == "factory"]
        last = mine[-1] if mine else None
        fix = last and last["kind"] == "review" and re.search(r"^verdict:\s*fix\b", last["body"], re.M)
        return "you" if fix else "agent"
    return "you"


def repo_name(repo, remote):
    """The repository's name from its remote; a run's checkout is often just "clone"."""
    url = git(repo, "remote", "get-url", remote).strip()
    m = re.search(r"([^/:]+?)(?:\.git)?/?$", url)
    return m.group(1) if m else os.path.basename(os.path.abspath(repo))


def github_url(repo, remote):
    url = git(repo, "remote", "get-url", remote).strip()
    m = re.match(r"^(?:git@github\.com:|https://github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?$", url)
    return f"https://github.com/{m.group(1)}" if m else ""


def branch_link(repo, remote, base, branch):
    url = github_url(repo, remote)
    return f"{url}/compare/{base}...{branch}" if url and branch else ""


def when(t):
    return dt.datetime.fromtimestamp(t, TZ).strftime("%Y-%m-%d %H:%M") if t else ""


def span(seconds):
    """A length of time, to one figure the eye can compare: 40m, 19h, 1.2d."""
    if seconds < 3600:
        return f"{max(1, int(seconds / 60))}m"
    if seconds < 86400:
        return f"{round(seconds / 3600)}h"
    return f"{seconds / 86400:.1f}d".replace(".0d", "d")


def age(t, now):
    """How long since t, in whole units: an entry's age needs no decimals."""
    s = max(0, now - t)
    if s < 3600:
        return f"{max(1, int(s / 60))}m"
    return f"{int(s / 3600)}h" if s < 86400 else f"{int(s / 86400)}d"


# What an item asks of you, by folder, when it's your turn.
ASK = {"review": "Decide: fix or take it", "ready": "Check, then ship"}


def inline(text):
    """Escape a line, then mark up its code, bold and links."""
    out = []
    for part in re.split(r"(`[^`\n]+`)", text):
        if len(part) > 2 and part[0] == part[-1] == "`":
            out.append(f"<code>{html.escape(part[1:-1])}</code>")
            continue
        part = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html.escape(part))
        out.append(re.sub(r"(https://[^\s<]*[^\s<.,;:!?)])", r'<a href="\1" rel="noopener">\1</a>', part))
    return "".join(out)


def body_html(text, review=False):
    """The Markdown item files use: paragraphs, lists, headings and code fences.

    In a review, also its fields: head, verdict, and the fix and notes lists
    with their [P0]..[P3] severities. Anything else stays plain text.
    """
    out, para, open_list, fence = [], [], None, None

    def flush():
        nonlocal para, open_list
        if para:
            out.append("<p>" + "<br>".join(inline(p) for p in para) + "</p>")
            para = []
        if open_list:
            out.append(f"</{open_list}>")
            open_list = None

    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            if fence is None:
                flush()
                fence = []
            else:
                out.append("<pre>" + html.escape("\n".join(fence)) + "</pre>")
                fence = None
            continue
        if fence is not None:
            fence.append(line)
            continue
        if not line.strip():
            flush()
            continue
        m = re.match(r"^#{1,6} +(.+)", line)
        if m:
            flush()
            out.append(f"<h4>{inline(m.group(1))}</h4>")
            continue
        if review:
            m = re.match(r"^verdict:\s*(\w+)", line)
            if m:
                flush()
                v = html.escape(m.group(1))
                out.append(f'<p class="verdict {v}">Verdict: {v}</p>')
                continue
            m = re.match(r"^head:\s*([0-9a-f]{7})[0-9a-f]*\s*$", line)
            if m:
                flush()
                out.append(f"<p class=headsha>Reviewed <code>{m.group(1)}</code></p>")
                continue
            m = re.match(r"^(fix|notes):\s*$", line)
            if m:
                flush()
                out.append("<h4>" + ("To fix" if m.group(1) == "fix" else "Notes") + "</h4>")
                continue
        m = re.match(r"^\s*(?:[-*] |(\d+)\. )(.*)", line)
        if m:
            if para:
                flush()
            tag = "ol" if m.group(1) else "ul"
            if open_list != tag:
                flush()
                out.append(f"<{tag}>")
                open_list = tag
            sev = re.match(r"^\[(P\d)\] (.*)", m.group(2)) if review else None
            if sev:
                out.append(f'<li><span class="sev {sev.group(1).lower()}">{sev.group(1)}</span><span>{inline(sev.group(2))}</span></li>')
            else:
                out.append(f"<li>{inline(m.group(2))}</li>")
            continue
        if open_list:
            flush()
        para.append(line)
    if fence is not None:  # an unclosed fence is still code
        out.append("<pre>" + html.escape("\n".join(fence)) + "</pre>")
    flush()
    return "".join(out)


def waiting_since(item):
    """An item waits on you from the last word in its thread, not from its last move."""
    if item["turn"] != "you":
        return item["changed"]
    latest = item["changed"]
    for s in item["sections"]:
        try:
            t = dt.datetime.strptime(s["time"], "%Y-%m-%d %H:%M").replace(tzinfo=TZ).timestamp()
        except ValueError:
            continue  # a mistyped heading, reported as a problem
        latest = max(latest, t)
    return latest


def average_stay(items, folder):
    """Mean time per stay in a folder, counting finished stays only."""
    stays = []
    for it in items:
        steps = it["steps"]
        stays += [steps[i + 1][1] - t for i, (f, t) in enumerate(steps[:-1]) if f == folder]
    return span(sum(stays) / len(stays)) if stays else ""


def rounds(item):
    return int(item["round"]) if item["round"].isdigit() else 0


def load(repo):
    cfg_path = os.path.join(repo, ".factory", "factory.toml")
    with open(cfg_path, "rb") as f:
        cfg = tomllib.load(f)
    global TZ
    if cfg.get("timezone"):
        TZ = ZoneInfo(cfg["timezone"])
    owners = set(cfg.get("owners", []))
    prefix = cfg.get("prefix", "FT")
    if not re.fullmatch(r"[A-Z]+", prefix):
        sys.exit(f"board.py: prefix must be capital letters, not {prefix!r}")
    base, remote = cfg.get("base", "master"), cfg.get("remote", "origin")
    items = []
    history = moves(repo)
    for folder in FOLDERS:
        d = os.path.join(repo, ".factory", folder)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            m = ITEM.match(name)
            num = m and (m.group(1) or m.group(2))
            if not m or (num is None and folder not in ("backlog", "new")):
                continue
            n = int(num) if num else None
            # A file names its own prefix; older four-digit files take today's.
            label = name.split("-", 1)[0] if m.group(1) else (f"{prefix}{n}" if n else "new")
            path = os.path.join(".factory", folder, name)
            with open(os.path.join(repo, path), encoding="utf-8", errors="replace") as f:
                header, title, sections, problems = parse(f.read(), owners | {"factory"})
            steps = history.get(name, [])
            items.append({
                "n": n, "slug": m.group(3), "folder": folder, "file": path,
                "id": str(n) if n else m.group(3), "label": label,
                "title": title or m.group(3).replace("-", " "),
                "branch": header.get("branch", ""), "round": header.get("round", ""),
                "sections": sections, "problems": problems, "steps": steps,
                "changed": steps[-1][1] if steps else 0,
                "turn": turn(folder, sections),
                "link": branch_link(repo, remote, base, header.get("branch", "")),
            })
            items[-1]["since"] = waiting_since(items[-1])
    cfg["github_url"] = github_url(repo, remote)
    return cfg, repo_name(repo, remote), items


CSS = """
/* Layout: a drawing with almost nothing on it. One rail, one thin drop line per stage, and text.
   The accent appears only on what waits for you: the gate's diamond, the count, the ask.
   */
:root{--ground:#fbfcfe;--plate:#fff;--ink:#17263d;--ink-2:#46566d;--ink-3:#66758a;--rule:#b4c2d4;--rule-soft:#dfe5ed;
--grid:rgb(30 75 140 / .028);--gate:#a24c0a;--stop:#a8352a;--ok:#2a6f50;--tint:rgb(23 38 61 / .04);--shade:rgb(23 38 61 / .1);--code:rgb(30 75 140 / .07);
--hair:1px;--sans:system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;color-scheme:light}
*{box-sizing:border-box}
/* 24 CSS px is whole device pixels at 1, 1.25, 1.5 and 2x, and --hair is one device pixel, so the grid stays even. */
body{margin:0;color:var(--ink);font:15px/1.5 var(--sans);font-variant-numeric:tabular-nums;background-color:var(--ground);
background-image:linear-gradient(var(--grid) var(--hair),transparent 0),linear-gradient(90deg,var(--grid) var(--hair),transparent 0);background-size:24px 24px}
::selection{background:color-mix(in srgb,var(--gate) 22%,transparent)}
a{color:inherit}
:focus-visible{outline:1.5px solid color-mix(in srgb,var(--ink) 50%,transparent);outline-offset:2px;border-radius:3px}
.sheet{max-width:1280px;margin:0 auto;padding-block:30px 40px;padding-left:max(28px,env(safe-area-inset-left,0px));padding-right:max(28px,env(safe-area-inset-right,0px))}

.top{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 18px;padding-bottom:14px;border-bottom:var(--hair) solid var(--rule-soft)}
h1{margin:0;font-size:1.06rem;font-weight:600;letter-spacing:-.005em}
.sum{font-size:.88rem;color:var(--ink-3)}
.sum b{font-weight:600;color:var(--gate)}
.drawn{margin-left:auto;font-size:.8rem;color:var(--ink-3)}
.drawn a{text-decoration-color:var(--rule);text-underline-offset:3px}

/* Columns touch, so each stage's rail runs straight into the next node. */
.line{display:grid;grid-template-columns:minmax(0,.86fr) repeat(3,minmax(0,1fr)) minmax(0,.86fr);align-items:start;margin-top:26px}
.loop{grid-column:2;grid-row:1;position:relative;margin-left:6px;width:100%;height:20px;border:var(--hair) dashed var(--rule);border-bottom:0;border-radius:7px 7px 0 0}
.loop span{position:absolute;top:-.72em;left:50%;transform:translateX(-50%);padding:0 7px;background:var(--ground);font-size:.72rem;line-height:1.4;color:var(--ink-3);white-space:nowrap}
.st{grid-row:2;min-width:0;padding-right:26px}
.st:last-child{padding-right:0}
.rail{position:relative;height:13px;margin-right:-26px}
.st:last-child .rail{margin-right:0}
.rail::before{content:"";position:absolute;left:6px;right:0;top:6px;border-top:var(--hair) solid var(--rule)}
.st.parked .rail::before{border-top-style:dashed}
.st:last-child .rail::before{display:none}
.node{position:absolute;left:1px;top:1px;width:11px;height:11px;border:var(--hair) solid var(--ink-3);border-radius:50%;background:var(--ground);z-index:1}
.st.parked .node{border-style:dashed}
.st.gate .node{left:2px;top:2px;width:9px;height:9px;border:0;border-radius:1px;background:var(--gate);transform:rotate(45deg)}
.drop{margin-left:6px;padding:10px 0 2px 14px;border-left:var(--hair) solid var(--rule-soft)}
.head h2{margin:0;display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:.92rem;font-weight:600;line-height:1.3}
.head h2 b{font-size:.84rem;font-weight:400;color:var(--ink-3)}
.avg{display:block;min-height:1.4em;margin-top:1px;font-size:.76rem;line-height:1.4;color:var(--ink-3)}
.items{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.item{position:relative;display:flex;flex-direction:column;gap:2px;margin:0 -8px;padding:6px 8px 7px;border-radius:5px;transition:background-color 0s}
/* The title's link covers the whole entry; the ID button sits above it. */
.item a.t{text-decoration:none}
.item a.t::after{content:"";position:absolute;inset:0;border-radius:inherit}
.item a.t:focus-visible{outline:none}
.item:has(a.t:focus-visible){outline:1.5px solid color-mix(in srgb,var(--ink) 50%,transparent);outline-offset:2px}
/* Calm hover: the tint comes in after a beat and leaves at once, so a sweep flashes nothing. */
@media (hover:hover){.item:hover{background:var(--tint);transition:background-color .14s ease-out 60ms}}
.meta{display:flex;justify-content:space-between;gap:8px;font-size:.74rem;line-height:1.4;color:var(--ink-3)}
.t{font-size:.92rem;font-weight:500;line-height:1.36;text-wrap:pretty;overflow-wrap:anywhere}
.st.side .t{font-weight:400;color:var(--ink-2)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
/* An ID copies itself. The check draws in one stroke and fades; the label never changes width. */
.id{position:relative;z-index:1;padding:0;border:0;background:none;font:inherit;color:inherit;cursor:copy;border-radius:2px}
@media (hover:hover){.id:hover{color:var(--ink);text-decoration:underline dotted;text-decoration-color:var(--rule);text-underline-offset:3px}}
.id .ok{position:absolute;left:calc(100% + 3px);top:50%;width:10px;height:10px;margin-top:-5px;fill:none;stroke:var(--ok);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;opacity:0;pointer-events:none;transition:opacity .2s}
.id.copied .ok{opacity:1;transition:none}
/* pathLength=1, so a dash of 1 is the whole stroke: the offset runs 1 → 0 to draw it. */
.id .ok path{stroke-dasharray:1;stroke-dashoffset:1;transition:stroke-dashoffset 0s .2s}
.id.copied .ok path{stroke-dashoffset:0;transition:stroke-dashoffset .26s cubic-bezier(.2,0,0,1)}
.ask{margin-top:1px;font-size:.8rem;line-height:1.35;color:var(--gate)}
.bad,.problems{font-size:.8rem;line-height:1.35;color:var(--stop)}
.problems{margin:6px 0 0}
.more,.idle{margin:10px 0 0;font-size:.8rem;color:var(--ink-3)}
.more summary{display:inline-block;list-style:none;cursor:pointer;text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px}
.more summary::-webkit-details-marker{display:none}
.more .hide,.more[open] .show{display:none}
.more[open] .hide{display:inline}
.more .items{margin-top:8px}
.more a{text-underline-offset:3px;text-decoration-color:var(--rule)}
.archive{max-width:760px;margin-top:18px}
.archive summary{display:flex;justify-content:space-between;gap:8px;padding:12px 0;cursor:pointer;list-style:none;font-size:.92rem;font-weight:600;border-bottom:var(--hair) solid var(--rule-soft)}
.archive summary::-webkit-details-marker{display:none}
.archive summary b{font-size:.84rem;font-weight:400;color:var(--ink-3)}
.archive ul{list-style:none;margin:0 0 14px;padding:0}
.archive li{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:9px 0;border-bottom:var(--hair) solid var(--rule-soft)}
.archive .id,.archive time{font-size:.74rem;color:var(--ink-3)}
.archive .t{font-size:.92rem;line-height:1.36;font-weight:400;color:var(--ink-2);overflow-wrap:anywhere;text-wrap:pretty}
.archive .t a{text-decoration:none}
@media (hover:hover){.archive .t a:hover{color:var(--ink);text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px}}


/* The thread is a second sheet. Only transform and opacity move, so it stays smooth however long
   the thread is; visibility waits for the slide before it hides. */
.detail{position:fixed;inset:0;z-index:20;visibility:hidden;transition:visibility 0s .2s}
.detail:target{visibility:visible;transition:none}
.shade{position:absolute;inset:0;background:var(--shade);opacity:0;transition:opacity .2s}
.detail:target .shade{opacity:1}
.drawer{position:absolute;inset:0 0 0 auto;width:min(660px,100%);background:var(--plate);border-left:var(--hair) solid var(--rule-soft);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--rule) transparent;opacity:0;transform:translateX(24px);transition:transform .24s cubic-bezier(.2,0,0,1),opacity .14s}
.detail:target .drawer{opacity:1;transform:none}
.bar{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;min-height:44px;padding:0 30px;background:var(--plate);font-size:.82rem;color:var(--ink-3)}
.close{display:flex;align-items:center;min-height:44px;padding-left:16px;text-decoration:none}
@media (hover:hover){.close:hover{color:var(--ink)}}
.dr{min-width:0;padding:8px 30px 44px}
/* A long thread gets an index beside it, sticky under the bar, named by kind or first words (the
   time is in the thread, and in each name's tooltip). Each mark says what a section is:
   your notes solid ink, other people's hollow, the factory's reports pale, a plan a square,
   a review a diamond in its verdict's colour, a question in the colour of what waits for you. */
.drawer.has-toc{width:min(860px,100%)}
.cols{display:grid;grid-template-columns:212px minmax(0,1fr)}
.has-toc .dr{padding-left:22px}
.toc{position:sticky;top:44px;align-self:start;max-height:calc(100dvh - 44px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;padding:14px 0 24px 30px}
.toc ol{list-style:none;margin:0;padding:0;border-left:var(--hair) solid var(--rule-soft)}
.toc a{position:relative;display:grid;grid-template-columns:8px minmax(0,1fr);gap:8px;align-items:center;margin-left:calc(-1 * var(--hair));padding:4px 6px 4px 10px;border-left:var(--hair) solid transparent;font-size:.78rem;line-height:1.35;color:var(--ink-3);text-decoration:none}
.toc a span{overflow:hidden;white-space:nowrap}
.toc a.owner span{color:var(--ink-2)}
/* A name that does not fit fades out over its last letters; one that fits is left alone. */
.toc a span.cut{mask-image:linear-gradient(to right,#000 calc(100% - 2.4em),transparent)}
@media (hover:hover){.toc a:hover span{color:var(--ink)}}
.toc a[aria-current]{border-left-color:var(--ink)}
.toc a[aria-current] span{color:var(--ink);font-weight:500}
.toc i{justify-self:center;width:7px;height:7px;border-radius:50%;background:var(--rule)}
.toc .owner i{background:var(--ink)}
.toc .other i{background:none;border:var(--hair) solid var(--ink-3)}
.toc .plan i{border-radius:1px;background:var(--ink-3)}
.toc .review i{width:6px;height:6px;border-radius:1px;transform:rotate(45deg);background:var(--ink-3)}
.toc .review.pass i{background:var(--ok)}
.toc .review.fix i{background:var(--stop)}
.toc .question i{background:var(--gate)}
.msg{scroll-margin-top:52px}
.dr h2{margin:0;font-size:1.32rem;font-weight:600;line-height:1.25;letter-spacing:-.012em;text-wrap:balance}
.call{margin:6px 0 0;font-size:.9rem;color:var(--gate)}
.trail{list-style:none;display:flex;flex-wrap:wrap;gap:3px 0;margin:14px 0 0;padding:0;font-size:.78rem;color:var(--ink-3)}
.trail li{display:flex;align-items:center;gap:4px}
.trail li:not(:last-child)::after{content:"";width:12px;border-top:var(--hair) solid var(--rule);margin:0 7px 0 3px}
.trail b{font-weight:400}
.trail .cur b{font-weight:500;color:var(--ink-2)}
.facts{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:3px}
.facts a{font-size:.78rem;color:var(--ink-3);text-underline-offset:3px;text-decoration-color:var(--rule);overflow-wrap:anywhere}
.thread{margin-top:18px;display:flex;flex-direction:column;border-top:var(--hair) solid var(--rule-soft)}
.msg{padding:16px 0 18px}
.msg+.msg{border-top:var(--hair) solid var(--rule-soft)}
.who{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;margin-bottom:5px;font-size:.78rem;color:var(--ink-3)}
.who b{font-size:.86rem;font-weight:600;color:var(--ink)}
.who em{font-style:normal}
.who time{margin-left:auto}
.body{min-width:0;overflow-wrap:anywhere;font-size:.94rem;line-height:1.56;text-wrap:pretty;line-break:strict;color:var(--ink)}
.body>*{margin:.55em 0 0}.body>:first-child{margin-top:0}
.body strong{font-weight:600}
.body h4{font-size:.78rem;font-weight:500;color:var(--ink-3);margin-top:1em}
.body ul,.body ol{padding-left:1.25em}.body li+li{margin-top:.35em}
.body ul:has(.sev){list-style:none;padding:0}
.body li:has(.sev){display:grid;grid-template-columns:22px minmax(0,1fr);gap:6px;align-items:baseline}
.body code{-webkit-box-decoration-break:clone;box-decoration-break:clone;font:.86em var(--mono);background:var(--code);padding:.08em .32em;border-radius:3px}
.body pre{font:.84rem/1.45 var(--mono);background:var(--code);padding:10px 12px;border-radius:4px;overflow-x:auto}
.sev{font-size:.76rem;font-weight:500;color:var(--ink-3)}
.sev.p0,.sev.p1{color:var(--stop)}
.verdict{font-size:.9rem;font-weight:500}
.verdict.pass{color:var(--ok)}.verdict.fix{color:var(--stop)}
.headsha{color:var(--ink-3);font-size:.78rem}
.headsha code{background:none;padding:0}

/* Below five columns' width the rail turns and runs down the page. Backlog goes last. */
@media (max-width:980px){
.line{display:flex;flex-direction:column;align-items:stretch;margin-top:22px}
.loop,.avg:empty{display:none}
.st{position:relative;padding:0;max-width:640px}
.st.parked{order:9;margin-top:6px}
.rail{position:absolute;top:0;left:0;margin:0;width:13px}
.rail::before{display:none}
.drop{padding:0 0 26px 18px;border-left-color:var(--rule)}
.st.parked .drop,.st.side .drop{border-left-color:transparent}
.top .drawn{margin-left:0;width:100%}
.bar{padding:0 18px}.dr{padding:6px 18px 36px}
}
/* On a narrow drawer the index is a strip of marks under the bar; names are kept for screen readers. */
@media (max-width:720px){
.cols{display:block}
.has-toc .dr{padding-left:18px}
.toc{top:44px;z-index:1;max-height:none;overflow:auto hidden;padding:0 12px;background:var(--plate);border-bottom:var(--hair) solid var(--rule-soft)}
.toc ol{display:flex;border:0}
.toc a{display:flex;justify-content:center;align-items:center;width:24px;height:30px;margin:0;padding:0;border:0;border-bottom:1.5px solid transparent}
.toc a span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.toc a[aria-current]{border-bottom-color:var(--ink)}
.msg{scroll-margin-top:84px}
}
@media (max-width:480px){.sheet{padding-block:18px 28px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}}
@media (prefers-reduced-motion:reduce){*{transition-duration:0s!important;transition-delay:0s!important}}
"""


STATIONS = [
    ("backlog", "Backlog", "parked side"),
    ("new", "New", "works"),
    ("review", "Review", "works"),
    ("ready", "Ready", "gate"),
    ("done", "Done", "side end"),
]

# Announces a copied ID to screen readers.
SAY = "<p id=say class=sr aria-live=polite></p>"

# Everything works without this. Esc closes a thread and focus goes back to the
# entry that opened it. --hair is one device pixel in CSS px, so lines stay crisp
# at 1.25x and 1.5x, rebuilt when the window moves to another density or zooms.
SCRIPT = """
function hair(){const d=devicePixelRatio||1;document.documentElement.style.setProperty('--hair',Math.max(1,Math.floor(d+1e-6))/d+'px');matchMedia('(resolution:'+d+'dppx)').addEventListener('change',hair,{once:true})}
hair();
let opener=null;
document.addEventListener('click',e=>{const a=e.target.closest('.item a.t');if(a)opener=a});
// Copy an ID. The check draws itself once; a second click draws it again. Without the
// clipboard API, or when it refuses (an old browser, a page not served over https), a hidden
// field copies it.
const say=document.getElementById('say');
function copy(text){
  return navigator.clipboard&&isSecureContext?navigator.clipboard.writeText(text).catch(()=>copyField(text)):copyField(text);
}
function copyField(text){
  const t=document.createElement('textarea');t.value=text;t.setAttribute('readonly','');t.style.cssText='position:fixed;opacity:0';
  document.body.append(t);t.select();const ok=document.execCommand('copy');t.remove();
  return ok?Promise.resolve():Promise.reject();
}
document.addEventListener('click',e=>{
  const b=e.target.closest('button.id');if(!b)return;
  copy(b.dataset.copy).then(()=>{
    b.classList.remove('copied');void b.offsetWidth;b.classList.add('copied');
    clearTimeout(b._t);b._t=setTimeout(()=>b.classList.remove('copied'),1400);
    say.textContent='';say.textContent='Copied '+b.dataset.copy;
  },()=>{say.textContent='Could not copy '+b.dataset.copy});
});
// The section index. Its links keep the item's own hash, because the drawer is open only while
// its id is the target; a click scrolls the drawer instead. The current section is the last one
// whose top has passed under the bar, read once a frame while the drawer scrolls.
for(const d of document.querySelectorAll('.drawer.has-toc')){
  const nav=d.querySelector('.toc'),links=[...nav.querySelectorAll('a')],secs=links.map(a=>document.getElementById(a.dataset.sec));
  let frame=0,held=null;
  const margin=()=>parseFloat(getComputedStyle(secs[0]).scrollMarginTop)||0;
  const mark=a=>{
    for(const x of links)x===a?x.setAttribute('aria-current','true'):x.removeAttribute('aria-current');
    // Keep the mark in view when the index scrolls itself: down a tall column, or along the phone strip.
    if(nav.scrollHeight>nav.clientHeight+1){const t=a.offsetTop,h=a.offsetHeight;if(t<nav.scrollTop||t+h>nav.scrollTop+nav.clientHeight)nav.scrollTop=t-(nav.clientHeight-h)/2}
    if(nav.scrollWidth>nav.clientWidth+1){const l=a.offsetLeft,w=a.offsetWidth;if(l<nav.scrollLeft||l+w>nav.scrollLeft+nav.clientWidth)nav.scrollLeft=l-(nav.clientWidth-w)/2}
  };
  const update=()=>{
    frame=0;if(held)return;
    const line=d.getBoundingClientRect().top+margin()+24;let cur=0;
    secs.forEach((s,i)=>{if(s.getBoundingClientRect().top<=line)cur=i});
    if(d.scrollTop+d.clientHeight>=d.scrollHeight-2)cur=secs.length-1;
    mark(links[cur]);
  };
  d.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(update)},{passive:true});
  // A clicked section stays marked, even one too near the end to reach the top, until the
  // reader scrolls on their own.
  for(const ev of ['wheel','touchstart','keydown','pointerdown'])d.addEventListener(ev,e=>{if(!nav.contains(e.target))held=null},{passive:true});
  nav.addEventListener('click',e=>{
    const a=e.target.closest('a');if(!a)return;e.preventDefault();
    const s=document.getElementById(a.dataset.sec),dist=s.getBoundingClientRect().top-d.getBoundingClientRect().top-margin();
    // Glide over a short way; jump a long one, so the view never trails the click.
    const smooth=Math.abs(dist)<d.clientHeight*1.5&&!matchMedia('(prefers-reduced-motion:reduce)').matches;
    held=a;mark(a);d.scrollTo({top:d.scrollTop+dist,behavior:smooth?'smooth':'auto'});
  });
  // Fade only the names that are cut; the column's width is fixed, so once is enough.
  for(const n of nav.querySelectorAll('span'))n.classList.toggle('cut',n.scrollWidth>n.clientWidth+1);
  update();
}
addEventListener('keydown',e=>{if(e.key==='Escape'&&location.hash.startsWith('#item-'))location.hash='closed'});
addEventListener('hashchange',()=>{if(!location.hash.startsWith('#item-')&&opener){opener.focus({preventScroll:true});opener=null}});
"""


def id_button(label):
    """An item's ID, which copies itself: FT16 is what people paste into chats and commits.

    An unnumbered item ("new") has no ID yet, so it stays text.
    """
    if not re.fullmatch(r"[A-Z]+\d+", label):
        return f"<span>{label}</span>"
    return (
        f'<button type=button class=id data-copy="{label}" title="Copy {label}">{label}'
        '<svg class=ok viewBox="0 0 10 10" aria-hidden=true><path pathLength=1 d="M1.5 5.5 4 8l5-6"/></svg></button>')


def render_item(it, now):
    """An entry. The title is the link, stretched over the entry, so the ID button can sit
    beside it: a button inside a link is invalid HTML, and its click would open the item."""
    e = html.escape
    label = id_button(it["label"])
    if rounds(it) > 1:
        label += f"<span> · round {it['round']}</span>"
    cues = ""
    if it["turn"] == "you":
        cues += f"<span class=ask>{ASK[it['folder']]}</span>"
    if it["problems"]:
        cues += "<span class=bad>Check the file</span>"
    return (
        f'<li class=item><span class=meta><span>{label}</span>'
        f'<time title="{when(it["since"])}">{age(it["since"], now)}</time></span>'
        f'<a class=t href="#item-{it["id"]}">{e(it["title"])}</a>{cues}</li>')


def render_station(name, cls, items, shown, avg, now, archive=False):
    stay = f"avg stay {avg}" if avg else ""
    out = [
        f'<section class="st {cls}"><div class=rail><span class=node></span></div><div class=drop>'
        f"<div class=head><h2><span>{name}</span><b>{len(items)}</b></h2>"
        f'<span class=avg title="Average stay, finished stays only">{stay}</span></div>']
    if shown:
        out.append("<ul class=items>" + "".join(render_item(it, now) for it in shown) + "</ul>")
    else:
        out.append("<p class=idle>Nothing here</p>")
    rest = items[len(shown):]
    if rest and archive:
        out.append(f'<p class=more><a href="{ARCHIVE}">All {len(items)} done</a></p>')
    elif rest:
        out.append(
            f"<details class=more><summary><span class=show>Show {len(rest)} more</span><span class=hide>Show fewer</span></summary>"
            "<ul class=items>" + "".join(render_item(it, now) for it in rest) + "</ul></details>")
    out.append("</div></section>")
    return "".join(out)


def render_trail(it, now):
    """Each stop and how long the item stayed there."""
    if not it["steps"]:
        return ""
    out = []
    for i, (folder, t) in enumerate(it["steps"]):
        last = i + 1 == len(it["steps"])
        end = now if last else it["steps"][i + 1][1]
        stay = "" if last and folder == "done" else f"<span>{span(end - t)}</span>"
        cls = " class=cur" if last else ""
        out.append(f'<li{cls} title="{when(t)}"><b>{html.escape(folder)}</b>{stay}</li>')
    return "<ol class=trail>" + "".join(out) + "</ol>"


# A thread this long gets an index of its sections beside it.
TOC_FROM = 3


def gist(body):
    """A section's first words, without Markdown: what tells one report or note from the next."""
    for line in body.splitlines():
        text = re.sub(r"[`*]", "", re.sub(r"^\s*(?:#+|[-*]|\d+\.)\s+", "", line)).strip()
        if text:
            return text[:80]
    return ""


def section_kind(s, owners):
    """How the index marks a section: its classes and its name there. A plan, review or
    question is named by its kind; a report or note by its first words, since its mark
    already says who wrote it."""
    if s["kind"] == "review":
        v = re.search(r"^verdict:\s*(pass|fix)\b", s["body"], re.M)
        return ("review " + v.group(1), f"Review · {v.group(1)}") if v else ("review", "Review")
    if s["kind"] in ("plan", "question"):
        return s["kind"], s["kind"].capitalize()
    cls = "factory" if s["who"] == "factory" else "owner" if s["who"] in owners else "other"
    return cls, gist(s["body"]) or s["who"]


def render_toc(it, owners):
    out = []
    for i, s in enumerate(it["sections"]):
        cls, name = section_kind(s, owners)
        out.append(
            f'<li><a class="{cls}" href="#item-{it["id"]}" data-sec="s{it["id"]}-{i}" title="{html.escape(s["who"])} · {html.escape(s["time"])}">'
            f'<i></i><span>{html.escape(name)}</span></a></li>')
    return '<nav class=toc aria-label="Sections"><ol>' + "".join(out) + "</ol></nav>"


def render_detail(it, now, owners):
    e = html.escape
    call = ""
    if it["turn"] == "you":
        call = f"<p class=call>{ASK[it['folder']]}. Waiting {age(it['since'], now)}.</p>"
    problems = ""
    if it["problems"]:
        problems = "<p class=problems>The file breaks the format: " + e("; ".join(sorted(set(it["problems"])))) + ".</p>"
    branch = ""
    if it["branch"]:
        code = e(it["branch"])
        branch = f'<a href="{e(it["link"])}" rel="noopener">{code}</a>' if it["link"] else f"<span>{code}</span>"
        branch = f"<div class=facts>{branch}</div>"
    thread = []
    for i, s in enumerate(it["sections"]):
        kind = {"plan": "Plan", "review": "Review", "question": "Question"}.get(s["kind"], "")
        kind = f"<em>{kind}</em>" if kind else ""
        thread.append(
            f'<section class=msg id="s{it["id"]}-{i}"><div class=who><b>{e(s["who"])}</b>{kind}<time>{e(s["time"])}</time></div>'
            f'<div class=body>{body_html(s["body"], s["kind"] == "review")}</div></section>')
    toc = render_toc(it, owners) if len(it["sections"]) >= TOC_FROM else ""
    return (
        f'<article class=detail id="item-{it["id"]}" aria-label="{e(it["title"])}">'
        f'<a class=shade href="#closed" tabindex=-1 aria-hidden=true></a><div class="drawer{" has-toc" if toc else ""}">'
        f'<div class=bar><span>{id_button(it["label"])} · {it["folder"]}</span><a class=close href="#closed">Close</a></div>'
        f'<div class=cols>{toc}<div class=dr><h2>{e(it["title"])}</h2>{call}{problems}{render_trail(it, now)}{branch}'
        f'<div class=thread>{"".join(thread)}</div></div></div></div></article>')


def render(cfg, name, items, archive=False):
    """The board. With archive, older done items are left to done.html and their threads left out."""
    today = dt.datetime.now(TZ)
    now = today.timestamp()
    by = {f: [] for f in FOLDERS}
    for it in items:
        by[it["folder"]].append(it)
    for f in FOLDERS:
        by[f].sort(key=lambda it: -it["changed"] if f == "done" else it["since"])
    yours = sum(1 for it in items if it["turn"] == "you")
    agents = sum(1 for it in items if it["turn"] == "agent")
    sent_back = sum(max(0, rounds(it) - 1) for it in items)
    e = html.escape
    gates = f"<b>{yours} at your gates</b> · " if yours else "Nothing at your gates · "
    link = f'<a href="{e(cfg["github_url"])}" rel="noopener">GitHub</a> · ' if cfg.get("github_url") else ""
    out = [
        "<!doctype html><html lang=en><head><meta charset=utf-8>",
        '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">',
        f"<title>{e(name)} · factory board</title><style>{CSS}</style></head><body><div class=sheet>",
        f"<header class=top><h1>{e(name)}</h1><span class=sum>{gates}{agents} with the agent · {len(by['done'])} done</span>",
        f"<span class=drawn>{link}Drawn {today:%b} {today.day}, {today:%H:%M}</span></header><main class=line>",
    ]
    if sent_back:
        out.append(f"<div class=loop><span>{sent_back} sent back</span></div>")
    for key, title, cls in STATIONS:
        if any(it["turn"] == "you" for it in by[key]):
            cls = "gate"
        shown = by[key][:DONE_SHOWN] if key == "done" else by[key]
        avg = average_stay(items, key) if key in ("new", "review", "ready") else ""
        out.append(render_station(title, cls, by[key], shown, avg, now, archive))
    out.append("</main></div>")
    older = by["done"][DONE_SHOWN:] if archive else []
    owners = set(cfg.get("owners", []))
    out += [render_detail(it, now, owners) for it in items if it not in older]
    out.append(f"{SAY}<script>{SCRIPT}</script></body></html>\n")
    return "".join(out)


def render_archive(cfg, name, items, board):
    """Every done item by month, newest first. Each title opens its file on GitHub."""
    e = html.escape
    done = sorted((it for it in items if it["folder"] == "done"), key=lambda it: -it["changed"])
    months = {}
    for it in done:
        month = dt.datetime.fromtimestamp(it["changed"], TZ).strftime("%B %Y") if it["changed"] else "Undated"
        months.setdefault(month, []).append(it)
    out = [
        "<!doctype html><html lang=en><head><meta charset=utf-8>",
        '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">',
        f"<title>{e(name)} · done</title><style>{CSS}</style></head><body><div class=sheet>",
        f"<header class=top><h1>{e(name)}</h1><span class=sum>{len(done)} done</span>",
        f'<span class=drawn><a href="{e(board)}">Back to the board</a></span></header><main class=archive>',
    ]
    for i, (month, group) in enumerate(months.items()):
        out.append(f'<details{" open" if i == 0 else ""}><summary><span>{month}</span><b>{len(group)}</b></summary><ul>')
        for it in group:
            title = e(it["title"])
            if cfg.get("github_url"):
                title = f'<a href="{e(cfg["github_url"])}/blob/{BOARD_BRANCH}/{e(it["file"])}" rel="noopener">{title}</a>'
            day = dt.datetime.fromtimestamp(it["changed"], TZ) if it["changed"] else None
            date = f"{day:%b} {day.day}" if day else ""
            out.append(f'<li>{id_button(it["label"])}<span class=t>{title}</span><time title="{when(it["changed"])}">{date}</time></li>')
        out.append("</ul></details>")
    out.append(f"</main></div>{SAY}<script>{SCRIPT}</script></body></html>\n")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser(description="Render a .factory/ board as one HTML page.")
    ap.add_argument("repo", nargs="?", default=".", help="a checkout of factory_board (default: the current directory)")
    ap.add_argument("-o", "--out", help="write here instead of to standard output")
    a = ap.parse_args()
    if not os.path.isfile(os.path.join(a.repo, ".factory", "factory.toml")):
        sys.exit(f"board.py: {a.repo} has no .factory/factory.toml; give a checkout of factory_board")
    cfg, name, items = load(a.repo)
    if not a.out:  # one stream holds one page, so the board keeps every item
        sys.stdout.write(render(cfg, name, items))
        return
    archive = os.path.join(os.path.dirname(a.out), ARCHIVE)
    if os.path.basename(a.out) == ARCHIVE:
        sys.exit(f"board.py: {ARCHIVE} is the done list's name; write the board to another")
    long_done = sum(1 for it in items if it["folder"] == "done") > DONE_SHOWN
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(render(cfg, name, items, long_done))
    if long_done:
        with open(archive, "w", encoding="utf-8") as f:
            f.write(render_archive(cfg, name, items, os.path.basename(a.out)))


if __name__ == "__main__":
    main()
