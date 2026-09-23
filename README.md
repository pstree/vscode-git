# Git Branches

A VS Code extension that adds dedicated **Branches** and **Tags** panels to the Source Control sidebar, plus a built-in **branch history viewer** with a side-by-side commit graph, file diff, and pagination — inspired by the branch management UI in IntelliJ IDEA.

## Features

![screenshot](images/screenshot.png)

### Branches Panel

Displays local and remote branches in a single tree. The **current branch** is pinned to the top with a star; **remote branches** are grouped under their remote name.

```
▼ BRANCHES
  ▼ Local
      ★ main (current)    ↑2 ↓1
        feature/login     ↑3
        fix/typo
  ▼ Remote
    ▼ origin
        main
```

**Right-click actions** — Local branch: Checkout, Checkout & Rebase onto Current, Update, Merge into Current (merge / squash / no-ff), Rebase onto This Branch, Apply Patch, Push, Set Upstream, Rename, Delete, View History. Remote branch: Checkout (create tracking branch), Update, Delete Remote, View History. Toolbar: Create Branch, Refresh, Show/Hide Repo.

Each branch row has an inline **refresh** icon (pull/update its upstream); a branch that was never pushed shows a `↑ push` button with a `↑ no upstream` note instead.

### Tags Panel

Lists local tags alphabetically with a sync indicator per tag. Tag rows are read straight from `for-each-ref` (not the built-in extension's ref snapshot), so a tag you just created or deleted shows up immediately:

| Indicator | Meaning |
|-----------|---------|
| `✓ pushed` (green) | Exists locally and on remote, same commit |
| `↑ not pushed` (yellow) | Local-only, not yet pushed |
| `⚠ conflict` (red) | Local and remote point to different commits |

**Right-click actions:** Checkout Tag (detached), Checkout to Local Branch, Push Tag, Delete Tag. Toolbar: Create Tag, Refresh.

- **Create Tag** — annotated (`git tag -a -m`) when a message is given, otherwise lightweight. A duplicate name asks whether to overwrite it (`-f`) instead of just failing.
- **Push Tag** — pushes `refs/tags/<name>` to the chosen remote. The remote ref is compared first: when it already points at a different commit — the case git rejects — you are asked whether to force-push and overwrite it.
- **Delete Tag** — asks whether to delete the local tag only or local + remote; the remote option is offered only when the tag actually exists there.

### Ahead / Behind indicator

Local branches with an upstream show their sync status: `↑2` (ahead), `↓3` (behind), `↑1 ↓2` (diverged). The current branch uses live data from VS Code's git state; others update after fetch + refresh.

### History viewer

Open **View History** (right-click a branch, or in the editor / Explorer **Git History** on a file) to open a two-pane webview: a paginated commit table on top and a "files changed" panel at the bottom.

- **Branch dropdown** — switch branch; `-- ALL --` shows the whole repo (`git log --all`). Selecting a file from the file tree scopes the list with a `Path:` chip (click `×` to return).
- **Project chip** — in a multi-repo workspace the `Project:` pill above the list picks which repository to show; click `×` to drop the project filter and merge every repository (`All projects`).
- **Pagination** — loads **200 commits/page** via `git log --skip=N --max-count=200`; per-page loading keeps large repos responsive.
- **Commit graph** — leading lane graph, color-coded per lane, capped at 200px (scrolls if wider). Lane positions persist across pages.
- **Select a commit** → the changed-files pane opens on the right listing its files with status badges (`A` / `M` / `D` / `R`,`C` / `T`). The pane stays collapsed until a commit is picked, and its `×` collapses it again so the commit list uses the full width.
- **Click a file** → native side-by-side diff (left = parent, right = commit); title `path (shortHash)`. Content is served by the custom `gitbranches-show:` scheme via `git show <ref>:<path>`.
- **Range diff** — Cmd/Ctrl-click a second commit row to diff commit A↔B; click again to return.
- **Compare with working tree** — diff a commit against the live editable working file, using the built-in `<<` / `>>` transfer arrows to apply changes.
- **Files Changed toolbar** — **Export Patch** (single commit or A↔B range) saves a `.patch`/`.diff`; **全部打开 (Open All)** opens every changed file as a native diff.
- **Search / filter** — two boxes filter the loaded commits in place: subject / hash, plus a dedicated **author** box whose dropdown enumerates the authors found in the shown repositories; `Esc` clears. `-- ALL --` / multi-branch view for cross-branch file compare.
- **Commit right-click menu** — Copy hash/subject, Checkout, Create branch from here, Cherry-pick, Revert, Compare with working tree, Reset (soft/hard), Export patch, Open in browser; multi-select for "Export as one patch" / "Copy hashes".
- **File right-click menu** — GET 左侧旧版本 (restore the left/old version via `git checkout <hash> -- <path>`), Compare with working tree.
- **Branch column** (last) — one chip per branch pointing at each commit; the checked-out branch (`HEAD -> …`, on the newest commit) is highlighted. Tags and the symbolic `origin/HEAD` entry are omitted. The column is capped at **140px** and shows at most **2 chips plus a `+N` summary** (hover the cell for the full ref list) so a commit's long branch list can't squeeze the message column.
- **Project column** — only in the `All projects` view: each row shows the repository it came from as a badge, in its own column (before the message).
- **Resizable splitter** — the height between table and file panel persists per workspace.

### Multi-repo workspace support

When multiple git repositories are open, branches and tags are grouped under repository nodes. Repos can be **hidden** (right-click a repo node or the toolbar overflow menu, persisted to `workspaceState`) and re-shown via **Show Hidden Repository**. **Show in Git Branches** (Explorer → right-click a folder) opens a folder as a git repo even if VS Code hasn't discovered it — useful for monorepos with nested `.git` directories.

## Requirements

- VS Code `1.85.0` or later
- The built-in **Git** extension enabled
- Git installed and accessible (uses `git.path`)

## Installation

### From VSIX (local build)

```bash
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

## How It Works

This extension delegates git operations to the built-in `vscode.git` extension API (v1) wherever possible (`checkout`, `merge`, `push`, `pull`, `fetch`, `createBranch`, `deleteBranch`, `getBranches`, `getRefs`). Operations the public API doesn't expose — rebase, cherry-pick, rename, delete remote branch, tag manipulation, `--squash` / `--no-ff` merge strategies, `for-each-ref`, `ls-remote`, paged `git log`, `git show` for diff content — run via `child_process.execFile` using the binary at `git.path`.

After each operation the built-in git extension is notified via `git.refresh`. The history viewer is a webview with a custom `TextDocumentContentProvider` (scheme `gitbranches-show:`) that serves commit-time file content via `git show <ref>:<path>`, bypassing the built-in `git:` scheme to avoid edge cases with non-ASCII paths, nested submodule repos, and missing-at-ref lookups.