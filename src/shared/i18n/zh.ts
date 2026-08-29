export default {
    'branch.noUpstream': '{0} 尚未配置上游分支，请先设置上游。',
    'repo.noRemotes': '未配置任何远程仓库。',
    'branch.current': '当前',

    // Commit context menu
    'menu.copyHash': '复制哈希',
    'menu.copyShortHash': '复制短哈希',
    'menu.copySubject': '复制提交说明',
    'menu.checkout': '检出此提交',
    'menu.createBranch': '从此处创建分支…',
    'menu.cherryPick': '挑选此提交 (cherry-pick)',
    'menu.revert': '还原此提交',
    'menu.compareWorktree': '与工作区文件对比',
    'menu.compareParent': '与上一个提交对比（提交 vs 父提交）',
    'menu.resetSoft': '重置（软）到此提交',
    'menu.resetHard': '重置（硬）到此提交',
    'menu.resetCurrentBranchOnly': '（仅当前分支）',
    'menu.exportPatch': '导出补丁…',
    'menu.openInBrowser': '在浏览器中打开提交',

    // Multi-select context menu
    'menu.exportOnePatch': '导出为单个补丁…',
    'menu.copyHashes': '复制哈希列表',

    // File context menu
    'menu.getFile': '获取左侧旧版本',
    'menu.getFileOne': '获取左侧旧版本',
    'menu.getFiles': '获取选中的 {0} 个左侧旧版本（覆盖本地）',
    'menu.getFileOverwrite': '获取左侧旧版本（覆盖本地）',
    'menu.openFile': '打开文件',

    // Toolbar / table
    'toolbar.title': '历史 ·',
    'toolbar.branchTitle': '选择要显示历史的分支',
    'toolbar.fileChipTitle': '按路径过滤的历史：{0}',
    'toolbar.fileChipClear': '显示整个分支历史',
    'toolbar.fileChipClearAria': '清除文件过滤',
    'toolbar.searchPlaceholder': '过滤：提交说明 / 作者 / 哈希',
    'toolbar.filesChanged': '改动文件',
    'toolbar.exportPatchTitle': '导出所选提交的补丁',
    'toolbar.exportPatch': '导出补丁',
    'toolbar.viewDiff': '全部打开',
    'toolbar.allScope': '-- 全部 --',
    'toolbar.pathChip': '路径',
    'table.hash': '哈希',
    'table.message': '提交说明',
    'table.author': '作者',
    'table.date': '日期',
    'table.refs': '引用',
    'loadMore.end': '— 历史结束（共 {0} 条）—',

    // Dynamic states
    'state.loading': '加载中…',
    'info.rangeDiff': ' 个提交已选中 — 最旧与最新之间的差异',
    'info.vsWorktree': '↔ 工作区',

    'empty.selectCommit': '选择一个提交以查看其改动文件。',
    'empty.noFiles': '没有任何文件改动。',
    'empty.noBranch': '尚未选择分支。',
    'empty.rightClickHint': '在「Git 分支」视图中右键点击分支，选择「查看历史」即可在此渲染提交图。',
    'btn.loadMore': '加载更多（已加载 {0} 条）',
    'btn.loadMoreRetry': '加载更多 — 重试（错误：{0}）',
    'diff.compareWorktreeFailed': '与工作区文件对比失败：{0}',
};
