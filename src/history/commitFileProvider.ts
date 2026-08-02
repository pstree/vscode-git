// Virtual "commit file" documents and native diff openers.
//
// `CommitFileContentProvider` serves the contents of `<ref>:<path>` via a custom
// `gitbranches-show` URI scheme (we resolve it ourselves with `git show` because
// the built-in `git:` scheme is inconsistent for refs that lack the file).
// The openers build left/right URIs and hand them to `vscode.diff`, which opens
// VS Code's native compare editor — that's what makes the built-in
// nextChange/previousChange (and << / >> transfer) shortcuts work.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitApi, Repository } from '../gitApi';
import { EMPTY_TREE_SHA, SHOW_MAX_BUFFER, execFileAsync, getGitPath } from '../git/gitClient';

// Custom scheme so we have full control over content resolution.
// Built-in `git:` scheme's behavior for refs that don't contain the file is
// inconsistent across VS Code versions (sometimes returns empty, sometimes
// "file not found"). We run `git show <ref>:<path>` ourselves and return ''
// on failure so the diff side renders cleanly empty.
export const COMMIT_FILE_SCHEME = 'gitbranches-show';

export class CommitFileContentProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const params = new URLSearchParams(uri.query);
        const repoRoot = params.get('repo') ?? '';
        const filePath = params.get('path') ?? '';
        const ref = params.get('ref') ?? '';
        console.log('[gitBranches] provideTextDocumentContent', { repoRoot, filePath, ref });
        if (!repoRoot || !filePath || !ref) { return ''; }
        try {
            const { stdout } = await execFileAsync(
                getGitPath(),
                ['show', `${ref}:${filePath}`],
                { cwd: repoRoot, maxBuffer: SHOW_MAX_BUFFER }
            );
            return stdout;
        } catch (e: any) {
            console.log('[gitBranches] git show failed for', `${ref}:${filePath}`, e?.message ?? e);
            return ''; // file doesn't exist at this ref → empty side
        }
    }
}

/** Build a `gitbranches-show` URI for `<ref>:<filePath>` in `repoRoot`. */
function buildCommitFileUri(repoRoot: string, filePath: string, ref: string, hash: string): vscode.Uri {
    // Embed the relative path in the URI's path so VS Code picks up the right
    // language for syntax highlighting; ref/repo go in the query.
    const shortHash = ref === EMPTY_TREE_SHA ? '∅' : ref.substring(0, 8);
    const query = new URLSearchParams({ repo: repoRoot, path: filePath, ref }).toString();
    return vscode.Uri.from({
        scheme: COMMIT_FILE_SCHEME,
        path: '/' + filePath,
        query,
        fragment: `${shortHash}|${hash.substring(0, 8)}`,
    });
}

/** Open a native diff between two arbitrary refs for one file (range comparison). */
export async function openRangeFileDiff(
    repo: Repository,
    leftRef: string,
    rightRef: string,
    status: string,
    path: string,
    oldPath?: string,
): Promise<void> {
    const leftPath = (status === 'R' || status === 'C') ? (oldPath ?? path) : path;
    const rightPath = path;
    const repoRoot = repo.rootUri.fsPath;

    // Use rightRef as the "hash" for the URI fragment (it's only display metadata).
    const leftUri = buildCommitFileUri(repoRoot, leftPath, leftRef, rightRef);
    const rightUri = buildCommitFileUri(repoRoot, rightPath, rightRef, rightRef);

    const shortL = leftRef === EMPTY_TREE_SHA ? '∅' : leftRef.substring(0, 8);
    const shortR = rightRef.substring(0, 8);
    const label = (status === 'R' || status === 'C') && oldPath
        ? `${oldPath} → ${path} (${shortL}..${shortR})`
        : `${path} (${shortL}..${shortR})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, label, { preview: true });
}

/** Open a native diff for a single commit's file (vs. its first parent). */
export async function openCommitFileDiff(
    _gitApi: GitApi,
    repo: Repository,
    hash: string,
    parent: string | undefined,
    status: string,
    path: string,
    oldPath?: string,
): Promise<void> {
    const leftRef = parent && parent.length > 0 ? parent : EMPTY_TREE_SHA;
    // For a single-commit view we still want the title to read "(shortHash)" not "(∅..shortHash)",
    // so go through a dedicated label path here while reusing the URI builder.
    const leftPath = (status === 'R' || status === 'C') ? (oldPath ?? path) : path;
    const rightPath = path;
    const repoRoot = repo.rootUri.fsPath;

    const leftUri = buildCommitFileUri(repoRoot, leftPath, leftRef, hash);
    const rightUri = buildCommitFileUri(repoRoot, rightPath, hash, hash);

    const shortHash = hash.substring(0, 8);
    const label = (status === 'R' || status === 'C') && oldPath
        ? `${oldPath} → ${path} (${shortHash})`
        : `${path} (${shortHash})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, label, { preview: true });
}

/**
 * "Compare with Current": left = other-branch version (read-only virtual doc),
 * right = the live working-tree file (editable file:// URI). Because the right
 * side is a real file you can edit it inline and use the built-in << / >>
 * transfer arrows to apply the other branch's changes onto the working tree.
 * If the file is absent locally (deleted in the working tree) the right side
 * falls back to a read-only empty virtual doc so the diff still renders.
 */
export async function openCompareWithWorktree(
    repo: Repository,
    leftRef: string,
    status: string,
    filePath: string,
    oldPath?: string,
): Promise<void> {
    const repoRoot = repo.rootUri.fsPath;
    const leftPath = (status === 'R' || status === 'C') ? (oldPath ?? filePath) : filePath;
    const leftUri = buildCommitFileUri(repoRoot, leftPath, leftRef, leftRef);

    const absRight = path.join(repoRoot, filePath);
    let rightUri: vscode.Uri;
    try {
        await fs.promises.access(absRight);
        rightUri = vscode.Uri.file(absRight);
    } catch {
        rightUri = buildCommitFileUri(repoRoot, filePath, EMPTY_TREE_SHA, leftRef);
    }

    const shortL = leftRef === EMPTY_TREE_SHA ? '∅' : leftRef.substring(0, 8);
    const label = (status === 'R' || status === 'C') && oldPath
        ? `${oldPath} → ${filePath} (${shortL} ↔ working)`
        : `${filePath} (${shortL} ↔ working)`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, label, { preview: true });
}
