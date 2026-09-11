import * as vscode from 'vscode';
import * as path from 'path';
import {
    getPdfStatsFromBuffer,
    type PdfStats,
} from './pdfText';


/* Types */

type StatusBarStats = PdfStats & {
    fileSizeBytes: number;
};

type StatusBarUpdateOptions = {
    isRetry?: boolean;
    force?: boolean;
};


/* Retry policy */

/**
 * Backoff used when a PDF word count fails (e.g. while LaTeX is rewriting the file).
 * Delay for retry n (1-based) is initialDelayMs * backoffFactor ^ (n - 1).
 */
export const WORD_COUNT_RETRY_POLICY = {
    maxRetries: 8,
    initialDelayMs: 2000,
    backoffFactor: 2
};

/**
 * Returns the delay in milliseconds before the given 1-based retry attempt.
 */
export function wordCountRetryDelayMs(retryNumber: number): number {
    return WORD_COUNT_RETRY_POLICY.initialDelayMs
        * (WORD_COUNT_RETRY_POLICY.backoffFactor ** (retryNumber - 1));
}


/* Helper functions */

/**
 * Formats a byte size for display in the status bar tooltip.
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        const kb = bytes / 1024;
        return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }

    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Returns average words per page, rounded to the nearest integer.
 */
export function wordsPerPage(stats: Pick<PdfStats, "wordCount" | "pageCount">): number {
    if (stats.pageCount <= 0) {
        return 0;
    }
    return Math.round(stats.wordCount / stats.pageCount);
}

/**
 * Returns the URI of the PDF that should currently drive the status bar.
 * Only the active tab in the focused tab group counts — background PDF tabs
 * must not keep the status bar visible.
 */
async function getActivePdfUri(): Promise<vscode.Uri | undefined> {
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    const candidateTabs = [
        activeGroup.activeTab,
        ...activeGroup.tabs.filter((tab) => tab.isActive)
    ].filter((tab): tab is vscode.Tab => tab !== undefined);

    for (const tab of candidateTabs) {
        const uri = await getPdfUriFromTab(tab);
        if (uri) {
            return uri;
        }
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && isPdfUri(editor.document.uri)) {
        return editor.document.uri;
    }

    return undefined;
}

/**
 * Extracts a PDF filename from a tab label, if present.
 */
export function getPdfFileNameFromTabLabel(label: string): string | undefined {
    const match = label.match(/([^\\/:*?"<>|]+\.pdf)\b/i);
    return match?.[1];
}

/**
 * Parses a PDF and returns its word, character, page, and file-size stats.
 */
async function getPdfStats(fileUri: vscode.Uri): Promise<StatusBarStats> {
    const fileData = await vscode.workspace.fs.readFile(fileUri);
    const stats = await getPdfStatsFromBuffer(fileData);
    return {
        ...stats,
        fileSizeBytes: fileData.byteLength
    };
}

/**
 * Returns the PDF URI for a tab from its input or label.
 */
async function getPdfUriFromTab(tab: vscode.Tab): Promise<vscode.Uri | undefined> {
    const uri = getTabUri(tab);
    if (uri && isPdfUri(uri)) {
        return uri;
    }

    return resolvePdfUriFromTabLabel(tab.label);
}

/**
 * Returns the file URI represented by a tab, when available.
 */
export function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
    const input = tab.input;

    if (input instanceof vscode.TabInputText) {
        return input.uri;
    }
    if (input instanceof vscode.TabInputCustom) {
        return input.uri;
    }
    if (input instanceof vscode.TabInputTextDiff) {
        return input.modified;
    }

    if (typeof input === 'object' && input !== null && 'uri' in input) {
        const uri = (input as { uri?: vscode.Uri }).uri;
        if (uri && typeof uri.fsPath === 'string') {
            return uri;
        }
    }

    return undefined;
}

/**
 * Returns whether a URI points to a PDF file.
 */
export function isPdfUri(uri: vscode.Uri): boolean {
    return uri.fsPath.toLowerCase().endsWith('.pdf');
}

/**
 * Resolves a PDF URI from a tab label using workspace paths and search.
 */
export async function resolvePdfUriFromTabLabel(label: string): Promise<vscode.Uri | undefined> {
    const fileName = getPdfFileNameFromTabLabel(label);
    if (!fileName) {
        return undefined;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length === 1) {
        const candidate = vscode.Uri.joinPath(workspaceFolders[0].uri, fileName);
        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            // Fall through to workspace search.
        }
    }

    const matches = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 2);
    if (matches.length === 1) {
        return matches[0];
    }

    return undefined;
}


