#!/usr/bin/env python3
"""Render a repository's .factory/ board as one static HTML page.

    board.py [REPO] [-o board.html]

REPO is a checkout of the factory_board branch, where the board lives; it
defaults to the current directory. references/board-pages.yml runs it on
GitHub Actions to publish the board on GitHub Pages. The page has a column per folder
(not stop/: parked items are left out; backlog/ is the owner's and waits for nobody), a card per item (whose turn it is,
its branch, its fix round) and, behind each card, the item's thread and the
times it moved between folders, read from git. It needs only Python 3.11 and git, and loads nothing from the
network. Item files are other people's text: everything is escaped.
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
DONE_SHOWN = 12
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


def moves(repo, path):
    """When the item entered each folder: [(folder, unix time)], oldest first."""
    out = git(repo, "log", "--follow", "--name-only", "--format=%x00%ct", "--", path)
    seen = []
    for chunk in out.split("\x00")[1:]:
        parts = chunk.strip().splitlines()
        if len(parts) < 2:
            continue
        folder = parts[-1].split("/")[-2] if "/" in parts[-1] else ""
        seen.append((folder, int(parts[0])))
    seen.reverse()
    steps = []
    for folder, t in seen:
        if not steps or steps[-1][0] != folder:
            steps.append((folder, t))
    return steps


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


def branch_link(repo, remote, base, branch):
    url = git(repo, "remote", "get-url", remote).strip()
    m = re.match(r"^(?:git@github\.com:|https://github\.com/)([\w.-]+/[\w.-]+?)(?:\.git)?$", url)
    if not m or not branch:
        return ""
    return f"https://github.com/{m.group(1)}/compare/{base}...{branch}"


def when(t):
    return dt.datetime.fromtimestamp(t, TZ).strftime("%Y-%m-%d %H:%M") if t else ""


def short(t, year):
    """A card's time: the year only when it isn't this one."""
    if not t:
        return ""
    d = dt.datetime.fromtimestamp(t, TZ)
    return d.strftime("%m-%d %H:%M" if d.year == year else "%Y-%m-%d")


# What a card asks of you, by folder, when it's your turn.
ASK = {"review": "decide", "ready": "check"}


def body_html(text):
    out = html.escape(text)
    out = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", out)
    out = re.sub(r"(https://[^\s<&]+(?:&amp;[^\s<&]+)*)", r'<a href="\1" rel="noopener">\1</a>', out)
    return out


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
            steps = moves(repo, path)
            items.append({
                "n": n, "slug": m.group(3), "folder": folder,
                "id": str(n) if n else m.group(3), "label": label,
                "title": title or m.group(3).replace("-", " "),
                "branch": header.get("branch", ""), "round": header.get("round", ""),
                "sections": sections, "problems": problems, "steps": steps,
                "changed": steps[-1][1] if steps else 0,
                "turn": turn(folder, sections),
                "link": branch_link(repo, remote, base, header.get("branch", "")),
            })
    name = os.path.basename(os.path.abspath(repo))
    return cfg, name, items


CSS = """
:root{--bg:#f3f4f7;--surface:#fff;--fg:#1c1f2a;--muted:#5d6273;--line:#d9dce5;--accent:#5319e7;--accent-soft:#ece6fd;
--you:#b4530f;--you-soft:#fbeee3;--ok:#1d7a4c;--warn:#b42318;--code:#eceef3;
--sans:system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14161d;--surface:#1c1f28;--fg:#e4e6ee;--muted:#9aa0b3;--line:#2f3340;
--accent:#a98bff;--accent-soft:#2a2245;--you:#f0a060;--you-soft:#3a2a1c;--ok:#6fd0a0;--warn:#ff8a7a;--code:#232733;color-scheme:dark}}
:root[data-theme=dark]{--bg:#14161d;--surface:#1c1f28;--fg:#e4e6ee;--muted:#9aa0b3;--line:#2f3340;
--accent:#a98bff;--accent-soft:#2a2245;--you:#f0a060;--you-soft:#3a2a1c;--ok:#6fd0a0;--warn:#ff8a7a;--code:#232733;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--sans);font-variant-numeric:tabular-nums;padding:28px max(16px,env(safe-area-inset-left)) 60px}
header{max-width:1400px;margin:0 auto 22px;display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline}
h1{font-size:1.6rem;margin:0}
.meta{color:var(--muted);font-size:.9rem}
.sum{display:flex;gap:14px;flex-wrap:wrap;font-size:.9rem}
.sum b{font-family:var(--mono)}
.board{max-width:1400px;margin:0 auto;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px}
.col{display:flex;flex-direction:column;gap:8px;min-width:0}
.col h2{font:600 .8rem/1 var(--mono);color:var(--muted);margin:0;padding:6px 2px;display:flex;justify-content:space-between}
.card{display:flex;flex-direction:column;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:10px 12px;color:inherit;text-decoration:none;
transition:border-color 0s}
/* Calm hover: sweeping the pointer across the board must not flash every card,
   so the fill comes in after a beat and leaves at once. Touch screens get none. */
@media (hover:hover){.card:hover{border-color:var(--accent);transition:border-color .15s ease-out 60ms}}
.card:focus-visible,.close:focus-visible{outline:1.5px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px}
.card .top{display:flex;justify-content:space-between;gap:8px;font:.76rem var(--mono);color:var(--muted)}
.card .t{font-weight:600;line-height:1.3;text-wrap:balance;overflow-wrap:anywhere}
.row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px;font-size:.78rem;color:var(--muted)}
.row:empty{display:none}
.chip{font:600 .7rem/1 var(--mono);padding:4px 6px;border-radius:3px}
.chip.you{background:var(--you-soft);color:var(--you)}
.chip.bad{background:var(--you-soft);color:var(--warn)}
.empty{color:var(--muted);font-size:.85rem;padding:2px}
.more{color:var(--muted);font-size:.82rem;padding:2px}
/* The thread opens over the board, so the page keeps its scroll position.
   CSS only: :target shows it; closing links to a missing id, which clears
   :target without scrolling the page the way href="#" would. */
.detail{display:none;position:fixed;inset:0;z-index:1;padding:24px 16px;place-items:start center;overflow-y:auto;overscroll-behavior:contain}
.detail:target{display:grid}
.detail .shade{position:fixed;inset:0;background:color-mix(in srgb,var(--bg) 70%,transparent);backdrop-filter:blur(2px)}
.panel{position:relative;width:min(820px,100%);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:20px 22px;
box-shadow:0 12px 40px rgb(0 0 0 / .14);animation:rise .18s ease-out}
@keyframes rise{from{opacity:0;transform:translateY(6px) scale(.985)}}
@media (prefers-reduced-motion:reduce){.panel{animation:none}}
.panel .head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.panel h2{margin:0;font-size:1.25rem;line-height:1.3;text-wrap:balance}
.panel h2 span{color:var(--muted);font:600 .95rem var(--mono);margin-right:6px}
.close{font-size:.9rem;color:var(--accent);flex:none;border-radius:2px}
.facts{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.88rem;color:var(--muted);margin:10px 0 0}
.facts code,.sec code{font-family:var(--mono);font-size:.85em;background:var(--code);padding:.05em .3em;border-radius:3px}
.steps{display:flex;flex-wrap:wrap;gap:4px 8px;margin:12px 0 6px;font:.78rem var(--mono);color:var(--muted)}
.steps b{color:var(--fg);font-weight:600}
.problems{color:var(--warn);font-size:.88rem;margin:10px 0 0}
.sec{border-top:1px solid var(--line);padding:12px 0 4px}
.sec .h{font:600 .8rem var(--mono);display:flex;flex-wrap:wrap;gap:4px 10px}
.sec.you .h{color:var(--you)}
.sec.agent .h{color:var(--accent)}
.sec .h span{color:var(--muted);font-weight:400}
.sec .b{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:4px;font-size:.94rem;text-wrap:pretty}
a{color:var(--accent)}
@media (max-width:760px){.board{grid-template-columns:1fr;gap:20px}.col.none{display:none}.panel{padding:16px}}
"""


def render(cfg, name, items):
    owners = set(cfg.get("owners", []))
    today = dt.datetime.now(TZ)
    now = today.strftime("%Y-%m-%d %H:%M")
    by = {f: [] for f in FOLDERS}
    for it in items:
        by[it["folder"]].append(it)
    for f in FOLDERS:
        by[f].sort(key=lambda it: -it["changed"] if f == "done" else it["changed"])
    yours = sum(1 for it in items if it["turn"] == "you")
    agents = sum(1 for it in items if it["turn"] == "agent")
    e = html.escape
    out = [
        "<!doctype html><html lang=en><head><meta charset=utf-8>",
        '<meta name=viewport content="width=device-width,initial-scale=1">',
        f"<title>{e(name)} · factory board</title><style>{CSS}</style></head><body>",
        f"<header><h1>{e(name)}</h1><span class=meta>factory board · built {now}</span>",
        f'<span class=sum><span><b>{yours}</b> waiting for you</span><span><b>{agents}</b> for the agent</span>'
        f"<span><b>{len(by['done'])}</b> done</span></span></header>",
        '<main class=board>',
    ]
    for f in FOLDERS:
        shown = by[f][:DONE_SHOWN] if f == "done" else by[f]
        none = "" if shown else " none"
        out.append(f'<section class="col{none}"><h2><span>{f}/</span><span>{len(by[f])}</span></h2>')
        if not shown:
            out.append("<span class=empty>empty</span>")
        for it in shown:
            # One cue per card: what it asks of you. The agent's turn needs none.
            row = ""
            if it["turn"] == "you":
                row += f'<span class="chip you">{ASK[f]}</span>'
            if it["problems"]:
                row += '<span class="chip bad">check file</span>'
            if it["round"] not in ("", "0"):
                row += f"<span>round {e(it['round'])}</span>"
            out.append(
                f'<a class=card href="#item-{it["id"]}">'
                f'<span class=top><span>{it["label"]}</span>'
                f'<time title="{when(it["changed"])}">{short(it["changed"], today.year)}</time></span>'
                f'<span class=t>{e(it["title"])}</span><span class=row>{row}</span></a>')
        if f == "done" and len(by[f]) > DONE_SHOWN:
            out.append(f"<span class=more>and {len(by[f]) - DONE_SHOWN} more</span>")
        out.append("</section>")
    out.append("</main>")
    for it in items:
        facts = [f"in <code>{it['folder']}/</code>"]
        if it["branch"]:
            b = f"<code>{e(it['branch'])}</code>"
            if it["link"]:
                b = f'<a href="{e(it["link"])}" rel="noopener">{b}</a>'
            facts.append("branch " + b)
        if it["round"] not in ("", "0"):
            facts.append(f"fix round {e(it['round'])}")
        if it["turn"]:
            facts.append(f"your turn: {ASK[it['folder']]}" if it["turn"] == "you" else "the agent's turn")
        steps = " → ".join(f"<b>{e(fo)}/</b> {when(t)}" for fo, t in it["steps"])
        out.append(
            f'<article class=detail id="item-{it["id"]}" aria-label="{e(it["title"])}">'
            '<a class=shade href="#_" tabindex=-1 aria-hidden=true></a><div class=panel>'
            f'<div class=head><h2><span>{it["label"]}</span>{e(it["title"])}</h2>'
            f'<a class=close href="#_">Close</a></div><div class=facts>{"<span>" + "</span><span>".join(facts) + "</span>"}</div>'
            f'<div class=steps>{steps}</div>')
        if it["problems"]:
            out.append("<p class=problems>The file breaks the format: " + e("; ".join(sorted(set(it["problems"])))) + ".</p>")
        for s in it["sections"]:
            side = "agent" if s["who"] == "factory" else ("you" if s["who"] in owners else "")
            kind = f" · {s['kind']}" if s["kind"] else ""
            out.append(
                f'<div class="sec {side}"><div class=h>{e(s["who"])}{kind}<span>{e(s["time"])}</span></div>'
                f'<div class=b>{body_html(s["body"])}</div></div>')
        out.append("</div></article>")
    # Esc closes an open thread; everything else works without script.
    out.append("<script>addEventListener('keydown',e=>{if(e.key==='Escape'&&location.hash.startsWith('#item-'))location.hash='_'})</script>")
    out.append("</body></html>\n")
    return "".join(out)


def main():
    ap = argparse.ArgumentParser(description="Render a .factory/ board as one HTML page.")
    ap.add_argument("repo", nargs="?", default=".", help="a checkout of factory_board (default: the current directory)")
    ap.add_argument("-o", "--out", help="write here instead of to standard output")
    a = ap.parse_args()
    if not os.path.isfile(os.path.join(a.repo, ".factory", "factory.toml")):
        sys.exit(f"board.py: {a.repo} has no .factory/factory.toml; give a checkout of factory_board")
    page = render(*load(a.repo))
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(page)
    else:
        sys.stdout.write(page)


if __name__ == "__main__":
    main()
