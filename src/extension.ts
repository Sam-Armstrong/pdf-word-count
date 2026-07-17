import * as vscode from 'vscode';
import * as path from 'path';

type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;

type PdfStats = {
    wordCount: number;
    charCount: number;
    charCountExcludingSpaces: number;
};

const PUNCTUATION_ONLY_PATTERN = /^[\p{P}]+$/u;


/* Helper functions */

/**
 * Counts the number of characters in a string, including punctuation.
 */
function countCharacters(text: string): number {
    return text.length;
}

/**
 * Counts the number of characters in a string, excluding whitespace.
 */
function countCharactersExcludingSpaces(text: string): number {
    return text.replace(/\s/g, '').length;
}

/**
 * Counts the number of whitespace-delimited words in a string.
 * Tokens that are only punctuation are skipped.
 */
function countWords(text: string): number {
    return text.split(/\s+/).filter((word: string) => {
        if (word.length === 0) {
            return false;
        }
        if (PUNCTUATION_ONLY_PATTERN.test(word)) {
            return false;
        }
        return true;
    }).length;
}

/**
 * Reads a PDF file and returns its extracted text content.
 */
async function extractPdfText(fileUri: vscode.Uri): Promise<string> {
    const pdf = require('pdf-parse') as PdfParseFn;
    const fileData = await vscode.workspace.fs.readFile(fileUri);
    const pdfData = await pdf(Buffer.from(fileData));
    return pdfData.text || '';
}

/**
 * Returns the URI of the PDF that should currently drive the status bar.
 */
async function getActivePdfUri(): Promise<vscode.Uri | undefined> {
    for (const group of vscode.window.tabGroups.all) {
        const candidateTabs = [
            group.activeTab,
            ...group.tabs.filter((tab) => tab.isActive)
        ].filter((tab): tab is vscode.Tab => tab !== undefined);

        for (const tab of candidateTabs) {
            const uri = await getPdfUriFromTab(tab);
            if (uri) {
                return uri;
            }
        }
    }

    const pdfUris: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const uri = await getPdfUriFromTab(tab);
            if (uri) {
                pdfUris.push(uri);
            }
        }
    }

    if (pdfUris.length === 1) {
        return pdfUris[0];
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
function getPdfFileNameFromTabLabel(label: string): string | undefined {
    const match = label.match(/([^\\/:*?"<>|]+\.pdf)\b/i);
    return match?.[1];
}

/**
 * Parses a PDF and returns its word and character counts.
 */
async function getPdfStats(fileUri: vscode.Uri): Promise<PdfStats> {
    const text = await extractPdfText(fileUri);
    return getPdfStatsFromText(text);
}

/**
 * Derives word and character counts from extracted PDF text.
 */
function getPdfStatsFromText(text: string): PdfStats {
    return {
        wordCount: countWords(text),
        charCount: countCharacters(text),
        charCountExcludingSpaces: countCharactersExcludingSpaces(text)
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
function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
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
function isPdfUri(uri: vscode.Uri): boolean {
    return uri.fsPath.toLowerCase().endsWith('.pdf');
}

/**
 * Resolves a PDF URI from a tab label using workspace paths and search.
 */
async function resolvePdfUriFromTabLabel(label: string): Promise<vscode.Uri | undefined> {
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
    const pdfStatsCache = new Map<string, PdfStats>();
    let updateSequence = 0;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
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
    function buildStatusBarTooltip(fileName: string, stats: PdfStats): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.isTrusted = true;

        tooltip.appendMarkdown(`**${fileName}**\n\n`);
        tooltip.appendMarkdown(`${stats.wordCount.toLocaleString()} words\n\n`);
        tooltip.appendMarkdown(`${stats.charCount.toLocaleString()} characters\n\n`);
        tooltip.appendMarkdown(
            `${stats.charCountExcludingSpaces.toLocaleString()} characters excluding spaces\n\n`
        );
        return tooltip;
    }

    /**
     * Updates the status bar text and tooltip for a completed word count.
     */
    function renderStatusBar(fileName: string, stats: PdfStats): void {
        statusBarItem.text = `$(file-pdf) ${stats.wordCount.toLocaleString()} words`;
        statusBarItem.tooltip = buildStatusBarTooltip(fileName, stats);
    }

    /**
     * Refreshes the status bar for the active PDF, using the cache when possible.
     */
    async function updateStatusBar(): Promise<void> {
        const pdfUri = await getActivePdfUri();
        if (!pdfUri) {
            statusBarItem.hide();
            return;
        }

        const cacheKey = pdfUri.toString();
        const fileName = path.basename(pdfUri.fsPath);
        const sequence = ++updateSequence;

        statusBarItem.text = '$(file-pdf) PDF: Counting...';
        statusBarItem.tooltip = `Counting words in ${fileName}`;
        statusBarItem.show();

        if (pdfStatsCache.has(cacheKey)) {
            renderStatusBar(fileName, pdfStatsCache.get(cacheKey)!);
            return;
        }

        try {
            const stats = await getPdfStats(pdfUri);
            if (sequence !== updateSequence) {
                return;
            }

            pdfStatsCache.set(cacheKey, stats);
            renderStatusBar(fileName, stats);
        } catch (err) {
            if (sequence !== updateSequence) {
                return;
            }

            statusBarItem.text = '$(file-pdf) PDF: Count failed';
            statusBarItem.tooltip = `Failed to count words in ${fileName}: ${err}`;
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
        async () => {
            pdfStatsCache.clear();
            await updateStatusBar();
        }
    );

    const countWordsCommand = vscode.commands.registerCommand(
        'pdf-word-count.countWords',
        async (uri?: vscode.Uri) => {
            let fileUri = uri ?? await getActivePdfUri();

            if (!fileUri) {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'PDF Documents': ['pdf'] }
                });
                if (uris && uris.length > 0) {
                    fileUri = uris[0];
                } else {
                    return;
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
                    await updateStatusBar();
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to parse PDF: ${err}`);
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
