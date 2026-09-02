// Git execution helpers and the diff "data layer".
//
// This module is the foundation of the commands feature set: it wraps the git
// binary, parses `git diff`-style output into typed records, and exposes a few
// small read-only queries (changed files, commit diff). Everything
// here has no dependency on the rest of the command modules.

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { Ref, Repository } from '../gitApi';

export const execFileAsync = promisify(execFile);

/** Resolve the git binary path from the `git.path` setting, falling back to `git`. */
export function getGitPath(): string {
    return vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
}

/**
 * Run a git command in `repo`. The built-in git extension watches each
 * repository (HEAD/index/refs) and fires `state.onDidChange` when our CLI
 * changes land, so our tree providers re-render automatically — we deliberately
 * do NOT invoke the global `git.refresh` command here, because in a multi-repo
 * workspace it pops a "Select repository" QuickPick.
 */
export async function runGit(repo: Repository, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const cwd = repo.rootUri.fsPath;
    return execFileAsync(getGitPath(), args, { cwd });
}

/** Split a remote-tracking ref name into its `{ remote, branch }` components. */
export function parseRemoteBranch(repo: Repository, ref: Ref): { remote: string; branch: string } {
    const fullName = ref.name ?? '';

    // ref.remote is the authoritative remote name set by the git extension
    if (ref.remote) {
        const branch = fullName.startsWith(ref.remote + '/')
            ? fullName.slice(ref.remote.length + 1)
            : fullName;
        return { remote: ref.remote, branch };
    }

    // Match against known remotes sorted longest-first (handles remotes with slashes)
    const remotes = [...repo.state.remotes].sort((a, b) => b.name.length - a.name.length);
    for (const r of remotes) {
        if (fullName.startsWith(r.name + '/')) {
            return { remote: r.name, branch: fullName.slice(r.name.length + 1) };
        }
    }

    // Split on first slash
    const idx = fullName.indexOf('/');
    if (idx !== -1) {
        return { remote: fullName.slice(0, idx), branch: fullName.slice(idx + 1) };
    }

    // Last resort: use first configured remote
    const firstRemote = repo.state.remotes[0]?.name ?? 'origin';
    return { remote: firstRemote, branch: fullName };
}

/**
 * Resolve a branch's configured upstream to its `{ remote, branch }` parts via
 * `git rev-parse --abbrev-ref <name>@{upstream}` (which yields "remote/remoteBranch").
 * Returns `undefined` when the branch has no upstream. Remotes with slashes are
 * matched longest-first so a remote like `github/user` splits correctly.
 */
export async function getBranchUpstream(repo: Repository, name: string): Promise<{ remote: string; branch: string } | undefined> {
    let upstream: string;
    try {
        const { stdout } = await execFileAsync(
            getGitPath(),
            ['rev-parse', '--abbrev-ref', `${name}@{upstream}`],
            { cwd: repo.rootUri.fsPath }
        );
        upstream = stdout.trim();
    } catch {
        return undefined;
    }
    const remotes = [...repo.state.remotes].sort((a, b) => b.name.length - a.name.length);
    for (const r of remotes) {
        if (upstream.startsWith(r.name + '/')) {
            return { remote: r.name, branch: upstream.slice(r.name.length + 1) };
        }
    }
    const idx = upstream.indexOf('/');
    return idx === -1
        ? { remote: upstream, branch: '' }
        : { remote: upstream.slice(0, idx), branch: upstream.slice(idx + 1) };
}

// Empty tree SHA — used as the "parent" when a commit has none (root commit).
// Diffing against this gives the full content of the commit's tree.
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Max buffer for git commands that may emit large output (file contents, diffs). */
export const SHOW_MAX_BUFFER = 64 * 1024 * 1024;

export interface ChangedFile {
    status: string; // 'A' | 'M' | 'D' | 'R' | 'C' | 'T' (single letter from git)
    path: string;   // new path (or only path for non-renames)
    oldPath?: string; // original path for renames/copies
}

