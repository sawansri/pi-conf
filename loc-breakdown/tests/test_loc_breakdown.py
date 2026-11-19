"""Builds a throwaway git repo per test; no network, and cloc/sem/lizard are
skipped or faked so results don't depend on what is installed."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import loc_breakdown as lb  # noqa: E402

# The script under test must not see the developer's git config either.
os.environ.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")

BLOCK = "\n".join(f"int helper_{i}(int value) {{ return value * {i} + 12345; }}"
                  for i in range(6)) + "\n"
FILLER = "\n".join(f"int filler_{i}(int value) {{ return value - {i} - 54321; }}"
                   for i in range(10)) + "\n"
KEEP = "int keep() {{\n{}return 1;\n}}\n"
BEFORE_CPP = "// math\n" + BLOCK + FILLER + KEEP.format("  ")
# The helpers move below the (longer) filler, keep() is re-indented, and a
# comment, a blank line and a new function are added.
AFTER_CPP = ("// math\n" + FILLER + BLOCK + KEEP.format("    ")
             + "\n// added\nint fresh(int a) { if (a) return 1; return 0; }\n")


class Repo:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = self.tmp.name
        self.git("init", "-q", "-b", "main")

    def git(self, *args):
        env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t"}
        return subprocess.run(["git", "-C", self.path, *args], env=env, check=True,
                              capture_output=True, text=True).stdout

    def write(self, rel, text):
        p = Path(self.path, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text if isinstance(text, bytes) else text.encode())

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", msg)


def collect(repo, *args):
    out = Path(repo.path, ".lb-out")
    cwd = os.getcwd()
    os.chdir(repo.path)
    try:
        with redirect_stdout(StringIO()) as buf:
            lb.main(["collect", "--out", str(out), "--skip", "cloc,sem,lizard", *args])
    finally:
        os.chdir(cwd)
    return json.loads((out / "hunks.json").read_text()), buf.getvalue(), out


def totals(hunks, **filt):
    t = {"added": 0, "removed": 0}
    for h in hunks:
        if all(h[k] == v for k, v in filt.items()):
            for k in t:
                t[k] += h["counts"].get(k, 0)
    return t


def fixture():
    r = Repo()
    r.write("src/math.cpp", BEFORE_CPP)
    r.write("src/old_name.h", "#pragma once\nint keep();\nint tail();\n")
    r.write("img/logo.png", b"\x89PNG\x00\x01")
    r.write("README.md", "# x\n")
    r.commit("base")
    r.write("src/math.cpp", AFTER_CPP)
    r.git("mv", "src/old_name.h", "src/new_name.h")
    r.write("test/test_math.py", "# check\n\ndef test_keep():\n    assert True\n")
    r.write("src/app/package-lock.json", '{"lockfileVersion": 3}\n')
    r.write("img/logo.png", b"\x89PNG\x00\x02")
    r.write("README.md", "# x\n\nMore.\n")
    r.commit("change")
    return r


class CollectTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo = fixture()
        cls.addClassCleanup(cls.repo.tmp.cleanup)
        cls.data, cls.report, cls.out = collect(cls.repo, "--base", "HEAD~1", "--head", "HEAD")
        cls.hunks = cls.data["hunks"]

    def test_totals_match_git_numstat(self):
        added = removed = 0
        for ln in self.repo.git("diff", "--numstat", "-M", "HEAD~1", "HEAD").splitlines():
            a, r, _ = ln.split("\t", 2)
            if a != "-":
                added, removed = added + int(a), removed + int(r)
        self.assertEqual(totals(self.hunks), {"added": added, "removed": removed})

    def test_moved_block_and_reindent_are_told_apart(self):
        c = {}
        for h in self.hunks:
            if h["path"] == "src/math.cpp":
                for k, v in h["counts"].items():
                    c[k] = c.get(k, 0) + v
        self.assertEqual(c.get("added_moved"), 6)
        self.assertEqual(c.get("removed_moved"), 6)
        self.assertEqual(c.get("ws_only"), 1)  # "return 1;" re-indented
        self.assertEqual(c.get("added_comment"), 1)
        self.assertEqual(c.get("added_blank"), 1)

    def test_every_file_gets_a_hunk_even_without_lines(self):
        kinds = {h["path"]: h["kind"] for h in self.hunks}
        self.assertEqual(kinds["src/new_name.h"], "rename")
        self.assertEqual(kinds["img/logo.png"], "binary")
        old = next(h for h in self.hunks if h["path"] == "src/new_name.h")["old_path"]
        self.assertEqual(old, "src/old_name.h")

    def test_categories(self):
        cats = {h["path"]: h["category"] for h in self.hunks}
        self.assertEqual(cats["test/test_math.py"], "test")
        self.assertEqual(cats["src/app/package-lock.json"], "generated")
        self.assertEqual(cats["README.md"], "docs")
        self.assertEqual(cats["img/logo.png"], "assets")
        self.assertEqual(cats["src/math.cpp"], "src")

    def test_hunks_txt_has_every_id(self):
        text = (self.out / "hunks.txt").read_text()
        for h in self.hunks:
            self.assertIn(f"=== {h['id']} ", text)

    def test_commits_listed(self):
        self.assertIn("| change |", self.report)


class WorktreeTest(unittest.TestCase):
    def test_untracked_and_unstaged_changes_are_counted(self):
        r = fixture()
        self.addCleanup(r.tmp.cleanup)
        r.write("README.md", "# x\n\nMore.\nAnd more.\n")
        r.write("notes/new.md", "a\nb\n")
        data, _, _ = collect(r, "--base", "HEAD")
        self.assertEqual(totals(data["hunks"], path="README.md"), {"added": 1, "removed": 0})
        self.assertEqual(totals(data["hunks"], path="notes/new.md"), {"added": 2, "removed": 0})

    def test_merge_base_ignores_commits_on_base_branch(self):
        r = fixture()
        self.addCleanup(r.tmp.cleanup)
        r.git("checkout", "-q", "-b", "feature")
        r.write("src/feature.cpp", "int f();\n")
        r.commit("feature")
        r.git("checkout", "-q", "main")
        r.write("src/main_only.cpp", "int m();\nint n();\n")
        r.commit("main moves on")
        r.git("checkout", "-q", "feature")
        data, _, _ = collect(r, "--base", "main", "--head", "HEAD", "--merge-base")
        self.assertEqual({h["path"] for h in data["hunks"]}, {"src/feature.cpp"})


class ContextTest(unittest.TestCase):
    def test_less_context_splits_hunks(self):
        r = Repo()
        self.addCleanup(r.tmp.cleanup)
        r.write("cat.json", "".join(f'"k{i}": {i},\n' for i in range(20)))
        r.commit("base")
        r.write("cat.json", "".join(f'"k{i}": {i * (i in (5, 10))},\n' for i in range(20)))
        r.commit("change")
        default, _, _ = collect(r, "--base", "HEAD~1", "--head", "HEAD")
        tight, _, _ = collect(r, "--base", "HEAD~1", "--head", "HEAD", "--context", "0")
        self.assertLess(len(default["hunks"]), len(tight["hunks"]))
        self.assertEqual(totals(default["hunks"]), totals(tight["hunks"]))


class TallyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo = fixture()
        cls.addClassCleanup(cls.repo.tmp.cleanup)
        cls.data, _, cls.out = collect(cls.repo, "--base", "HEAD~1", "--head", "HEAD")

    def tally(self, labels):
        (self.out / "labels.json").write_text(json.dumps(labels))
        with redirect_stdout(StringIO()) as buf:
            lb.main(["tally", str(self.out)])
        return buf.getvalue()

    def test_sums_per_purpose_cover_every_line(self):
        math_ids = [h["id"] for h in self.data["hunks"] if h["path"] == "src/math.cpp"]
        text = self.tally({"assign": {"*": "other", "test/*": "tests", "src/*": "feature",
                                      math_ids[0]: "refactor"}})
        t = totals(self.data["hunks"])
        self.assertIn(f"Total +{t['added']} / -{t['removed']}", text)
        test_t = totals(self.data["hunks"], path="test/test_math.py")
        self.assertRegex(text, rf"\| tests \| 1 \| \+{test_t['added']} \|")
        self.assertIn("| refactor |", text)

    def test_hunk_id_beats_path_beats_glob(self):
        h = self.data["hunks"][0]
        res, _, _ = lb.resolve_labels(self.data["hunks"],
                                      {"*": "glob", h["path"]: "path", h["id"]: "id"})
        self.assertEqual(res[h["id"]], "id")
        res, _, _ = lb.resolve_labels(self.data["hunks"], {"*": "glob", h["path"]: "path"})
        self.assertEqual(res[h["id"]], "path")
        res, _, _ = lb.resolve_labels(self.data["hunks"], {"src/*.cpp": "narrow", "src/*": "wide"})
        self.assertEqual(res[next(x["id"] for x in self.data["hunks"]
                                  if x["path"] == "src/math.cpp")], "narrow")

    def test_unlabeled_hunks_fail(self):
        with self.assertRaises(SystemExit) as cm:
            self.tally({"assign": {"src/*": "feature"}})
        self.assertIn("have no label", str(cm.exception))

    def test_unknown_hunk_id_fails(self):
        with self.assertRaises(SystemExit) as cm:
            self.tally({"assign": {"*": "x", "h999": "y"}})
        self.assertIn("h999", str(cm.exception))


class SemFilterTest(unittest.TestCase):
    def test_shifted_entities_are_not_moves(self):
        payload = {"changes": [
            {"changeType": "moved", "entityType": "function", "entityName": "create",
             "filePath": "a.cpp", "oldFilePath": None, "beforeContent": "x", "afterContent": "x"},
            {"changeType": "moved", "entityType": "function", "entityName": "real",
             "filePath": "b.cpp", "oldFilePath": "a.cpp", "beforeContent": "y",
             "afterContent": "y"},
            {"changeType": "modified", "entityType": "function", "entityName": "load",
             "filePath": "a.cpp", "beforeContent": "1", "afterContent": "2"}]}
        done = subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr="")
        with mock.patch.object(lb.shutil, "which", return_value="sem"), \
                mock.patch.object(lb.subprocess, "run", return_value=done):
            res = lb.run_sem(".", "A", "B", [])
        self.assertEqual(res["shifted_dropped"], 1)
        self.assertEqual([c["entityName"] for c in res["changes"]], ["real", "load"])


class ClassifyTest(unittest.TestCase):
    def test_lemonade_paths(self):
        cases = {
            "src/cpp/server/routes/lemonade/models/pull.cpp": "src",
            "src/cpp/include/lemon/llamacpp_architectures_generated.h": "generated",
            "src/app/src/vendor/model-viewer.min.js": "generated",
            "test/cpp/fake_backend.cpp": "test",
            "test/test_llamacpp_system_backend.py": "test",
            ".github/workflows/validate_llamacpp.yml": "ci",
            "docs/guide/configuration/custom-models.md": "docs",
            "docs/tools/gen_api_boilerplate.py": "src",
            "CMakeLists.txt": "build",
            "contrib/debian/control": "build",
            "src/cpp/resources/server_models.json": "data",
        }
        for path, want in cases.items():
            self.assertEqual(lb.category(path), want, path)

    def test_gitattributes_override(self):
        self.assertEqual(lb.category("src/x.cpp", {"linguist-generated": True}), "generated")


if __name__ == "__main__":
    unittest.main()
