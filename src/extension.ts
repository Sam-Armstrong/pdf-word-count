import * as vscode from 'vscode';
import * as path from 'path';
import {
    COUNTING_OPTION_DETAILS,
    COUNTING_OPTION_KEYS,
    CountingOptionKey,
    CountingOptions,
    describeExcludedSections,
    describeStripStatus,
    getPdfStatsForOptions,
    PdfStats
} from './pdfSections';

type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;


/* Helper functions */

/**
 * Extracts the text from a PDF file.
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
 * Builds a cache key for a PDF URI and counting options.
 */
function getCacheKey(uri: vscode.Uri, options: CountingOptions): string {
    return [
        uri.toString(),
        `abs=${options.ignoreAbstract}`,
        `toc=${options.ignoreTableOfContents}`,
        `app=${options.ignoreAppendices}`,
        `refs=${options.ignoreReferences}`
    ].join('|');
}

/**
 * Extracts a PDF filename from a tab label, if present.
 */
function getPdfFileNameFromTabLabel(label: string): string | undefined {
    const match = label.match(/([^\\/:*?"<>|]+\.pdf)\b/i);
    return match?.[1];
}

/**
 * Parses a PDF and returns its word and character counts, optionally excluding sections.
 */
async function getPdfStats(fileUri: vscode.Uri, options: CountingOptions): Promise<PdfStats> {
    return getPdfStatsForOptions(await extractPdfText(fileUri), options);
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

    /**
     * Returns the current section-exclusion settings.
     */
    function getCountingOptions(): CountingOptions {
        return {
            ignoreAbstract: context.globalState.get<boolean>(COUNTING_OPTION_KEYS.ignoreAbstract, false),
            ignoreTableOfContents: context.globalState.get<boolean>(
                COUNTING_OPTION_KEYS.ignoreTableOfContents,
                false
            ),
            ignoreAppendices: context.globalState.get<boolean>(COUNTING_OPTION_KEYS.ignoreAppendices, false),
            ignoreReferences: context.globalState.get<boolean>(COUNTING_OPTION_KEYS.ignoreReferences, false)
        };
    }

    /**
     * Persists a section-exclusion setting across editor sessions.
     */
    async function setCountingOption(key: CountingOptionKey, value: boolean): Promise<void> {
        await context.globalState.update(COUNTING_OPTION_KEYS[key], value);
    }

    /**
     * Toggles a section-exclusion setting and refreshes the status bar.
     */
    async function toggleCountingOption(key: CountingOptionKey): Promise<void> {
        const options = getCountingOptions();
        await setCountingOption(key, !options[key]);
        pdfStatsCache.clear();
        await updateStatusBar();
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
    function buildStatusBarSuffix(options: CountingOptions, stats: PdfStats): string {
        const labels = (Object.keys(COUNTING_OPTION_DETAILS) as CountingOptionKey[])
            .filter((key) => options[key] && stats.stripStatuses[key] === 'stripped')
            .map((key) => COUNTING_OPTION_DETAILS[key].shortLabel);

        return labels.length > 0 ? ` · ${labels.join(' · ')}` : '';
    }

    function buildStatusBarTooltip(
        fileName: string,
        stats: PdfStats,
        options: CountingOptions
    ): vscode.MarkdownString {
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.isTrusted = true;

        tooltip.appendMarkdown(`**${fileName}**\n\n`);
        tooltip.appendMarkdown(
            `${stats.wordCount.toLocaleString()} words (${describeExcludedSections(options, stats.stripStatuses)})\n\n`
        );
        tooltip.appendMarkdown(`${stats.charCount.toLocaleString()} characters\n\n`);
        tooltip.appendMarkdown(
            `${stats.charCountExcludingSpaces.toLocaleString()} characters excluding spaces\n\n`
        );
        tooltip.appendMarkdown('---\n\n');

        for (const key of Object.keys(COUNTING_OPTION_DETAILS) as CountingOptionKey[]) {
            const { label } = COUNTING_OPTION_DETAILS[key];
            const enabled = options[key];
            const stripStatus = stats.stripStatuses[key];
            // when a toggle is on, show whether that section was found and excluded
            const statusSuffix =
                enabled && stripStatus ? ` — ${describeStripStatus(stripStatus)}` : '';
            tooltip.appendMarkdown(
                `$(${enabled ? 'check' : 'circle-outline'}) ${label} — **${enabled ? 'On' : 'Off'}**${statusSuffix}\n\n`
            );
        }

        tooltip.appendMarkdown('Click to change counting options');
        return tooltip;
    }

    /**
     * Updates the status bar text and tooltip for a completed word count.
     */
    function renderStatusBar(
        fileName: string,
        stats: PdfStats,
        options: CountingOptions
    ): void {
        statusBarItem.text = `$(file-pdf) PDF: ${stats.wordCount.toLocaleString()} words${buildStatusBarSuffix(options, stats)}`;
        statusBarItem.tooltip = buildStatusBarTooltip(fileName, stats, options);
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

        const countingOptions = getCountingOptions();
        const cacheKey = getCacheKey(pdfUri, countingOptions);
        const fileName = path.basename(pdfUri.fsPath);
        const sequence = ++updateSequence;

        statusBarItem.text = '$(file-pdf) PDF: Counting...';
        statusBarItem.tooltip = `Counting words in ${fileName}`;
        statusBarItem.show();

        if (pdfStatsCache.has(cacheKey)) {
            renderStatusBar(fileName, pdfStatsCache.get(cacheKey)!, countingOptions);
            return;
        }

        try {
            const stats = await getPdfStats(pdfUri, countingOptions);
            if (sequence !== updateSequence) {
                return;
            }

            pdfStatsCache.set(cacheKey, stats);
            renderStatusBar(fileName, stats, countingOptions);
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
            const countingOptions = getCountingOptions();
            type StatusBarOption = vscode.QuickPickItem & {
                action: 'toggle' | 'recount';
                optionKey?: CountingOptionKey;
            };

            const toggleItems: StatusBarOption[] = (Object.keys(COUNTING_OPTION_DETAILS) as CountingOptionKey[]).map(
                (optionKey) => {
                    const enabled = countingOptions[optionKey];
                    const { label, detail } = COUNTING_OPTION_DETAILS[optionKey];
                    return {
                        label: `$(${enabled ? 'check' : 'circle-outline'}) ${label}`,
                        description: enabled ? 'Currently on' : 'Currently off',
                        detail,
                        picked: enabled,
                        action: 'toggle',
                        optionKey
                    };
                }
            );

            const selection = await vscode.window.showQuickPick<StatusBarOption>(
                [
                    ...toggleItems,
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

            if (selection.action === 'toggle' && selection.optionKey) {
                await toggleCountingOption(selection.optionKey);
                return;
            }

            if (selection.action === 'recount') {
                pdfStatsCache.clear();
                await updateStatusBar();
            }
        }
    );

    const toggleIgnoreReferencesCommand = vscode.commands.registerCommand(
        'pdf-word-count.toggleIgnoreReferences',
        async () => {
            await toggleCountingOption('ignoreReferences');
        }
    );

    const toggleIgnoreAbstractCommand = vscode.commands.registerCommand(
        'pdf-word-count.toggleIgnoreAbstract',
        async () => {
            await toggleCountingOption('ignoreAbstract');
        }
    );

    const toggleIgnoreTableOfContentsCommand = vscode.commands.registerCommand(
        'pdf-word-count.toggleIgnoreTableOfContents',
        async () => {
            await toggleCountingOption('ignoreTableOfContents');
        }
    );

    const toggleIgnoreAppendicesCommand = vscode.commands.registerCommand(
        'pdf-word-count.toggleIgnoreAppendices',
        async () => {
            await toggleCountingOption('ignoreAppendices');
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

                const countingOptions = getCountingOptions();
                const stats = await getPdfStats(fileUri, countingOptions);
                pdfStatsCache.set(getCacheKey(fileUri, countingOptions), stats);

                const fileName = path.basename(fileUri.fsPath);
                vscode.window.showInformationMessage(
                    `"${fileName}" contains ${stats.wordCount.toLocaleString()} words (${describeExcludedSections(countingOptions, stats.stripStatuses)}).`
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
        toggleIgnoreReferencesCommand,
        toggleIgnoreAbstractCommand,
        toggleIgnoreTableOfContentsCommand,
        toggleIgnoreAppendicesCommand,
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
