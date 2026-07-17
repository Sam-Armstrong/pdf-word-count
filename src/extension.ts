import * as vscode from 'vscode';
import * as path from 'path';

type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;

type PdfStats = {
    wordCount: number;
    charCount: number;
    charCountExcludingSpaces: number;
};

const IGNORE_PUNCTUATION_KEY = 'pdfWordCount.ignorePunctuation';
const PUNCTUATION_PATTERN = /\p{P}/gu;
const PUNCTUATION_ONLY_PATTERN = /^[\p{P}]+$/u;


/* Helper functions */

/**
 * Counts the number of characters in a string, optionally excluding punctuation.
 */
function countCharacters(text: string, ignorePunctuation: boolean): number {
    return (ignorePunctuation ? stripPunctuation(text) : text).length;
}

/**
 * Counts the number of characters in a string, excluding whitespace and optionally punctuation.
 */
function countCharactersExcludingSpaces(text: string, ignorePunctuation: boolean): number {
    const prepared = ignorePunctuation ? stripPunctuation(text) : text;
    return prepared.replace(/\s/g, '').length;
}

/**
 * Counts the number of whitespace-delimited words in a string.
 * When ignorePunctuation is enabled, tokens that are only punctuation are skipped.
 */
function countWords(text: string, ignorePunctuation: boolean): number {
    return text.split(/\s+/).filter((word: string) => {
        if (word.length === 0) {
            return false;
        }
        if (ignorePunctuation && PUNCTUATION_ONLY_PATTERN.test(word)) {
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
 * Builds a cache key for a PDF URI and punctuation-counting mode.
 */
function getCacheKey(uri: vscode.Uri, ignorePunctuation: boolean): string {
    return `${uri.toString()}|ignorePunct=${ignorePunctuation}`;
}

/**
 * Extracts a PDF filename from a tab label, if present.
 */
function getPdfFileNameFromTabLabel(label: string): string | undefined {
    const match = label.match(/([^\\/:*?"<>|]+\.pdf)\b/i);
    return match?.[1];
}

/**
 * Parses a PDF and returns its word and character counts, optionally ignoring punctuation.
 */
async function getPdfStats(fileUri: vscode.Uri, ignorePunctuation: boolean): Promise<PdfStats> {
    const text = await extractPdfText(fileUri);
    return getPdfStatsFromText(text, ignorePunctuation);
}

/**
 * Derives word and character counts from extracted PDF text.
 */
function getPdfStatsFromText(text: string, ignorePunctuation: boolean): PdfStats {
    return {
        wordCount: countWords(text, ignorePunctuation),
        charCount: countCharacters(text, ignorePunctuation),
        charCountExcludingSpaces: countCharactersExcludingSpaces(text, ignorePunctuation)
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

/**
 * Removes punctuation characters from text.
 */
function stripPunctuation(text: string): string {
    return text.replace(PUNCTUATION_PATTERN, '');
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

    /**
     * Returns whether punctuation should be excluded from word and character counts.
     */
    function getIgnorePunctuation(): boolean {
        return context.globalState.get<boolean>(IGNORE_PUNCTUATION_KEY, true);
    }

    /**
     * Persists the ignore-punctuation setting across editor sessions.
     */
    async function setIgnorePunctuation(value: boolean): Promise<void> {
        await context.globalState.update(IGNORE_PUNCTUATION_KEY, value);
    }

    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.name = 'PDF Word Count';
    statusBarItem.command = 'pdf-word-count.showOptions';
    context.subscriptions.push(statusBarItem);

    /**
     * Builds the hover tooltip shown for the status bar word count.
     */
    function buildStatusBarTooltip(
        fileName: string,
        stats: PdfStats,
        ignorePunctuation: boolean
    ): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.isTrusted = true;

        const modeLabel = ignorePunctuation ? 'punctuation excluded' : 'punctuation included';
        tooltip.appendMarkdown(`**${fileName}**\n\n`);
        tooltip.appendMarkdown(`${stats.wordCount.toLocaleString()} words (${modeLabel})\n\n`);
        tooltip.appendMarkdown(`${stats.charCount.toLocaleString()} characters\n\n`);
        tooltip.appendMarkdown(
            `${stats.charCountExcludingSpaces.toLocaleString()} characters excluding spaces\n\n`
        );
        tooltip.appendMarkdown('---\n\n');
        tooltip.appendMarkdown(
            `$(${ignorePunctuation ? 'check' : 'circle-outline'}) Ignore punctuation — **${ignorePunctuation ? 'On' : 'Off'}**\n\n`
        );
        tooltip.appendMarkdown('Click to toggle punctuation counting');
        return tooltip;
    }

    /**
     * Updates the status bar text and tooltip for a completed word count.
     */
    function renderStatusBar(
        fileName: string,
        stats: PdfStats,
        ignorePunctuation: boolean
    ): void {
        const punctSuffix = ignorePunctuation ? ' · no punct' : '';
        statusBarItem.text = `$(file-pdf) PDF: ${stats.wordCount.toLocaleString()} words${punctSuffix}`;
        statusBarItem.tooltip = buildStatusBarTooltip(fileName, stats, ignorePunctuation);
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

        const ignorePunctuation = getIgnorePunctuation();
        const cacheKey = getCacheKey(pdfUri, ignorePunctuation);
        const fileName = path.basename(pdfUri.fsPath);
        const sequence = ++updateSequence;

        statusBarItem.text = '$(file-pdf) PDF: Counting...';
        statusBarItem.tooltip = `Counting words in ${fileName}`;
        statusBarItem.show();

        if (pdfStatsCache.has(cacheKey)) {
            renderStatusBar(fileName, pdfStatsCache.get(cacheKey)!, ignorePunctuation);
            return;
        }

        try {
            const stats = await getPdfStats(pdfUri, ignorePunctuation);
            if (sequence !== updateSequence) {
                return;
            }

            pdfStatsCache.set(cacheKey, stats);
            renderStatusBar(fileName, stats, ignorePunctuation);
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

    const showOptionsCommand = vscode.commands.registerCommand(
        'pdf-word-count.showOptions',
        async () => {
            const ignorePunctuation = getIgnorePunctuation();
            type StatusBarOption = vscode.QuickPickItem & { action: 'toggle' | 'recount' };
            const selection = await vscode.window.showQuickPick<StatusBarOption>(
                [
                    {
                        label: `$(${ignorePunctuation ? 'check' : 'circle-outline'}) Ignore punctuation`,
                        description: ignorePunctuation ? 'Currently on' : 'Currently off',
                        detail: 'Exclude punctuation-only words and punctuation from character counts',
                        picked: ignorePunctuation,
                        action: 'toggle'
                    },
                    {
                        label: '$(refresh) Recount words',
                        description: 'Refresh the word count for the active PDF',
                        action: 'recount'
                    }
                ],
                {
                    title: 'PDF Word Count Options',
                    placeHolder: 'Choose a counting option'
                }
            );

            if (!selection) {
                return;
            }

            if (selection.action === 'toggle') {
                const nextValue = !ignorePunctuation;
                await setIgnorePunctuation(nextValue);
                pdfStatsCache.clear();
                await updateStatusBar();
                return;
            }

            if (selection.action === 'recount') {
                pdfStatsCache.clear();
                await updateStatusBar();
            }
        }
    );

    const toggleIgnorePunctuationCommand = vscode.commands.registerCommand(
        'pdf-word-count.toggleIgnorePunctuation',
        async () => {
            await setIgnorePunctuation(!getIgnorePunctuation());
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

                const ignorePunctuation = getIgnorePunctuation();
                const stats = await getPdfStats(fileUri, ignorePunctuation);
                pdfStatsCache.set(getCacheKey(fileUri, ignorePunctuation), stats);

                const fileName = path.basename(fileUri.fsPath);
                const modeLabel = ignorePunctuation ? 'excluding punctuation' : 'including punctuation';
                vscode.window.showInformationMessage(
                    `"${fileName}" contains ${stats.wordCount.toLocaleString()} words (${modeLabel}).`
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
        for (const key of pdfStatsCache.keys()) {
            if (key.startsWith(uri.toString())) {
                pdfStatsCache.delete(key);
            }
        }
    });
    pdfWatcher.onDidDelete((uri) => {
        for (const key of pdfStatsCache.keys()) {
            if (key.startsWith(uri.toString())) {
                pdfStatsCache.delete(key);
            }
        }
    });

    context.subscriptions.push(
        showOptionsCommand,
        toggleIgnorePunctuationCommand,
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
