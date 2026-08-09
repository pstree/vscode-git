// Per-commit actions exposed from the history view's context menu.
//
// `handleCommitAction` dispatches the webview's commit-level commands (copy
// hash/subject, checkout, create branch, cherry-pick, revert, reset soft/hard,
// open in browser). `exportPatches` writes selected commits into a single
// `.patch` file. Both reuse the shared progress/confirm/git helpers.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Repository } from '../gitApi';
import { execFileAsync, getGitPath, runGit } from '../git/gitClient';
import { confirm, triggerRefresh, withProgress } from '../shared/ui';

export async function exportPatches(repo: Repository, hashes: string[]): Promise<void> {
    if (hashes.length === 0) { return; }

    // Webview sends hashes in DOM order (newest first) — export oldest first so
    // the merged patch keeps chronological commit order and `git am` applies cleanly.
    const ordered = [...hashes].reverse();

    // Default file name: single commit -> its short hash; multiple -> range.
    const shortFirst = ordered[0].substring(0, 8);
    const shortLast = ordered[ordered.length - 1].substring(0, 8);
    const defaultName = ordered.length === 1
        ? `${shortFirst}.patch`
        : `${shortFirst}..${shortLast}-${ordered.length}-commits.patch`;

    const target = await vscode.window.showSaveDialog({
        saveLabel: 'Export patch',
        title: `Export ${ordered.length} commit(s) into one patch`,
        defaultUri: vscode.Uri.joinPath(repo.rootUri, defaultName),
        filters: { 'Patch files': ['patch'], 'All files': ['*'] },
    });
    if (!target) { return; }
    const outFile = target.fsPath;

    await withProgress(`Exporting ${ordered.length} commit(s) into one patch...`, async () => {
        const parts: string[] = [];
        // Generate each commit's patch separately (works for non-contiguous
        // selections too) and concatenate into a single file.
        for (const h of ordered) {
            const { stdout } = await execFileAsync(
                getGitPath(),
                ['format-patch', '-1', '--stdout', h],
                { cwd: repo.rootUri.fsPath, maxBuffer: 64 * 1024 * 1024 }
            );
            parts.push(stdout.trimEnd());
        }
        await fs.promises.writeFile(outFile, parts.join('\n\n') + '\n', 'utf8');

        const choice = await vscode.window.showInformationMessage(
            `Exported ${ordered.length} commit(s) into ${path.basename(outFile)}`,
            'Open File', 'Reveal'
        );
        if (choice === 'Open File') {
            await vscode.window.showTextDocument(vscode.Uri.file(outFile));
        } else if (choice === 'Reveal') {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outFile));
        }
    });
}

/**
 * Export the diff between a commit and the live working tree (unstaged changes)
 * as a single `.patch` file — the same comparison surfaced in the history
 * view's "Compare with working tree" mode.
 */
export async function exportWorktreePatch(repo: Repository, hash: string): Promise<void> {
    const shortHash = hash.substring(0, 8);
    const target = await vscode.window.showSaveDialog({
        saveLabel: 'Export patch',
        title: `Export working-tree diff vs ${shortHash} into one patch`,
        defaultUri: vscode.Uri.joinPath(repo.rootUri, `${shortHash}-worktree.patch`),
        filters: { 'Patch files': ['patch'], 'All files': ['*'] },
    });
    if (!target) { return; }
    const outFile = target.fsPath;

    await withProgress(`Exporting working-tree diff vs ${shortHash}...`, async () => {
        const { stdout } = await execFileAsync(
            getGitPath(),
            ['diff', hash],
            { cwd: repo.rootUri.fsPath, maxBuffer: 64 * 1024 * 1024 }
        );
        await fs.promises.writeFile(outFile, stdout, 'utf8');

        const choice = await vscode.window.showInformationMessage(
            `Exported working-tree diff vs ${shortHash} into ${path.basename(outFile)}`,
            'Open File', 'Reveal'
        );
        if (choice === 'Open File') {
            await vscode.window.showTextDocument(vscode.Uri.file(outFile));
        } else if (choice === 'Reveal') {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outFile));
        }
    });
}