/** Parse `git diff --name-status` / `git diff-tree --name-status` output. */
export function parseNameStatusOutput(stdout: string): ChangedFile[] {
    const out: ChangedFile[] = [];
    for (const line of stdout.split('\n')) {
        if (!line) { continue; }
        const parts = line.split('\t');
        const rawStatus = parts[0] ?? '';
        const status = rawStatus[0] ?? '';
        if (status === 'R' || status === 'C') {
            out.push({ status, oldPath: parts[1] ?? '', path: parts[2] ?? '' });
        } else {
            out.push({ status, path: parts[1] ?? '' });
        }
    }
    return out;
}

/** Files changed by a single commit (vs. its first parent, or the empty tree). */
export async function getChangedFiles(repo: Repository, hash: string, parent: string | undefined, filePath?: string): Promise<ChangedFile[]> {
    const left = parent && parent.length > 0 ? parent : EMPTY_TREE_SHA;
    const args = ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', left, hash];
    if (filePath) { args.push('--', filePath); }
    const { stdout } = await execFileAsync(getGitPath(), args, { cwd: repo.rootUri.fsPath, maxBuffer: SHOW_MAX_BUFFER });
    return parseNameStatusOutput(stdout);
}

/** Files differing between two arbitrary refs (used for range comparison: cmd+click in history). */
export async function getChangedFilesBetween(repo: Repository, leftRef: string, rightRef: string, filePath?: string): Promise<ChangedFile[]> {
    const args = ['diff', '--name-status', '-r', '-M', leftRef, rightRef];
    if (filePath) { args.push('--', filePath); }
    const { stdout } = await execFileAsync(getGitPath(), args, { cwd: repo.rootUri.fsPath, maxBuffer: SHOW_MAX_BUFFER });
    return parseNameStatusOutput(stdout);
}

/**
 * Files that differ between `hash` and the current working tree (unstaged
 * changes). Used by the history view's "Compare with working tree" action so
 * the bottom file panel lists the actual working-tree comparison, not the
 * commit's own changes vs. its parent.
 */
export async function getChangedFilesVsWorktree(repo: Repository, hash: string, filePath?: string): Promise<ChangedFile[]> {
    const args = ['diff', '--name-status', '-M', hash];
    if (filePath) { args.push('--', filePath); }
    const { stdout } = await execFileAsync(getGitPath(), args, { cwd: repo.rootUri.fsPath, maxBuffer: SHOW_MAX_BUFFER });
    // Use git's own status perspective verbatim so the list matches the working
    // tree:'A' = added to the working tree, 'D' = deleted from it, 'M' = modified.
    return parseNameStatusOutput(stdout);
}

/**
 * Overwrite a single working-tree file with its content at `hash`
 * (single-file `git checkout <hash> -- <path>`). Used by the history view's
 * "GET" context action to pull a file's version from a chosen commit (e.g. a
 * remote branch's commit) and overwrite the local working-tree copy.
 */
export async function getFileFromCommit(repo: Repository, hash: string, filePath: string): Promise<{ stdout: string; stderr: string }> {
    return runGit(repo, ['checkout', hash, '--', filePath]);
}

export interface CompareHunk {
    leftStart: number;
    leftCount: number;
    rightStart: number;
    rightCount: number;
    lines: { type: ' ' | '-' | '+'; text: string }[];
}

export interface CompareFile {
    status: string;   // single-letter git status
    path: string;     // new path (right side / working tree)
    oldPath?: string;
    binary: boolean;
    hunks: CompareHunk[];
}

