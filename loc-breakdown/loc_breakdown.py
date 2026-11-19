#!/usr/bin/env python3
"""Count the lines in a change so an LLM only has to label them.

  collect  splits a diff into numbered hunks, counts them by category,
           language, directory and mechanical kind (moved, whitespace-only,
           blank, comment), and adds what cloc, sem and lizard report when
           they are installed.
  tally    reads the LLM's {hunk|path|glob: purpose} labels and sums the
           counts per purpose. It fails if any hunk is unlabeled.

Every number in the final report comes from here, not from the model.
"""
import argparse
import csv
import fnmatch
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

WORKTREE = "WORKTREE"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$")
# Moved lines get their own colours so one coloured diff yields both the
# hunks and git's --color-moved verdict for each line.
OLD, NEW, OLD_MOVED, NEW_MOVED = "31", "32", "35", "34"
GIT_COLORS = {
    "color.diff.old": "red", "color.diff.new": "green",
    "color.diff.oldMoved": "magenta", "color.diff.oldMovedAlternative": "magenta",
    "color.diff.newMoved": "blue", "color.diff.newMovedAlternative": "blue",
    "color.diff.oldMovedDimmed": "magenta", "color.diff.oldMovedAlternativeDimmed": "magenta",
    "color.diff.newMovedDimmed": "blue", "color.diff.newMovedAlternativeDimmed": "blue",
    "color.diff.meta": "normal", "color.diff.frag": "normal", "color.diff.func": "normal",
    "color.diff.context": "normal", "color.diff.whitespace": "normal",
    "color.diff.commit": "normal",
    # Neutralise user config that changes the output's shape.
    "diff.noprefix": "false", "diff.mnemonicPrefix": "false", "diff.relative": "false",
    "core.quotePath": "false",
    # Not diff.external: setting it, even empty, silently disables
    # --color-moved. --no-ext-diff already blocks external tools.
}

# ---------------------------------------------------------------- classify

LOCKFILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock",
    "uv.lock", "Pipfile.lock", "go.sum", "composer.lock", "Gemfile.lock", "bun.lockb",
}
GENERATED_GLOBS = ["*generated*", "*.min.js", "*.min.css", "*_pb2.py", "*.pb.cc", "*.pb.h",
                   "*.snap", "*/__snapshots__/*"]
VENDORED_DIRS = {"vendor", "third_party", "thirdparty", "external", "node_modules", "3rdparty"}
TEST_DIRS = {"test", "tests", "__tests__", "testing", "e2e", "fixtures", "testdata"}
TEST_GLOBS = ["test_*", "*_test.*", "*_tests.*", "*.test.*", "*.spec.*", "conftest.py"]
CI_PREFIXES = (".github/", ".gitlab-ci", ".circleci/", "azure-pipelines", ".buildkite/")
DOC_EXTS = {".md", ".rst", ".adoc", ".txt"}
DOC_DIRS = {"docs", "doc"}
BUILD_NAMES = {
    "CMakeLists.txt", "CMakePresets.json", "Makefile", "meson.build", "package.json",
    "pyproject.toml", "setup.py", "setup.cfg", "Cargo.toml", "vcpkg.json", "conanfile.txt",
    "conanfile.py", "setup.sh", "setup.ps1", "tsconfig.json", "go.mod", "build.gradle",
}
BUILD_GLOBS = ["*.cmake", "*.mk", "Dockerfile*", "*.Dockerfile", "requirements*.txt",
               "*.cmake.in", "vite.config.*", "webpack.config.*"]
BUILD_DIRS = {"cmake", "debian", "packaging"}
ASSET_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp", ".wav", ".mp3",
              ".ttf", ".woff", ".woff2", ".otf", ".icns", ".bmp"}
DATA_EXTS = {".json", ".jsonl", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".xml",
             ".csv", ".in"}
CATEGORIES = ["src", "test", "docs", "build", "ci", "data", "assets", "generated", "vendored"]

