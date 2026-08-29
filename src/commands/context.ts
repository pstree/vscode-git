// Shared shape passed to every command-group registrar.
//
// Keeping it in one place means each `registerXxx` module receives exactly the
// dependencies it needs (the extension context, the git API, and the `reg`
// helper) without re-declaring them.

import * as vscode from 'vscode';
import type { BranchItem, BranchesProvider } from '../branchTreeProvider';
import type { GitApi } from '../gitApi';
import type { HistoryViewProvider } from '../history/historyView';

export interface RegisterCtx {
    context: vscode.ExtensionContext;
    gitApi: GitApi;
    branchesProvider?: BranchesProvider;
    historyView?: HistoryViewProvider;
    reg: (id: string, fn: (item?: BranchItem) => Promise<void>) => void;
}
