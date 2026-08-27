# Git Branches

A VS Code extension that adds dedicated **Branches** and **Tags** panels to the Source Control sidebar, plus a built-in **branch history viewer** with a side-by-side commit graph, file diff, and pagination — inspired by the branch management UI in IntelliJ IDEA.

## Features

![screenshot](images/screenshot.png)

### Branches Panel

Displays local and remote branches together in a single tree, grouped by scope:

```
▼ BRANCHES
  ▼ Local
      ★ main (current)  ↑2 ↓1
        feature/login   ↑3
        fix/typo
  ▼ Remote
    ▼ origin
        main
        feature/login
```

**Current branch** is pinned to the top with a star icon. **Remote branches** are grouped under their remote name.

#### Local branch actions (right-click)

| Action | Description |
|--------|-------------|
| Checkout | Switch to this branch |
| Checkout and Rebase onto Current | Switch to this branch and rebase it onto the (previously) current branch |
| Update | Pull latest changes from upstream (`git pull` for current branch, fast-forward fetch for others) |
| Merge into Current | Merge with strategy picker: **Merge** (commit), **Squash and Merge**, or **No Fast-Forward** — executes directly, no confirmation |
| Rebase onto This Branch | Rebase current branch onto this one |
| Apply Patch | Apply a `.patch` / `.diff` file (or clipboard) to the working tree, or as a commit via `git am` |
| Push | Push to its upstream remote (auto-detected or prompted) |
| Set Upstream | Set the tracking remote branch |
| Rename Branch | Rename in-place |
| Delete Branch | Delete locally (offers force-delete if not fully merged) |
| View History | Open the built-in history viewer (see [History viewer](#history-viewer)) — also triggered by single-clicking the branch row |

**Inline icons:** each local branch row shows an inline refresh button (pull/update its upstream). A branch that has never been pushed shows a `↑` push button instead, plus a `↑ no upstream` note; clicking it pushes and sets the upstream in one step. The refresh icon spins while an operation is in progress.

#### Remote branch actions (right-click)

| Action | Description |
|--------|-------------|
| Checkout (Create Tracking Branch) | Create a local tracking branch |
| Update | Fetch the latest state of this branch |
| Delete Remote Branch | Delete on the remote (offers prune if already gone) |
| View History | Open the built-in history viewer — also triggered by single-clicking the branch row |

#### Local group actions (right-click on "Local")

| Action | Description |
|--------|-------------|
| Create Branch | Create a new branch from current HEAD |

#### Remote group actions (right-click on "Remote" or a remote name)

| Action | Description |
|--------|-------------|
| Fetch All | Fetch all remotes |

### Tags Panel

Lists all local tags alphabetically, with a sync status indicator for each tag:

| Indicator | Meaning |
|-----------|---------|
| (no badge) | Tag exists locally and on remote, pointing at the same commit |
| `↑ not pushed` (yellow) | Local-only tag, not yet pushed to remote |
| `⚠ conflict` (red) | Local and remote point at different commits |

Sync status is fetched in the background after the view opens; remote unreachable means no indicator is shown (rather than treating every tag as unpublished).

#### Tag actions (right-click)

| Action | Description |
|--------|-------------|
| Checkout Tag | Checkout in detached HEAD mode |
| Checkout to Local Branch | Create and checkout a local branch from this tag (prompts for branch name, defaults to the tag name) |
| Push Tag | Push to a remote |
| Delete Tag | Delete locally |

#### Toolbar (Tags panel)

| Button | Description |
|--------|-------------|
| Create Tag | Create a lightweight or annotated tag at current HEAD |
| Refresh | Refresh the tags list |

### Toolbar (Branches panel)

| Button | Description |
|--------|-------------|
| Create Branch | Create a new branch from current HEAD |
| Refresh | Refresh the branches list |
| Show Hidden Repos / Hide Repo | From the `...` (overflow) menu: show a previously hidden repo, or hide the repo whose row you right-click |

In a multi-repo workspace the same toolbar buttons appear on the Tags panel; see [Multi-repo workspace support](#multi-repo-workspace-support).

### Ahead / Behind indicator

Local branches with a configured upstream show a sync status next to their name:

| Indicator | Meaning |
|-----------|---------|
| `↑2` | 2 commits ahead of remote |
| `↓3` | 3 commits behind remote |
| `↑1 ↓2` | Diverged — both sides have unique commits |

The current branch uses live data from VS Code's git state (same source as the status bar). Other branches update after a fetch + refresh.

### History viewer

Selecting **View History** on any branch opens a built-in webview with a two-pane layout: a paginated commit table on top and a "files changed" panel at the bottom.

**Opening file history:** right-click a file in the **editor** or **Explorer** and choose **Git History** to open the viewer scoped to that single file (see [File-scoped history](#file-scoped-history)). The same context menu offers **Stage File** to `git add` the file.

**Compare a commit with the working tree:** right-click any commit in the top list and choose **Compare with working tree**. The changed files load in the bottom panel (the commit row is tagged `↔ 工作区`); clicking any file opens a native diff with the commit's version on the left and your live editable working file on the right — so you can apply the commit's changes onto the working tree using the built-in `<<` / `>>` transfer arrows.

#### Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ History · [ feature/login ▼ ] 🔍 [filter commits...]                   │
├────────────────────────────────────────────────────────────────────────┤
│ Graph  Hash      Refs            Message              Date    Author   │
│  ●     310a3a3   [⎇ HEAD→main]   Add hide/show repo   2d ago  song     │
│  ●     76133a5                   Enhance refs styling 3d ago  song     │
│  ●     9a6da5b                   Add history webview  3d ago  song     │
│  …                                                                     │
│                       [  Load more (200 loaded)  ]                     │
├══════════════════════════════════════════════════════════════════════ │  ← drag splitter
│ FILES CHANGED  76133a5  Enhance reference rendering   [Export][全部打开]  │
├────────────────────────────────────────────────────────────────────────┤
│  [M]  src/                 branchTreeProvider.ts                       │
│  [M]  src/                 commands.ts                                 │
│  [A]  src/                 tagSyncBadge.ts                             │
│  [R]  src/utils/old.ts  →  src/util/renamed.ts                         │
└────────────────────────────────────────────────────────────────────────┘
```

#### Branch dropdown

The branch name after `History ·` is a `<select>` dropdown:

- Defaults to the branch you opened the viewer from
- Lists all local branches alphabetically below
- A `-- ALL --` entry at the bottom shows the entire repo history (equivalent to `git log --all`) — useful for finding commits not on the current branch, locating merge points, or following multiple feature branches in parallel

Switching the dropdown reloads the history from the first page; the file panel resets.

#### File-scoped history

Opening **Git History** from the editor or Explorer (right-click a file → **Git History**) scopes the viewer to that single file:

- The toolbar shows a `Path: <file>` chip; the commit list contains only commits that touched that file
- Click `×` on the chip to return to the full branch history
- **Cross-branch file compare:** switch the branch dropdown to another branch, then click a commit — the bottom panel and the diff now compare the **working-tree file against that commit's (other branch's) version**, instead of the usual commit-vs-parent diff. So you can see exactly how your local file differs from the same file on another branch. Switching back to the original branch restores normal commit-vs-parent behavior.
- **Export Patch in file-scoped history** writes a patch that contains only this file's changes.

#### Pagination

Histories load **200 commits per page**. A `Load more (N loaded)` button at the bottom of the table fetches the next batch via `git log --skip=N --max-count=200`. When you reach the start of history the button is replaced with `— end of history (N commits) —`. Per-page loading keeps very large repos responsive — the first page is usually under a second even for thousands-of-commits histories.

#### Commit graph

The leftmost column is an SVG lane graph showing branch topology, color-coded per lane. It is always rendered as the first column.

When the graph would otherwise exceed 200px of width (many parallel branches), the column itself stays at 200px and the SVG inside scrolls horizontally.

Lane positions are computed incrementally across pages, so loading more commits never re-shuffles the graph for already-rendered rows.

#### Commit selection → files changed

Click any commit row to highlight it. The bottom panel populates with the list of files that commit modified (vs. its first parent), with color-coded status badges:

| Badge | Meaning |
|-------|---------|
| `A` (green) | Added |
| `M` (yellow) | Modified |
| `D` (red) | Deleted |
| `R` / `C` (purple) | Renamed / Copied (shows `old → new`) |
| `T` (grey) | File type changed |

For root commits (no parent), all files are shown as `A` against git's empty tree.

#### Click a file → side-by-side diff

Clicking a file row opens VS Code's native diff editor in a new tab:

- **Left** = file content at the parent commit
- **Right** = file content at the selected commit
- **Added** files show an empty left side; **deleted** files show an empty right side
- **Renamed** files diff old path → new path
- Tab title: `path/to/file (shortHash)`, or `old → new (shortHash)` for renames
- The diff editor honors all VS Code diff settings (`diffEditor.renderSideBySide`, `diffEditor.ignoreTrimWhitespace`, etc.)

Content is served by a custom URI scheme (`gitbranches-show:`) that runs `git show <ref>:<path>` on demand. Files that don't exist at a given ref (added or deleted in this commit) return empty content, so the diff renders cleanly without "file not found" errors.

#### Compare any two commits (range diff)

**Cmd-click** (macOS) / **Ctrl-click** (Windows/Linux) a second commit row to switch the file panel from "this commit vs. parent" to "commit A vs. commit B". The two rows stay highlighted; the file panel shows the cumulative diff. Cmd/Ctrl-click again to return to single-commit mode.

The **Files Changed** title bar has two buttons:

- **Export Patch**: saves the currently selected commit (or, in range mode, the A↔B diff) as a `.patch` / `.diff` file — the same action as the right-click **Export patch…** / **Export as one patch…** items. In file-scoped history the patch only contains the tracked file's changes.
- **全部打开 (Open All)**: opens every changed file as a native VS Code diff editor in its own tab, so you can jump between hunks with `F7` / `Shift+F7`. In working-tree compare mode it opens the commit-vs-worktree diffs instead.

#### Search / filter

A search box in the toolbar filters the loaded commits in place — matches on **subject**, **author**, **short hash**, or **full hash**. Non-matching rows are hidden (lane graph remains intact). Press **Esc** to clear.

Filter operates over the commits already loaded; click `Load more` to extend the searchable set.

#### Right-click menus

**On a commit row:**

| Item | Description |
|------|-------------|
| Copy hash / Copy short hash / Copy subject | Copy to clipboard |
| Checkout this commit | Detached-HEAD checkout at this commit |
| Create branch from here… | Prompts for a name, branches from this commit |
| Cherry-pick | Cherry-pick this commit into current branch |
| Revert | Create a revert commit |
| Compare with working tree | Diff this commit against the live working tree — changed files load in the bottom panel (the row is tagged `↔ 工作区`) and open as editable working-tree diffs |
| Reset (soft) to here | `git reset --soft` (working tree + index kept) — only shown for commits on the current branch |
| Reset (hard) to here | `git reset --hard` — confirms first (discards uncommitted changes); only shown for the current branch |
| Export patch… | Save this commit as a `.patch` / `.diff` file (or copy to clipboard) |
| Open commit in browser | Open the commit page on the remote's web host — auto-detects GitHub, GitLab, Gitee, Bitbucket from the configured `origin` URL |

**Multi-select:** Cmd-click (macOS) / Ctrl-click (Windows/Linux) extra commit rows to select several at once. Right-clicking the selection shows a different menu:

| Item | Description |
|------|-------------|
| Export as one patch… | Combine all selected commits into a single `.patch` / `.diff` file (or copy to clipboard) |
| Copy hashes | Copy the full hashes of every selected commit to the clipboard |

**On a changed file row:**

| Item | Description |
|------|-------------|
| GET 左侧旧版本（覆盖本地） | Restore the file's **left ("before")** version shown in the current diff into the local working tree via `git checkout <hash> -- <path>`, overwriting the current file. Applies to every selected file row. |
| Compare with working tree | Diff this single file's committed version (read-only left) against the live editable working file (right) |

File rows support single-click, Ctrl/Cmd-click to toggle, and Shift-click for a contiguous range — multi-select them, then right-click to GET all at once.

#### Resizable splitter

The horizontal bar between the commit table and the files panel is draggable — pull up to give the files panel more room, pull down to focus on commits. The chosen height is remembered per workspace.

#### Layout persistence

Splitter height persists to `workspaceState`, so opening the history viewer next time uses your last layout.

#### Reference badges in commit rows

The "Refs" column shows pill-shaped badges for any refs pointing at that commit:

- `HEAD` and `HEAD → branch` in teal
- Local branches in green
- Remote-tracking branches in red
- Tags in yellow

Each pill is capped at 110px with ellipsis for long names.

### Multi-repo workspace support

When multiple git repositories are open, branches and tags are grouped under repository nodes:

#### Hide / show repositories

Repositories you don't actively work in can be hidden from the Branches and Tags views to reduce clutter:

| Action | Where | Effect |
|--------|-------|--------|
| **Hide Repository** | Right-click a repo node, or panel toolbar (overflow menu) | Removes it from both panels (per-workspace, persisted in `workspaceState`) |
| **Show Hidden Repository...** | Panel toolbar (overflow menu) | Quick-pick to re-show one of the hidden repos |
| **Show in Git Branches** | File Explorer → right-click a folder | If the folder is a git repo (even one VS Code's git extension hasn't discovered yet), opens it and adds it to the Branches view |

`Show in Git Branches` also makes sub-folder repositories discoverable — useful for monorepos where nested `.git` directories aren't always picked up automatically.

## Requirements

- VS Code `1.85.0` or later
- The built-in **Git** extension must be enabled
- Git installed and accessible (uses the path configured in `git.path`)

## Installation

### From VSIX (local build)

```bash
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension Git-0.0.1.vsix
```

Then reload VS Code (`Developer: Reload Window`).

## Development

```bash
npm install       # install dependencies
npm run compile   # build once (esbuild → out/extension.js)
npm run watch     # build in watch mode
npm run typecheck # tsc --noEmit (esbuild does NOT type-check)
```

Press `F5` in VS Code to launch an Extension Development Host.

## How It Works

This extension delegates git operations to the built-in `vscode.git` extension API (v1) wherever possible (`checkout`, `merge`, `push`, `pull`, `fetch`, `createBranch`, `deleteBranch`, `getBranches`, `getRefs`). Operations not exposed by the public API — rebase, cherry-pick, rename, delete remote branch, tag manipulation, `--squash` / `--no-ff` merge strategies, `for-each-ref`, `ls-remote`, paged `git log`, `git show` for diff content — are executed via `child_process.execFile` using the binary at `git.path`.

After each operation the built-in git extension is notified via `git.refresh` so its internal state stays in sync.

The history viewer is a webview with a custom `TextDocumentContentProvider` (scheme `gitbranches-show:`) that serves commit-time file content directly via `git show <ref>:<path>`, bypassing the built-in `git:` scheme to avoid edge cases with non-ASCII paths, nested submodule repos, and missing-at-ref lookups.