LANGS = {
    ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".c++": "C++", ".ipp": "C++",
    ".h": "C/C++ header", ".hpp": "C/C++ header", ".hh": "C/C++ header", ".hxx": "C/C++ header",
    ".c": "C", ".py": "Python", ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript",
    ".cjs": "JavaScript", ".mjs": "JavaScript", ".jsx": "JavaScript", ".rs": "Rust",
    ".go": "Go", ".java": "Java", ".cs": "C#", ".sh": "Shell", ".bash": "Shell",
    ".ps1": "PowerShell", ".md": "Markdown", ".rst": "reST", ".html": "HTML", ".css": "CSS",
    ".scss": "CSS", ".json": "JSON", ".jsonl": "JSON", ".yml": "YAML", ".yaml": "YAML",
    ".toml": "TOML", ".cmake": "CMake", ".xml": "XML", ".in": "template",
}
LANG_NAMES = {"CMakeLists.txt": "CMake", "Dockerfile": "Dockerfile", "Makefile": "Make"}
C_COMMENT = {"C++", "C/C++ header", "C", "TypeScript", "JavaScript", "Rust", "Go", "Java",
             "C#", "CSS"}
HASH_COMMENT = {"Python", "Shell", "PowerShell", "YAML", "TOML", "CMake", "Dockerfile", "Make"}


def language(path):
    name = os.path.basename(path)
    if name in LANG_NAMES:
        return LANG_NAMES[name]
    if name.startswith("Dockerfile"):
        return "Dockerfile"
    return LANGS.get(os.path.splitext(name)[1].lower(), "other")


def _glob(name, globs):
    return any(fnmatch.fnmatch(name, g) for g in globs)


def category(path, attrs=None):
    """First matching rule wins; attrs are this path's linguist-* gitattributes."""
    attrs = attrs or {}
    parts = path.split("/")
    dirs, name = parts[:-1], parts[-1]
    ext = os.path.splitext(name)[1].lower()
    if attrs.get("linguist-generated") or name in LOCKFILES or _glob(path, GENERATED_GLOBS):
        return "generated"
    if attrs.get("linguist-vendored") or VENDORED_DIRS & set(dirs):
        return "vendored"
    if path.startswith(CI_PREFIXES):
        return "ci"
    if TEST_DIRS & set(dirs) or _glob(name, TEST_GLOBS):
        return "test"
    if attrs.get("linguist-documentation") or (DOC_DIRS & set(dirs[:1]) and ext not in {".py"}) \
            or ext in DOC_EXTS and not _glob(name, BUILD_GLOBS) and name not in BUILD_NAMES:
        return "docs"
    if name in BUILD_NAMES or _glob(name, BUILD_GLOBS) or BUILD_DIRS & set(dirs):
        return "build"
    if ext in ASSET_EXTS:
        return "assets"
    if ext in DATA_EXTS:
        return "data"
    return "src"


def line_kind(text, lang):
    """'blank', 'comment' or 'code'. A line-prefix heuristic; cloc is the exact count."""
    s = text.strip()
    if not s:
        return "blank"
    if lang in C_COMMENT and (s.startswith(("//", "/*", "*/")) or s == "*" or s.startswith("* ")):
        return "comment"
    if lang in HASH_COMMENT and s.startswith("#"):
        return "comment"
    if lang in {"HTML", "XML", "Markdown"} and s.startswith("<!--"):
        return "comment"
    return "code"


# --------------------------------------------------------------------- git

def git(repo, *args, ok=(0,), color=False):
    cfg = []
    if color:
        for k, v in GIT_COLORS.items():
            cfg += ["-c", f"{k}={v}"]
    p = subprocess.run(["git", "-C", repo, *cfg, *args], capture_output=True)
    if p.returncode not in ok:
        sys.exit(f"git {' '.join(args)} failed: {p.stderr.decode(errors='replace').strip()}")
    return p.stdout.decode(errors="replace")


def diff_args(base, head, pathspec, context=3):
    common = ["diff", f"-U{context}", "--color=always", "--color-moved=zebra",
              "-M", "-C", "--no-ext-diff",
              "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative"]
    revs = [base] if head == WORKTREE else [base, head]
    return common + revs + ["--"] + pathspec


