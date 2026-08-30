// VS Code UI helpers shared across the command modules.
//
// (Pure HTML helpers live in ./html so vscode-free code doesn't import vscode.)

import * as path from 'path';
import * as vscode from 'vscode';
import { Repository } from '../gitApi';

/** Show a QuickPick of open repositories and return the user's choice. */
export async function pickRepo(repos: Repository[]): Promise<Repository | undefined> {
    const picked = await vscode.window.showQuickPick(
        repos.map(r => ({ label: r.rootUri.path.split('/').pop() ?? '', repo: r })),
        { placeHolder: 'Select repository' }
    );
    return picked?.repo;
}

/**
 * Use the lone open repository directly, otherwise ask the user to pick one.
 * Returns `undefined` when there are no repos (callers short-circuit).
 */
export async function pickRepoOrSingle(repos: Repository[]): Promise<Repository | undefined> {
    if (repos.length === 0) { return undefined; }
    return repos.length === 1 ? repos[0] : await pickRepo(repos);
}

/**
 * Find the open repository that contains `uri`. For nested repos the deepest
 * (longest root) match wins. Case-folded to behave on case-insensitive systems.
 */
export function findRepoForFile(repos: Repository[], uri: vscode.Uri): Repository | undefined {
    const file = uri.fsPath.toLowerCase();
    const matches = repos.filter(r => {
        const root = r.rootUri.fsPath.toLowerCase();
        return file === root || file.startsWith(root + path.sep);
    });
    if (matches.length === 0) { return undefined; }
    matches.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    return matches[0];
}

/** Modal yes/no confirmation; returns true only if the user picks `confirmLabel`. */
export async function confirm(message: string, confirmLabel: string): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return result === confirmLabel;
}

/** Normalize an arbitrary thrown value (child-process error, Error, or value) into a one-line message. */
export function errText(e: any): string {
    return String(e.stderr ?? e.message ?? e).trim();
}

// The refresh callback is wired by registerCommands and invoked by `withProgress`
// after each successful git op, so the branches/tags views stay in sync.
let _refresh: (() => Promise<void>) | undefined;

/** Wire the post-operation refresh handler (called once from registerCommands). */
export function setRefresh(refresh: () => Promise<void>): void {
    _refresh = refresh;
}

/** Manually trigger the post-op refresh (for handlers that bypass `withProgress`). */
export function triggerRefresh(): Promise<void> {
    return _refresh ? _refresh() : Promise.resolve();
}

/**
 * Run `fn` under a progress notification. On success it triggers the shared
 * refresh; on failure it surfaces the error's stderr/message. Returns undefined
 * on error so callers can short-circuit. This is the unified place that ties
 * errors, progress UI, and refresh together for git operations.
 */
export async function withProgress<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
        try {
            const result = await fn();
            await _refresh?.();
            return result;
        } catch (e: any) {
            const msg = e.stderr ?? e.message ?? String(e);
            vscode.window.showErrorMessage(String(msg).trim());
            // Re-throw so callers don't continue as if the operation succeeded
            // (e.g. showing a "done" message or reloading a view after a failure).
            throw e;
        }
    });
}