/** Parse a full unified diff (`git diff -M -U3 <left>`) into per-file hunk lists. */
export function parseUnifiedDiff(stdout: string): Map<string, CompareFile> {
    const files = new Map<string, CompareFile>();
    const lines = stdout.split('\n');
    let current: CompareFile | null = null;
    let currentHunk: CompareHunk | null = null;

    const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

    // (Re)open a file as the current one so following hunks attach to it. An
    // empty path or "/dev/null" (added/deleted file) leaves the current file
    // unchanged, which the caller keeps using.
    function openFile(p: string): void {
        if (!p || p === '/dev/null') { return; }
        const existing = files.get(p);
        current = existing ?? { status: 'M', path: p, binary: false, hunks: [] };
        if (!existing) { files.set(p, current); }
        currentHunk = null;
    }

    for (const raw of lines) {
        if (raw.startsWith('diff --git')) {
            // Reset; actual path comes from the `+++ ` line or rename-to.
            current = null;
            currentHunk = null;
            continue;
        }
        if (raw.startsWith('rename from ') || raw.startsWith('rename to ')) {
            // Rename: git omits `---`/`+++` for pure renames, so set up `current`
            // here so any following hunks are captured. oldPath/path are filled in
            // as we see each rename line.
            const p = raw.slice(raw.indexOf(' ', 7) + 1).trim();
            if (!current) {
                current = { status: 'R', path: p, oldPath: p, binary: false, hunks: [] };
                files.set(p, current);
                currentHunk = null;
            } else if (raw.startsWith('rename from ')) {
                current.oldPath = p;
            } else {
                current.path = p;
            }
            continue;
        }
        if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
            // Parse the file path ("--- a/…" / "+++ b/…", or "/dev/null" for
            // added/deleted files) and (re)open it as the current file.
            const prefix = raw.startsWith('--- ') ? '--- a/' : '+++ b/';
            openFile(raw.startsWith(prefix) ? raw.slice(prefix.length) : '');
            continue;
        }
        if (raw.startsWith('Binary files')) {
            if (current) { current.binary = true; }
            continue;
        }
        if (raw.startsWith('\\ No newline')) { continue; }
        if (raw.startsWith('index ') || raw.startsWith('similarity ') || raw.startsWith('dissimilarity ') || raw.startsWith('old mode') || raw.startsWith('new mode') || raw.startsWith('deleted file') || raw.startsWith('new file')) {
            continue;
        }

        const hm = raw.match(hunkRe);
        if (hm && current) {
            const leftStart = parseInt(hm[1], 10);
            const leftCount = hm[2] !== undefined ? parseInt(hm[2], 10) : 1;
            const rightStart = parseInt(hm[3], 10);
            const rightCount = hm[4] !== undefined ? parseInt(hm[4], 10) : 1;
            currentHunk = { leftStart, leftCount, rightStart, rightCount, lines: [] };
            current.hunks.push(currentHunk);
            continue;
        }

        if (currentHunk) {
            const t = raw.charAt(0);
            if (t === '-' || t === '+' || t === ' ') {
                currentHunk.lines.push({ type: t as ' ' | '-' | '+', text: raw.slice(1) });
            }
        }
    }

    return files;
}

/**
 * Full side-by-side diff for a single commit (vs. its first parent), showing only
 * the changed hunks. The left side is the parent (old) and the right side is the
 * commit (latest code). When `filePath` is given (file-scoped history) both the
 * diff and the name-status lookup are restricted to that single path.
 */
export async function getCommitDiff(repo: Repository, hash: string, parent: string | undefined, filePath?: string): Promise<CompareFile[]> {
    const left = parent && parent.length > 0 ? parent : EMPTY_TREE_SHA;
    const args = ['diff', '-M', '-U3', left, hash];
    if (filePath) { args.push('--', filePath); }
    const { stdout } = await execFileAsync(getGitPath(), args, { cwd: repo.rootUri.fsPath, maxBuffer: SHOW_MAX_BUFFER });
    const map = parseUnifiedDiff(stdout);
    const nameStatus = await getChangedFiles(repo, hash, parent, filePath);
    return nameStatus.map(cf => {
        const parsed = map.get(cf.path)
            ?? { status: cf.status, path: cf.path, oldPath: cf.oldPath, binary: false, hunks: [] };
        parsed.status = cf.status;
        if (cf.oldPath) { parsed.oldPath = cf.oldPath; }
        return parsed;
    });
}