/* Main extension code */

/**
 * Activates the extension and registers commands, listeners, and the status bar.
 */
export function activate(context: vscode.ExtensionContext) {
    const pdfStatsCache = new Map<string, StatusBarStats>();
    let updateSequence = 0;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    let retryUriKey: string | undefined;
    const startupRetryTimers: ReturnType<typeof setTimeout>[] = [];

    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.name = 'PDF Word Count';
    statusBarItem.command = 'pdf-word-count.recount';
    context.subscriptions.push(statusBarItem);

    /**
     * Builds the hover tooltip shown for the status bar word count.
     */
    function buildStatusBarTooltip(fileName: string, stats: StatusBarStats): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.isTrusted = true;

        tooltip.appendMarkdown(`*${fileName}*\n\n`);
        tooltip.appendMarkdown(`---\n\n`);
        tooltip.appendMarkdown(
            [
                "| | |",
                "| --- | ---: |",
                `| File size: | ${formatFileSize(stats.fileSizeBytes)} |`,
                `| Pages: | ${stats.pageCount.toLocaleString()} |`,
                `| Words: | ${stats.wordCount.toLocaleString()} |`,
                `| Characters: | ${stats.charCount.toLocaleString()} |`,
                `| → no spaces: | ${stats.charCountExcludingSpaces.toLocaleString()} |`,
                `| Words per page: | ${wordsPerPage(stats).toLocaleString()} |`,
                ""
            ].join("\n")
        );
        return tooltip;
    }

    /**
     * Updates the status bar text and tooltip for a completed word count.
     */
    function renderStatusBar(fileName: string, stats: StatusBarStats): void {
        statusBarItem.text = `$(file-pdf) ${stats.wordCount.toLocaleString()} words`;
        statusBarItem.tooltip = buildStatusBarTooltip(fileName, stats);
    }

    /**
     * Cancels a pending word-count retry without resetting the attempt counter.
     */
    function cancelWordCountRetry(): void {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
        }
    }

    /**
     * Clears retry state after a successful count, a PDF switch, or teardown.
     */
    function resetWordCountRetry(): void {
        cancelWordCountRetry();
        retryCount = 0;
        retryUriKey = undefined;
    }

    /**
     * Schedules the next word-count retry using exponential backoff, if any remain.
     */
    function scheduleWordCountRetry(cacheKey: string, fileName: string, err: unknown): void {
        if (retryCount >= WORD_COUNT_RETRY_POLICY.maxRetries) {
            statusBarItem.text = '$(file-pdf) PDF: Count failed';
            statusBarItem.tooltip = `Failed to count words in ${fileName}: ${err}`;
            return;
        }

        retryCount += 1;
        retryUriKey = cacheKey;
        const delayMs = wordCountRetryDelayMs(retryCount);

        statusBarItem.text = '$(file-pdf) PDF: Count failed';
        statusBarItem.tooltip =
            `Failed to count words in ${fileName}: ${err}. ` +
            `Retrying in ${delayMs / 1000}s (${retryCount}/${WORD_COUNT_RETRY_POLICY.maxRetries}).`;

        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void updateStatusBar({ isRetry: true });
        }, delayMs);
    }

    /**
     * Refreshes the status bar for the active PDF, using the cache when possible.
     * Returns the stats that were shown, or undefined when there is no active PDF
     * or counting failed (so tests can assert success rather than non-throw).
     */
    async function updateStatusBar(
        options?: StatusBarUpdateOptions
    ): Promise<StatusBarStats | undefined> {
        const pdfUri = await getActivePdfUri();
        if (!pdfUri) {
            resetWordCountRetry();
            statusBarItem.hide();
            return undefined;
        }

        const cacheKey = pdfUri.toString();
        const fileName = path.basename(pdfUri.fsPath);

        if (retryUriKey !== undefined && retryUriKey !== cacheKey) {
            resetWordCountRetry();
        }

        // wait for the scheduled backoff unless this is that retry or a forced recount
        if (
            retryTimer !== undefined &&
            retryUriKey === cacheKey &&
            !options?.isRetry &&
            !options?.force
        ) {
            return undefined;
        }

        if (options?.force) {
            resetWordCountRetry();
        }

        const sequence = ++updateSequence;

        statusBarItem.text = '$(file-pdf) PDF: Counting...';
        statusBarItem.tooltip = `Counting words in ${fileName}`;
        statusBarItem.show();

        if (pdfStatsCache.has(cacheKey)) {
            const cached = pdfStatsCache.get(cacheKey)!;
            resetWordCountRetry();
            renderStatusBar(fileName, cached);
            return cached;
        }

        try {
            const stats = await getPdfStats(pdfUri);
            if (sequence !== updateSequence) {
                return undefined;
            }

            pdfStatsCache.set(cacheKey, stats);
            resetWordCountRetry();
            renderStatusBar(fileName, stats);
            return stats;
        } catch (err) {
            if (sequence !== updateSequence) {
                return undefined;
            }

            scheduleWordCountRetry(cacheKey, fileName, err);
            return undefined;
        }
    }

    /**
     * Debounces status bar refreshes to avoid redundant PDF parsing.
     */
    function requestStatusBarUpdate(delay = 0): void {
        if (updateTimer) {
            clearTimeout(updateTimer);
        }

        updateTimer = setTimeout(() => {
            updateTimer = undefined;
            void updateStatusBar();
        }, delay);
    }

    /**
     * Retries status bar updates during startup while tabs and workspace state settle.
     */
    function scheduleInitialStatusBarUpdates(): void {
        for (const delay of [0, 100, 250, 500, 1000, 2000]) {
            const timer = setTimeout(() => {
                requestStatusBarUpdate();
            }, delay);
            startupRetryTimers.push(timer);
        }
    }

    const recountCommand = vscode.commands.registerCommand(
        'pdf-word-count.recount',
        async (): Promise<StatusBarStats | undefined> => {
            pdfStatsCache.clear();
            return updateStatusBar({ force: true });
        }
    );

    const countWordsCommand = vscode.commands.registerCommand(
        'pdf-word-count.countWords',
        async (uri?: vscode.Uri): Promise<StatusBarStats | undefined> => {
            let fileUri = uri ?? await getActivePdfUri();

            if (!fileUri) {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'PDF Documents': ['pdf'] }
                });
                if (uris && uris.length > 0) {
                    fileUri = uris[0];
                } else {
                    return undefined;
                }
            }

            try {
                vscode.window.showInformationMessage('Parsing PDF...');

                const stats = await getPdfStats(fileUri);
                pdfStatsCache.set(fileUri.toString(), stats);

                const fileName = path.basename(fileUri.fsPath);
                vscode.window.showInformationMessage(
                    `"${fileName}" contains ${stats.wordCount.toLocaleString()} words.`
                );

                if ((await getActivePdfUri())?.toString() === fileUri.toString()) {
                    await updateStatusBar({ force: true });
                }

                return stats;
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to parse PDF: ${err}`);
                return undefined;
            }
        }
    );

    const pdfWatcher = vscode.workspace.createFileSystemWatcher('**/*.pdf');
    pdfWatcher.onDidChange((uri) => {
        pdfStatsCache.delete(uri.toString());
    });
    pdfWatcher.onDidDelete((uri) => {
        pdfStatsCache.delete(uri.toString());
    });

    context.subscriptions.push(
        recountCommand,
        countWordsCommand,
        pdfWatcher,
        vscode.window.onDidChangeActiveTextEditor(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.onDidChangeVisibleTextEditors(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.onDidChangeWindowState(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.tabGroups.onDidChangeTabs(() => {
            requestStatusBarUpdate();
        }),
        vscode.window.tabGroups.onDidChangeTabGroups(() => {
            requestStatusBarUpdate();
        }),
        {
            dispose: () => {
                if (updateTimer) {
                    clearTimeout(updateTimer);
                }
                resetWordCountRetry();
                for (const timer of startupRetryTimers) {
                    clearTimeout(timer);
                }
            }
        }
    );

    scheduleInitialStatusBarUpdates();
}

/**
 * Deactivates the extension.
 */
export function deactivate() {}