def parse_diff(text):
    """Yield file dicts with their hunks from a coloured `git diff`."""
    files, cur, hunk = [], None, None
    for raw in text.split("\n"):
        color = raw[2:raw.index("m")] if raw.startswith("\x1b[") and "m" in raw[:8] else ""
        line = ANSI.sub("", raw)
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            cur = {"old": m.group(1), "new": m.group(2), "status": "M", "binary": False,
                   "similarity": None, "hunks": []}
            files.append(cur)
            hunk = None
            continue
        if cur is None:
            continue
        if hunk is None:
            if line.startswith("new file mode"):
                cur["status"] = "A"
            elif line.startswith("deleted file mode"):
                cur["status"] = "D"
            elif line.startswith("rename from "):
                cur["status"], cur["old"] = "R", line[12:]
            elif line.startswith("rename to "):
                cur["new"] = line[10:]
            elif line.startswith("copy from "):
                cur["status"], cur["old"] = "C", line[10:]
            elif line.startswith("copy to "):
                cur["new"] = line[8:]
            elif line.startswith("similarity index "):
                cur["similarity"] = int(line[17:].rstrip("%"))
            elif line.startswith("Binary files "):
                cur["binary"] = True
            elif line.startswith("--- a/"):
                cur["old"] = line[6:]
            elif line.startswith("+++ b/"):
                cur["new"] = line[6:]
        m = HUNK_RE.match(line)
        if m:
            hunk = {"old_start": int(m.group(1)), "old_len": int(m.group(2) or 1),
                    "new_start": int(m.group(3)), "new_len": int(m.group(4) or 1),
                    "func": m.group(5).strip(), "lines": []}
            cur["hunks"].append(hunk)
            continue
        if hunk is not None and line[:1] in ("+", "-", " "):
            moved = color.split(";")[-1] in (OLD_MOVED, NEW_MOVED)
            hunk["lines"].append((line[0], line[1:], moved))
    return files


def untracked(repo, pathspec):
    out = git(repo, "ls-files", "-z", "--others", "--exclude-standard", "--", *pathspec)
    return [p for p in out.split("\0") if p]


def untracked_diffs(repo, paths):
    files = []
    for p in paths:
        out = git(repo, "-c", "core.quotePath=false", "diff", "--no-index", "--color=never",
                  "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", p, ok=(0, 1))
        for f in parse_diff(out):
            f.update(old=p, new=p, status="A", untracked=True)
            files.append(f)
    return files


def gitattrs(repo, paths):
    if not paths:
        return {}
    p = subprocess.run(
        ["git", "-C", repo, "check-attr", "-z", "--stdin", "linguist-generated",
         "linguist-vendored", "linguist-documentation"],
        input="\0".join(paths).encode(), capture_output=True)
    res = defaultdict(dict)
    parts = p.stdout.decode(errors="replace").split("\0")
    for i in range(0, len(parts) - 2, 3):
        path, attr, val = parts[i:i + 3]
        if val in ("set", "true"):
            res[path][attr] = True
    return res


# ------------------------------------------------------------------- count

def count_hunk(h, lang):
    c = Counter()
    norm_rm, norm_add = Counter(), Counter()
    for sign, text, moved in h["lines"]:
        if sign == " ":
            continue
        side = "added" if sign == "+" else "removed"
        c[side] += 1
        c[f"{side}_{line_kind(text, lang)}"] += 1
        if moved:
            c[f"{side}_moved"] += 1
        elif text.strip():
            (norm_add if sign == "+" else norm_rm)["".join(text.split())] += 1
    # A removed line that reappears in the same hunk differing only in
    # whitespace counts once on each side as a whitespace-only edit.
    c["ws_only"] = sum((norm_rm & norm_add).values())
    return c


def build_hunks(files, attrs):
    hunks = []
    for f in files:
        path = f["new"] if f["status"] != "D" else f["old"]
        f["path"] = path
        f["category"] = category(path, attrs.get(path))
        f["language"] = language(path)
        f["hunk_ids"] = []
        bodies = f["hunks"] or [None]
        for h in bodies:
            hid = f"h{len(hunks) + 1}"
            f["hunk_ids"].append(hid)
            rec = {"id": hid, "path": path, "old_path": f["old"], "status": f["status"],
                   "category": f["category"], "language": f["language"]}
            if h is None:
                rec["kind"] = "binary" if f["binary"] else (
                    "rename" if f["status"] in "RC" else "mode")
                rec["counts"] = {}
            else:
                rec.update(kind="text", old_start=h["old_start"], old_len=h["old_len"],
                           new_start=h["new_start"], new_len=h["new_len"], func=h["func"])
                rec["counts"] = dict(count_hunk(h, f["language"]))
                rec["lines"] = [s + t for s, t, _ in h["lines"]]
            hunks.append(rec)
    return hunks


# ------------------------------------------------------------ materialize

