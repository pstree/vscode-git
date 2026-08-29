// Local + remote branch commands.
//
// Every handler here operates on a `BranchItem` (a tree node) and is wired via
// the shared `reg` helper. Git I/O goes through `../git/gitClient`; user prompts
// through `../shared/ui`.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Branch } from '../gitApi';
import type { RegisterCtx } from './context';
import { confirm, triggerRefresh, withProgress } from '../shared/ui';
import { execFileAsync, getGitPath, parseRemoteBranch, runGit, SHOW_MAX_BUFFER } from '../git/gitClient';

export function registerBranches(ctx: RegisterCtx): void {
    const { reg } = ctx;

    // Inline refresh icon on each branch row: pull (fast-forward) the branch to
    // its upstream so the Git History list — if showing this branch — reflects
    // the newly pulled commits. Remote-tracking refs are refreshed via fetch.
    // No-op placeholder for the spinning inline button shown while a pull is
    // in progress. Clicking it should do nothing.
    reg('gitBranches.fetchBranchSpin', async () => {});

    reg('gitBranches.fetchBranch', async (item?) => {
        if (!item) { return; }
        const name = item.ref.name;
        if (!name) { return; }
        const repo = item.repo;

        // Spin the row's refresh icon while pulling.
        ctx.branchesProvider?.setBranchLoading(repo, name, true);
        try {
            if (item.contextValue === 'remoteBranch') {
                // Remote-tracking ref: "pull" here just refreshes the ref via fetch.
                const { remote, branch } = parseRemoteBranch(repo, item.ref);
                await withProgress(`Pulling ${branch} from ${remote}...`, () =>
                    repo.fetch(remote, branch)
                );
                return;
            }

            // Local branch: pull it to its upstream — `git pull` for the current
            // branch, `git fetch <remote> <remoteBranch>:<name>` (fast-forward) for
            // a non-current branch.
            const isCurrent = repo.state.HEAD?.name === name;
            if (isCurrent) {
                if (!repo.state.HEAD?.upstream) {
                    vscode.window.showErrorMessage(`"${name}" has no upstream configured. Use Set Upstream first.`);
                    return;
                }
                await withProgress(`Pulling ${name}...`, () => repo.pull());
            } else {
                let upstreamRef: string;
                try {
                    const { stdout } = await execFileAsync(
                        getGitPath(),
                        ['rev-parse', '--abbrev-ref', `${name}@{upstream}`],
                        { cwd: repo.rootUri.fsPath }
                    );
                    upstreamRef = stdout.trim();
                } catch {
                    vscode.window.showErrorMessage(`"${name}" has no upstream configured. Use Set Upstream first.`);
                    return;
                }
                const slashIdx = upstreamRef.indexOf('/');
                const remote = upstreamRef.slice(0, slashIdx);
                const remoteBranch = upstreamRef.slice(slashIdx + 1);
                await withProgress(`Pulling ${name}...`, () =>
                    runGit(repo, ['fetch', remote, `${remoteBranch}:${name}`])
                );
            }
        } finally {
            ctx.branchesProvider?.setBranchLoading(repo, name, false);
        }
        // Branch just pulled/updated: if Git History is showing this same branch,
        // reload it so the freshly-pulled commits appear in the list.
        ctx.historyView?.refreshIfMatches(repo, name);
    });

    // Inline push icon (↑) shown for local branches that have no upstream yet:
    // push the branch and set its upstream so pull/reset become available.
    reg('gitBranches.fetchBranchPush', async (item?) => {
        if (!item) { return; }
        const name = item.ref.name;
        if (!name) { return; }
        const repo = item.repo;

        const remotes = repo.state.remotes;
        if (remotes.length === 0) {
            vscode.window.showErrorMessage('No remotes configured.');
            return;
        }
        const remoteName = remotes.find(r => r.name === 'origin')?.name ?? remotes[0].name;

        ctx.branchesProvider?.setBranchLoading(repo, name, true);
        try {
            await withProgress(`Pushing ${name} and setting upstream...`, () =>
                runGit(repo, ['push', '-u', remoteName, name])
            );
        } finally {
            ctx.branchesProvider?.setBranchLoading(repo, name, false);
        }
        // Branch now has an upstream: if Git History is showing this branch,
        // re-enable Reset by reloading the list.
        ctx.historyView?.refreshIfMatches(repo, name);
    });

    reg('gitBranches.update', async (item?) => {
        if (!item) { return; }
        const isCurrent = item.repo.state.HEAD?.name === item.ref.name;

        if (isCurrent) {
            // Current branch: repo.state.HEAD.upstream is always reliable
            if (!item.repo.state.HEAD?.upstream) {
                vscode.window.showErrorMessage(`"${item.ref.name}" has no upstream configured. Use Set Upstream first.`);
                return;
            }
            await withProgress(`Updating ${item.ref.name}...`, () => item.repo.pull());
            return;
        }

        // Non-current branch: getBranches() may not populate upstream in all VS Code versions,
        // so resolve it directly from git as a reliable fallback.
        let upstreamRef: string;
        try {
            const { stdout } = await execFileAsync(
                getGitPath(),
                ['rev-parse', '--abbrev-ref', `${item.ref.name}@{upstream}`],
                { cwd: item.repo.rootUri.fsPath }
            );
            upstreamRef = stdout.trim(); // e.g. "origin/feature-3.0.0"
        } catch {
            vscode.window.showErrorMessage(`"${item.ref.name}" has no upstream configured. Use Set Upstream first.`);
            return;
        }

        const slashIdx = upstreamRef.indexOf('/');
        const remote = upstreamRef.slice(0, slashIdx);
        const remoteBranch = upstreamRef.slice(slashIdx + 1);
        await withProgress(`Updating ${item.ref.name}...`, () =>
            runGit(item.repo, ['fetch', remote, `${remoteBranch}:${item.ref.name}`])
        );
    });

    reg('gitBranches.checkout', async (item?) => {
        if (!item) { return; }
        await withProgress(`Checking out ${item.ref.name}...`, () =>
            item.repo.checkout(item.ref.name!)
        );
    });

    reg('gitBranches.merge', async (item?) => {
        if (!item) { return; }

        const strategies = [
            { label: 'Merge', description: 'Create a merge commit', value: 'merge' as const },
            { label: 'Squash and Merge', description: 'Squash all commits into one staged change', value: 'squash' as const },
            { label: 'No Fast-Forward', description: 'Always create a merge commit (--no-ff)', value: 'no-ff' as const },
        ];
        const strategy = await vscode.window.showQuickPick(strategies, {
            placeHolder: `Merge "${item.ref.name}" into current branch — select strategy`,
        });
        if (!strategy) { return; }

        await withProgress(`Merging ${item.ref.name}...`, async () => {
            if (strategy.value === 'squash') {
                await runGit(item.repo, ['merge', '--squash', item.ref.name!]);
                vscode.window.showInformationMessage(
                    `"${item.ref.name}" squashed and staged. Commit to complete the merge.`
                );
            } else if (strategy.value === 'no-ff') {
                await runGit(item.repo, ['merge', '--no-ff', '--no-edit', item.ref.name!]);
            } else {
                await item.repo.merge(item.ref.name!);
            }
        });
    });

    reg('gitBranches.rebase', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(
            `Rebase current branch onto "${item.ref.name}"? This rewrites history.`,
            'Rebase'
        );
        if (!ok) { return; }
        await withProgress(`Rebasing onto ${item.ref.name}...`, () =>
            runGit(item.repo, ['rebase', item.ref.name!])
        );
    });

    reg('gitBranches.checkoutAndRebase', async (item?) => {
        if (!item) { return; }
        const currentBranch = item.repo.state.HEAD?.name;
        if (!currentBranch) {
            vscode.window.showErrorMessage('No current branch.');
            return;
        }
        const ok = await confirm(
            `Checkout "${item.ref.name}" and rebase it onto "${currentBranch}"? This rewrites history.`,
            'Checkout and Rebase'
        );
        if (!ok) { return; }
        await withProgress(`Rebasing ${item.ref.name} onto ${currentBranch}...`, async () => {
            await item.repo.checkout(item.ref.name!);
            try {
                await runGit(item.repo, ['rebase', currentBranch]);
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    vscode.window.showWarningMessage(
                        'Rebase has conflicts. Resolve them, then run "git rebase --continue". To cancel: "git rebase --abort".'
                    );
                } else {
                    throw e;
                }
            }
        });
    });

    reg('gitBranches.push', async (item?) => {
        if (!item) { return; }
        // Use the branch's configured upstream remote, or ask the user
        let remoteName = (item.ref as Branch).upstream?.remote;
        if (!remoteName) {
            const remotes = item.repo.state.remotes;
            if (remotes.length === 0) {
                vscode.window.showErrorMessage('No remotes configured.');
                return;
            }
            if (remotes.length === 1) {
                remoteName = remotes[0].name;
            } else {
                const picked = await vscode.window.showQuickPick(
                    remotes.map(r => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl })),
                    { placeHolder: 'Select remote to push to' }
                );
                if (!picked) { return; }
                remoteName = picked.label;
            }
        }
        await withProgress(`Pushing ${item.ref.name} to ${remoteName}...`, () =>
            item.repo.push(remoteName, item.ref.name, true)
        );
    });

    reg('gitBranches.setUpstream', async (item?) => {
        if (!item) { return; }
        const remotes = item.repo.state.remotes;
        if (remotes.length === 0) {
            vscode.window.showErrorMessage('No remotes configured.');
            return;
        }
        const pickedRemote = await vscode.window.showQuickPick(
            remotes.map(r => ({ label: r.name, description: r.fetchUrl })),
            { placeHolder: 'Select remote to track' }
        );
        if (!pickedRemote) { return; }
        const remoteBranchName = await vscode.window.showInputBox({
            prompt: `Remote branch name on "${pickedRemote.label}"`,
            value: item.ref.name,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!remoteBranchName) { return; }
        const upstream = `${pickedRemote.label}/${remoteBranchName.trim()}`;
        await withProgress(`Setting upstream to ${upstream}...`, () =>
            runGit(item.repo, ['branch', `--set-upstream-to=${upstream}`, item.ref.name!])
        );
    });

    reg('gitBranches.deleteLocal', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(`Delete local branch "${item.ref.name}"?`, 'Delete');
        if (!ok) { return; }
        // Try a normal delete; on "not fully merged" offer force delete outside the progress toast.
        let notFullyMerged = false;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting branch ${item.ref.name}...` },
            async () => {
                try {
                    await item.repo.deleteBranch(item.ref.name!, false);
                    await triggerRefresh();
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('not fully merged')) {
                        notFullyMerged = true;
                    } else {
                        vscode.window.showErrorMessage(msg.trim());
                    }
                }
            }
        );
        if (notFullyMerged) {
            const force = await confirm(
                `"${item.ref.name}" is not fully merged. Force delete?`,
                'Force Delete'
            );
            if (!force) { return; }
            await withProgress(`Force deleting branch ${item.ref.name}...`, () =>
                item.repo.deleteBranch(item.ref.name!, true)
            );
        }
    });

    // ---- Remote branch commands ----

    reg('gitBranches.checkoutRemote', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const localName = await vscode.window.showInputBox({
            prompt: 'Local branch name',
            value: branch,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!localName) { return; }
        await withProgress(`Checking out ${item.ref.name}...`, () =>
            runGit(item.repo, ['checkout', '-b', localName.trim(), `${remote}/${branch}`])
        );
    });

    reg('gitBranches.pull', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        await withProgress(`Fetching ${branch} from ${remote}...`, () =>
            item.repo.fetch(remote, branch)
        );
    });

    reg('gitBranches.deleteRemote', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const ok = await confirm(
            `Delete remote branch "${branch}" on "${remote}"?`,
            'Delete'
        );
        if (!ok) { return; }
        // If the branch is already gone on the remote, offer to prune the stale tracking ref.
        // The prune dialog must be shown outside withProgress to avoid overlapping UI.
        let alreadyGone = false;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting remote branch ${branch}...` },
            async () => {
                try {
                    await runGit(item.repo, ['push', remote, '--delete', branch]);
                    await triggerRefresh();
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('remote ref does not exist')) {
                        alreadyGone = true;
                    } else {
                        vscode.window.showErrorMessage(msg.trim());
                    }
                }
            }
        );
        if (alreadyGone) {
            const action = await vscode.window.showWarningMessage(
                `"${branch}" no longer exists on "${remote}". Prune stale local tracking ref?`,
                'Prune', 'Cancel'
            );
            if (action === 'Prune') {
                await withProgress(`Pruning ${remote}...`, () =>
                    runGit(item.repo, ['fetch', remote, '--prune'])
                );
            }
        }
    });

    // ---- Cherry-pick ----
    // (cherry-pick is intentionally available only from the Git History view,
    // where the user can browse commits and pick the exact one to apply.)
}