export async function handleCommitAction(repo: Repository, msg: any): Promise<void> {
    const hash = String(msg.hash ?? '');
    if (!hash) { return; }
    const shortHash = hash.substring(0, 8);
    const subject = String(msg.subject ?? '');

    switch (msg.action) {
        case 'copyHash':
            await vscode.env.clipboard.writeText(hash);
            vscode.window.showInformationMessage(`Copied: ${hash}`);
            return;
        case 'copyShortHash':
            await vscode.env.clipboard.writeText(shortHash);
            vscode.window.showInformationMessage(`Copied: ${shortHash}`);
            return;
        case 'copySubject':
            await vscode.env.clipboard.writeText(subject);
            vscode.window.showInformationMessage('Copied commit subject.');
            return;
        case 'checkout': {
            const ok = await confirm(`Checkout ${shortHash}? This puts the repo in detached HEAD.`, 'Checkout');
            if (!ok) { return; }
            await withProgress(`Checking out ${shortHash}...`, () => repo.checkout(hash));
            vscode.window.showInformationMessage(`Checked out ${shortHash} (detached HEAD).`);
            return;
        }
        case 'createBranch': {
            const name = await vscode.window.showInputBox({
                prompt: `New branch name (from ${shortHash})`,
                validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
            });
            if (!name) { return; }
            await withProgress(`Creating branch ${name.trim()}...`, () => repo.createBranch(name.trim(), true, hash));
            vscode.window.showInformationMessage(`Created branch ${name.trim()} at ${shortHash}.`);
            return;
        }
        case 'cherryPick': {
            await withProgress(`Cherry-picking ${shortHash}...`, () => runGit(repo, ['cherry-pick', hash]));
            await triggerRefresh();
            vscode.window.showInformationMessage(`Cherry-picked ${shortHash} onto current branch.`);
            return;
        }
        case 'revert': {
            await withProgress(`Reverting ${shortHash}...`, () => runGit(repo, ['revert', '--no-edit', hash]));
            await triggerRefresh();
            vscode.window.showInformationMessage(`Reverted ${shortHash} (a new commit was created).`);
            return;
        }
        case 'resetSoft': {
            await withProgress(`Resetting (soft) to ${shortHash}...`, () => runGit(repo, ['reset', '--soft', hash]));
            await triggerRefresh();
            return;
        }
        case 'resetHard': {
            await withProgress(`Resetting (hard) to ${shortHash}...`, () => runGit(repo, ['reset', '--hard', hash]));
            await triggerRefresh();
            return;
        }
        case 'openInBrowser': {
            const url = await transformRemoteToWebCommitUrl(repo, hash);
            if (!url) {
                vscode.window.showInformationMessage('No web URL could be derived from this repo’s remote.');
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(url));
            return;
        }
    }
}

/** Derive a browsable commit URL (GitHub/GitLab/Bitbucket) from the repo's remote. */
async function transformRemoteToWebCommitUrl(repo: Repository, hash: string): Promise<string | undefined> {
    try {
        const remoteName = repo.state.remotes.find(r => r.name === 'origin')?.name ?? repo.state.remotes[0]?.name;
        if (!remoteName) { return undefined; }
        const { stdout } = await execFileAsync(getGitPath(), ['remote', 'get-url', remoteName], { cwd: repo.rootUri.fsPath });
        let url = stdout.trim();
        const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
        if (sshMatch) {
            url = `https://${sshMatch[1]}/${sshMatch[2]}`;
        } else if (url.startsWith('ssh://')) {
            url = url.replace(/^ssh:\/\/(?:[^@]+@)?/, 'https://');
        }
        if (url.endsWith('.git')) { url = url.slice(0, -4); }
        if (/bitbucket\.org/.test(url)) { return `${url}/commits/${hash}`; }
        return `${url}/commit/${hash}`;
    } catch {
        return undefined;
    }
}