def materialize(repo, base, head, files, out):
    """Write each changed file's before/after text under its *new* path, so
    cloc and lizard pair renamed files instead of counting add + delete."""
    before, after = out / "before", out / "after"
    for d in (before, after):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    for f in files:
        if f["binary"]:
            continue
        if f["status"] not in ("A",):
            src = f["old"]
            p = subprocess.run(["git", "-C", repo, "show", f"{base}:{src}"], capture_output=True)
            if p.returncode == 0:
                _write(before / f["path"], p.stdout)
        if f["status"] != "D":
            if head == WORKTREE:
                fp = Path(repo) / f["path"]
                if fp.is_file():
                    _write(after / f["path"], fp.read_bytes())
            else:
                p = subprocess.run(["git", "-C", repo, "show", f"{head}:{f['path']}"],
                                   capture_output=True)
                if p.returncode == 0:
                    _write(after / f["path"], p.stdout)
    return before, after


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


# ------------------------------------------------------------------ tools

CLOC_SKIP_LANGS = ["JSON", "JSON5", "Markdown", "Text", "SVG", "XML", "CSV",
                   "reStructuredText", "AsciiDoc"]


def run_cloc(before, after):
    if not shutil.which("cloc"):
        return None
    # Comment/blank splits mean nothing for data and prose, and cloc's
    # line pairing is slow on big JSON (lemonade HEAD~30: 8.6s of 10s).
    p = subprocess.run(["cloc", "--diff", str(before), str(after), "--json", "--quiet",
                        "--exclude-lang=" + ",".join(CLOC_SKIP_LANGS)],
                       capture_output=True, text=True)
    try:
        data = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"error": (p.stderr or p.stdout)[:300]}
    rows = {}
    for kind in ("added", "removed", "modified"):
        for lang, v in data.get(kind, {}).items():
            r = rows.setdefault(lang, {})
            for k in ("code", "comment", "blank"):
                r[f"{kind}_{k}"] = v.get(k, 0)
    return {"languages": rows, "sum": data.get("SUM", {})}


def run_sem(repo, base, head, pathspec):
    exe = shutil.which("sem")
    if not exe:
        return None
    rng = [base] if head == WORKTREE else [f"{base}..{head}"]
    p = subprocess.run([exe, "diff", *rng, "--format", "json", "--", *pathspec], cwd=repo,
                       capture_output=True, text=True, env={**os.environ, "SEM_CLOUD": "0"})
    try:
        data = json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"error": (p.stderr or p.stdout)[:300]}
    kept, shifted = [], 0
    for c in data.get("changes", []):
        # sem's entity ids embed the enclosing namespace's line number, so
        # lines inserted above a namespace report every entity in it as
        # "moved" (lemonade 084ebdac2: +71/-5, 19 false moves). A same-file
        # move with identical content is only a shift; drop it.
        if c.get("changeType") == "moved" and c.get("oldFilePath") in (None, c.get("filePath")) \
                and c.get("beforeContent") == c.get("afterContent"):
            shifted += 1
            continue
        kept.append({k: c.get(k) for k in (
            "changeType", "entityType", "entityName", "oldEntityName", "filePath",
            "oldFilePath", "startLine", "endLine", "oldStartLine", "oldEndLine",
            "structuralChange")})
    return {"changes": kept, "shifted_dropped": shifted}


def run_lizard(before, after):
    exe = shutil.which("lizard")
    if not exe:
        return None
    sides = {}
    for name, d in (("before", before), ("after", after)):
        p = subprocess.run([exe, "--csv", "--no-gitignore", str(d)],
                           capture_output=True, text=True)
        funcs = Counter()
        rows = {}
        for row in csv.reader(io.StringIO(p.stdout)):
            if len(row) < 11:
                continue
            nloc, ccn, path, long_name = int(row[0]), int(row[1]), row[6], row[8]
            rel = os.path.relpath(path, d)
            key = (rel, long_name)
            funcs[key] += 1
            if funcs[key] > 1:
                key = (rel, f"{long_name}#{funcs[key]}")
            rows[key] = {"ccn": ccn, "nloc": nloc}
        sides[name] = rows
    b, a = sides["before"], sides["after"]
    changes = []
    for key in set(b) | set(a):
        ob, oa = b.get(key), a.get(key)
        if ob and oa and ob == oa:
            continue
        changes.append({"path": key[0], "function": key[1],
                        "ccn_before": ob and ob["ccn"], "ccn_after": oa and oa["ccn"],
                        "nloc_before": ob and ob["nloc"], "nloc_after": oa and oa["nloc"]})
    return {"ccn_before": sum(v["ccn"] for v in b.values()),
            "ccn_after": sum(v["ccn"] for v in a.values()),
            "functions_before": len(b), "functions_after": len(a),
            "changes": changes}


