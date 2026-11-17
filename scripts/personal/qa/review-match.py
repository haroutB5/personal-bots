"""List which REVIEW.md items a git range triggers.

Usage: python3 -I review-match.py <REVIEW.md> <repo> <base> <head>
"""

import re
import subprocess
import sys


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def expand_braces(glob):
    m = re.search(r"\{([^{}]*)\}", glob)
    if not m:
        return [glob]
    return [g for part in m.group(1).split(",") for g in expand_braces(glob[: m.start()] + part + glob[m.end():])]


def glob_to_regex(glob):
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return re.compile(out + r"\Z")


def parse_items(text):
    items = []
    for block in re.split(r"^### ", text, flags=re.M)[1:]:
        head = block.split("\n", 1)[0].split()
        fields = dict(re.findall(r"^- \*\*([a-z-]+):\*\* (.*)$", block, flags=re.M))
        if "trigger" not in fields:
            continue
        globs = re.findall(r"`([^`]+)`", fields["trigger"])
        items.append({
            "id": head[0],
            "name": head[1],
            "include": [glob_to_regex(g) for raw in globs if not raw.startswith("!") for g in expand_braces(raw)],
            "exclude": [glob_to_regex(g) for raw in globs if raw.startswith("!") for g in expand_braces(raw[1:])],
            "added": re.compile(re.findall(r"`([^`]+)`", fields["added-lines"])[0], re.M) if "added-lines" in fields else None,
            "subject": re.compile(re.findall(r"`([^`]+)`", fields["subject"])[0], re.M) if "subject" in fields else None,
        })
    return items


def added_lines(repo, base, head, path):
    diff = git(repo, "diff", "-U0", base, head, "--", path)
    return [line[1:] for line in diff.splitlines() if line.startswith("+") and not line.startswith("+++")]


def main(review, repo, base, head):
    items = parse_items(open(review, encoding="utf8").read())
    files = git(repo, "diff", "--name-only", base, head).split()
    subjects = git(repo, "log", "--format=%s", f"{base}..{head}").splitlines()
    print(f"range {base}..{head}: {len(files)} files, {len(subjects)} commits, {len(items)} items")
    matched = []
    for item in items:
        hits = [f for f in files if any(r.match(f) for r in item["include"]) and not any(r.match(f) for r in item["exclude"])]
        if item["added"]:
            hits = [f for f in hits if any(item["added"].search(line) for line in added_lines(repo, base, head, f))]
        subj = [s for s in subjects if item["subject"] and item["subject"].search(s)]
        if hits or subj:
            matched.append(item["id"])
            why = hits[:4] + ([f"subject: {subj[0]}"] if subj else [])
            more = f" (+{len(hits) - 4} more)" if len(hits) > 4 else ""
            print(f"  {item['id']} {item['name']}: {', '.join(why)}{more}")
    print(f"Matched: {', '.join(matched) or 'none'} ({len(matched)} of {len(items)})")


if __name__ == "__main__":
    main(*sys.argv[1:5])
