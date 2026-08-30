// Command registration hub.
//
// `registerCommands` composes every command group and wires the
// `gitBranches.*` IDs to their handlers. Each group lives in its own module
// under `commands/`; this file just instantiates the shared registration helper
// and delegates to the group registrars. It also registers the history
// WebviewViewProvider and the commit-file virtual document provider.

import * as vscode from 'vscode';
import type { BranchItem, BranchesProvider } from '../branchTreeProvider';
import { GitApi } from '../gitApi';
import { CommitFileContentProvider, COMMIT_FILE_SCHEME } from '../history/commitFileProvider';
import { errText, setRefresh } from '../shared/ui';
import { registerBranches } from './branches';
import { registerTags } from './tags';
import { registerGlobal } from './global';
import { HistoryViewProvider, HISTORY_VIEW_TYPE, registerHistoryView } from '../history/historyView';

export function registerCommands(
    context: vscode.ExtensionContext,
    gitApi: GitApi,
    refresh: () => Promise<void>,
    branchesProvider: BranchesProvider,
): void {
    setRefresh(refresh);

    const reg: (id: string, fn: (item?: BranchItem) => Promise<void>) => void =
        (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (item?) => {
            try {
                await fn(item);
            } catch (e: any) {
                // Surface a failed git operation exactly once and swallow it here,
                // so VS Code doesn't add a second generic "command failed" toast.
                vscode.window.showErrorMessage(errText(e));
            }
        }));

    // Virtual document provider for viewing commit-file contents.
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            COMMIT_FILE_SCHEME,
            new CommitFileContentProvider()
        )
    );

    // Create the docked Git History WebviewView provider once and share the
    // instance with the branch commands so a branch pull can re-scope it.
    const historyView = new HistoryViewProvider(context, gitApi);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(HISTORY_VIEW_TYPE, historyView, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );

    // Each registration group is isolated so a throw in one (e.g. a bad command
    // ID or handler wiring) doesn't abort the rest of the command setup — the
    // extension would otherwise fail to register later commands silently.
    const groupErrors: string[] = [];
    for (const [name, fn] of [
        ['branches', () => registerBranches({ context, gitApi, branchesProvider, historyView, reg })],
        ['tags', () => registerTags({ context, gitApi, reg })],
        ['global', () => registerGlobal({ context, gitApi, branchesProvider, reg })],
        ['historyView', () => registerHistoryView(context, historyView, gitApi)],
    ] as const) {
        try {
            fn();
        } catch (e: any) {
            groupErrors.push(`${name}: ${e?.message ?? e}`);
        }
    }
    if (groupErrors.length > 0) {
        vscode.window.showErrorMessage('Git Branches: some commands failed to register — ' + groupErrors.join('; '));
    }
}