# sem's entities for JSON/YAML/Markdown (lemonade #4188: 198 deleted
# properties in one catalog file) drown out the code entities.
NON_CODE_ENTITIES = {"property", "object", "array", "chunk", "heading", "section", "orphan",
                     "module", "key", "table", "element", "document"}


def attach_entities(hunks, sem):
    """Name the innermost changed entity each hunk touches."""
    if not sem or "changes" not in sem:
        return
    by_file = defaultdict(list)
    for c in sem["changes"]:
        if c["entityType"] in ("orphan", "module"):
            continue
        by_file[c["filePath"]].append(c)
    for h in hunks:
        if h["kind"] != "text":
            continue
        best = None
        for c in by_file.get(h["path"], []):
            if c["changeType"] == "deleted":
                lo, hi, s, n = c["oldStartLine"], c["oldEndLine"], h["old_start"], h["old_len"]
            else:
                lo, hi, s, n = c["startLine"], c["endLine"], h["new_start"], h["new_len"]
            if lo is None or hi is None or s > hi or s + max(n, 1) - 1 < lo:
                continue
            if best is None or hi - lo < best[0]:
                best = (hi - lo, c)
        if best:
            c = best[1]
            h["entity"] = f"{c['changeType']} {c['entityType']} {c['entityName']}"


def commits(repo, base, head, pathspec):
    if head == WORKTREE:
        return []
    out = git(repo, "log", "--no-merges", "--format=%x00%h%x09%s", "--numstat",
              f"{base}..{head}", "--", *pathspec)
    res = []
    for block in out.split("\0")[1:]:
        lines = block.strip("\n").split("\n")
        sha, _, subject = lines[0].partition("\t")
        add = rm = 0
        for ln in lines[1:]:
            parts = ln.split("\t")
            if len(parts) == 3 and parts[0] != "-":
                add, rm = add + int(parts[0]), rm + int(parts[1])
        res.append({"sha": sha, "subject": subject, "added": add, "removed": rm})
    return res


# ----------------------------------------------------------------- report

def table(headers, rows, align=None):
    align = align or ["l"] + ["r"] * (len(headers) - 1)
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join("---:" if a == "r" else "---" for a in align) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def pct(n, total):
    return f"{100 * n / total:.0f}%" if total else "-"


def sum_counts(hunks):
    s = Counter()
    for h in hunks:
        s.update(h["counts"])
    return s


def group_rows(hunks, key, total, limit=None):
    groups = defaultdict(list)
    for h in hunks:
        groups[key(h)].append(h)
    rows = []
    for k, hs in groups.items():
        c = sum_counts(hs)
        churn = c["added"] + c["removed"]
        rows.append((churn, [k, len({h["path"] for h in hs}), f"+{c['added']}",
                             f"-{c['removed']}", c["added"] - c["removed"], pct(churn, total),
                             c["added_moved"] + c["removed_moved"], c["ws_only"],
                             c["added_comment"] + c["removed_comment"],
                             c["added_blank"] + c["removed_blank"]]))
    rows.sort(key=lambda r: -r[0])
    rows = [r for _, r in rows]
    return rows[:limit] if limit else rows


GROUP_HEADERS = ["", "files", "added", "removed", "net", "churn", "moved", "ws-only pairs",
                 "comment", "blank"]


def render_collect(meta, hunks, files, cl, sem, lz, cms, depth):
    c = sum_counts(hunks)
    total = c["added"] + c["removed"]
    st = Counter(f["status"] for f in files)
    out = [f"# Change breakdown: {meta['label']}", ""]
    out.append(f"{len(files)} files ({', '.join(f'{v} {k}' for k, v in sorted(st.items()))}), "
               f"{sum(1 for h in hunks if h['kind'] == 'text')} hunks, "
               f"**+{c['added']} / -{c['removed']}** (net {c['added'] - c['removed']:+}, "
               f"churn {total}).")
    binaries = sum(1 for f in files if f["binary"])
    if binaries:
        out.append(f"{binaries} binary files are listed but not counted.")
    out.append(f"Moved lines (git --color-moved): {c['added_moved']} added, "
               f"{c['removed_moved']} removed. Whitespace-only edits: {c['ws_only']} line pairs.")
    out.append("Comment/blank columns use a line-prefix heuristic; the cloc table is exact.")
    out += ["", "## By category", "",
            table(["category"] + GROUP_HEADERS[1:], group_rows(hunks, lambda h: h["category"], total))]
    out += ["", "## By language", "",
            table(["language"] + GROUP_HEADERS[1:], group_rows(hunks, lambda h: h["language"], total))]
    out += ["", f"## By directory (depth {depth})", "",
            table(["directory"] + GROUP_HEADERS[1:],
                  group_rows(hunks, lambda h: "/".join(h["path"].split("/")[:-1][:depth]) or ".",
                             total, limit=25))]
    rows = []
    for f in files:
        fc = sum_counts([h for h in hunks if h["path"] == f["path"]])
        name = f["path"] if f["status"] not in "RC" else f"{f['old']} → {f['path']}"
        rows.append((fc["added"] + fc["removed"],
                     [name, f["status"] + ("?" if f.get("untracked") else ""), f["category"],
                      f"+{fc['added']}", f"-{fc['removed']}", len(f["hunk_ids"]),
                      f"{f['hunk_ids'][0]}–{f['hunk_ids'][-1]}" if len(f["hunk_ids"]) > 1
                      else f["hunk_ids"][0]]))
    rows.sort(key=lambda r: -r[0])
    out += ["", f"## Files ({len(rows)}, by churn)", "",
            table(["file", "status", "category", "added", "removed", "hunks", "ids"],
                  [r for _, r in rows], align=["l", "l", "l", "r", "r", "r", "l"])]

    if cl is None:
        out += ["", "_cloc not installed: no exact code/comment/blank split._"]
    elif "error" in cl:
        out += ["", f"_cloc failed: {cl['error']}_"]
    else:
        rows = []
        for lang, r in sorted(cl["languages"].items(), key=lambda kv: -sum(kv[1].values())):
            if not any(r.values()):
                continue
            rows.append([lang] + [r.get(f"{k}_{t}", 0) for k in ("added", "modified", "removed")
                                  for t in ("code", "comment", "blank")])
        out += ["", "## cloc: code / comment / blank", "",
                "cloc pairs similar lines as *modified*, so its added/removed are smaller "
                "than git's.", "",
                table(["language", "+code", "+comment", "+blank", "~code", "~comment", "~blank",
                       "-code", "-comment", "-blank"], rows)]

    if sem is None:
        out += ["", "_sem not installed: no entity-level changes._"]
    elif "error" in sem:
        out += ["", f"_sem failed: {sem['error']}_"]
    else:
        code = [x for x in sem["changes"] if x["entityType"] not in NON_CODE_ENTITIES]
        other = Counter(x["changeType"] for x in sem["changes"]
                        if x["entityType"] in NON_CODE_ENTITIES)
        kinds = Counter((x["changeType"], x["entityType"]) for x in code)
        cosmetic = [x for x in code if x["structuralChange"] is False]
        out += ["", "## sem: changed code entities", "",
                table(["change", "entity", "count"],
                      [[a, b, n] for (a, b), n in kinds.most_common()],
                      align=["l", "l", "r"]) if kinds else "None.",
                "", f"Whitespace/comment-only: {len(cosmetic)}. "
                    f"Dropped {sem['shifted_dropped']} 'moved' entities that only shifted lines. "
                    f"Data/doc entities (JSON keys, headings…): "
                    f"{', '.join(f'{n} {k}' for k, n in other.most_common()) or 'none'}."]
        notable = [x for x in code if x["changeType"] in ("moved", "renamed")]
        for x in notable[:20]:
            out.append(f"- {x['changeType']} {x['entityType']} "
                       f"{x.get('oldEntityName') or x['entityName']} "
                       f"({x.get('oldFilePath') or x['filePath']}) → {x['entityName']} "
                       f"({x['filePath']})")

    if lz is None:
        out += ["", "_lizard not installed: no complexity delta._"]
    else:
        ch = lz["changes"]
        added = [x for x in ch if x["ccn_before"] is None]
        removed = [x for x in ch if x["ccn_after"] is None]
        changed = [x for x in ch if x["ccn_before"] is not None and x["ccn_after"] is not None]
        out += ["", "## lizard: cyclomatic complexity (changed files only)", "",
                f"Total CCN {lz['ccn_before']} → {lz['ccn_after']} "
                f"({lz['ccn_after'] - lz['ccn_before']:+}); functions {lz['functions_before']} → "
                f"{lz['functions_after']}. {len(added)} added, {len(removed)} removed, "
                f"{len(changed)} changed."]
        top = sorted(ch, key=lambda x: -((x["ccn_after"] or 0) - (x["ccn_before"] or 0)))[:10]
        top = [x for x in top if (x["ccn_after"] or 0) - (x["ccn_before"] or 0) > 0]
        if top:
            out += ["", table(["function", "file", "CCN before", "CCN after", "NLOC after"],
                              [[x["function"][:70], x["path"], x["ccn_before"] or "new",
                                x["ccn_after"], x["nloc_after"]] for x in top],
                              align=["l", "l", "r", "r", "r"])]
    if cms:
        out += ["", f"## Commits ({len(cms)})", "",
                table(["sha", "subject", "added", "removed"],
                      [[x["sha"], x["subject"][:80], f"+{x['added']}", f"-{x['removed']}"]
                       for x in cms[:40]], align=["l", "l", "r", "r"])]
    out += ["", f"Hunks with content: `{meta['out']}/hunks.txt`. "
                f"Write labels to `{meta['out']}/labels.json`, then run tally."]
    return "\n".join(out) + "\n"


def write_hunks_txt(path, hunks, max_lines):
    with open(path, "w") as fh:
        for h in hunks:
            c = h["counts"]
            head = f"=== {h['id']}  {h['path']}  [{h['category']}]"
            if h["kind"] != "text":
                fh.write(f"{head}  ({h['kind']}{' from ' + h['old_path'] if h['kind'] == 'rename' else ''})\n\n")
                continue
            head += f"  @@ -{h['old_start']} +{h['new_start']} @@ {h['func']}  " \
                    f"[+{c.get('added', 0)} -{c.get('removed', 0)}]"
            if h.get("entity"):
                head += f"  sem: {h['entity']}"
            fh.write(head + "\n")
            lines = h["lines"]
            limit = 15 if h["category"] in ("generated", "vendored") else max_lines
            for ln in lines[:limit]:
                fh.write(ln + "\n")
            if len(lines) > limit:
                fh.write(f"... {len(lines) - limit} more lines\n")
            fh.write("\n")


# --------------------------------------------------------------- commands

def cmd_collect(a):
    repo = git(".", "rev-parse", "--show-toplevel").strip()
    head = a.head
    base = a.base
    if head != WORKTREE:
        git(repo, "rev-parse", "--verify", f"{head}^{{commit}}")
    if a.merge_base:
        base = git(repo, "merge-base", base, "HEAD" if head == WORKTREE else head).strip()
    git(repo, "rev-parse", "--verify", f"{base}^{{commit}}")
    # git runs from the top level, so make cwd-relative paths top-relative.
    a.pathspec = [p if p.startswith(":") else os.path.relpath(os.path.abspath(p), repo)
                  for p in a.pathspec]
    skip = set(filter(None, a.skip.split(",")))
    out = Path(a.out or Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
               / "loc-breakdown" / time.strftime("%Y%m%d-%H%M%S"))
    out.mkdir(parents=True, exist_ok=True)

    files = parse_diff(git(repo, *diff_args(base, head, a.pathspec, a.context), color=True))
    if head == WORKTREE and not a.no_untracked:
        files += untracked_diffs(repo, untracked(repo, a.pathspec))
    attrs = gitattrs(repo, [f["new"] if f["status"] != "D" else f["old"] for f in files])
    hunks = build_hunks(files, attrs)

    before, after = materialize(repo, base, head, files, out)
    cl = None if "cloc" in skip else run_cloc(before, after)
    sem = None if "sem" in skip else run_sem(repo, base, head, a.pathspec)
    lz = None if "lizard" in skip else run_lizard(before, after)
    attach_entities(hunks, sem)
    cms = commits(repo, base, head, a.pathspec)

    label = f"{base[:12]}..{'working tree' if head == WORKTREE else head}"
    meta = {"repo": repo, "base": base, "head": head, "label": label, "out": str(out),
            "pathspec": a.pathspec}
    (out / "hunks.json").write_text(json.dumps(
        {"meta": meta, "hunks": [{k: v for k, v in h.items() if k != "lines"} for h in hunks]},
        indent=1))
    (out / "tools.json").write_text(json.dumps({"cloc": cl, "sem": sem, "lizard": lz,
                                                "commits": cms}, indent=1))
    write_hunks_txt(out / "hunks.txt", hunks, a.max_lines)
    report = render_collect(meta, hunks, files, cl, sem, lz, cms, a.depth)
    (out / "report.md").write_text(report)
    sys.stdout.write(report)


def resolve_labels(hunks, labels):
    """hunk id > exact path > the longest (most specific) matching glob."""
    assign = labels.get("assign", labels)
    ids = {h["id"] for h in hunks}
    unknown = [k for k in assign if re.fullmatch(r"h\d+", k) and k not in ids]
    globs = sorted(((k, v) for k, v in assign.items() if not re.fullmatch(r"h\d+", k)),
                   key=lambda kv: -len(kv[0]))
    res, missing = {}, []
    for h in hunks:
        p = assign.get(h["id"]) or assign.get(h["path"])
        if p is None:
            p = next((v for k, v in globs if fnmatch.fnmatch(h["path"], k)), None)
        if p is None:
            missing.append(h)
        else:
            res[h["id"]] = p
    return res, missing, unknown


def cmd_tally(a):
    d = Path(a.dir)
    data = json.loads((d / "hunks.json").read_text())
    labels = json.loads(Path(a.labels or d / "labels.json").read_text())
    hunks = data["hunks"]
    res, missing, unknown = resolve_labels(hunks, labels)
    if unknown:
        sys.exit(f"labels name hunks that don't exist: {', '.join(unknown)}")
    if missing and not a.allow_unlabeled:
        lines = [f"  {h['id']} {h['path']} +{h['counts'].get('added', 0)} "
                 f"-{h['counts'].get('removed', 0)}" for h in missing[:50]]
        sys.exit(f"{len(missing)} hunks have no label:\n" + "\n".join(lines))
    for h in missing:
        res[h["id"]] = "(unlabeled)"
    for h in hunks:
        h["purpose"] = res[h["id"]]
    c = sum_counts(hunks)
    total = c["added"] + c["removed"]
    desc = labels.get("purposes", {})
    out = [f"# Breakdown by purpose: {data['meta']['label']}", ""]
    rows = group_rows(hunks, lambda h: h["purpose"], total)
    out.append(table(["purpose", "files", "added", "removed", "net", "churn", "moved",
                      "ws-only pairs", "comment", "blank"], rows))
    cats = [k for k in CATEGORIES if any(h["category"] == k for h in hunks)]
    mrows = []
    for r in rows:
        p = r[0]
        cells = []
        for k in cats:
            cc = sum_counts([h for h in hunks if h["purpose"] == p and h["category"] == k])
            cells.append(f"+{cc['added']}/-{cc['removed']}" if cc["added"] or cc["removed"] else "")
        mrows.append([p] + cells)
    out += ["", "## Purpose × category (added/removed)", "",
            table(["purpose"] + cats, mrows, align=["l"] + ["r"] * len(cats))]
    if desc:
        out += ["", "## Purposes", ""] + [f"- **{k}**: {v}" for k, v in desc.items()]
    out.append("")
    out.append(f"Total +{c['added']} / -{c['removed']} across {len(hunks)} hunks; "
               f"every hunk is counted exactly once.")
    text = "\n".join(out) + "\n"
    (d / "tally.md").write_text(text)
    sys.stdout.write(text)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect", help="count a diff and write hunks for labeling")
    c.add_argument("--base", default="HEAD", help="base revision (default HEAD)")
    c.add_argument("--head", default=WORKTREE,
                   help=f"head revision, or {WORKTREE} for the working tree (default)")
    c.add_argument("--merge-base", action="store_true",
                   help="diff from merge-base(base, head), like base...head")
    c.add_argument("--out", help="output directory (default ~/.cache/loc-breakdown/<time>)")
    c.add_argument("--depth", type=int, default=3, help="directory depth for grouping")
    c.add_argument("--context", type=int, default=3,
                   help="context lines; fewer splits a long hunk that mixes purposes")
    c.add_argument("--max-lines", type=int, default=200,
                   help="lines of each hunk to write to hunks.txt")
    c.add_argument("--no-untracked", action="store_true",
                   help="ignore untracked files in working-tree mode")
    c.add_argument("--skip", default="", help="comma list of tools to skip: cloc,sem,lizard")
    c.add_argument("pathspec", nargs="*", help="limit to these paths (after --)")
    c.set_defaults(fn=cmd_collect)
    t = sub.add_parser("tally", help="sum counts per purpose from labels.json")
    t.add_argument("dir", help="directory written by collect")
    t.add_argument("--labels", help="labels file (default <dir>/labels.json)")
    t.add_argument("--allow-unlabeled", action="store_true")
    t.set_defaults(fn=cmd_tally)
    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
