export type PdfStats = {
    wordCount: number;
    charCount: number;
    charCountExcludingSpaces: number;
    stripStatuses: StripStatuses;
};

export type CountingOptions = {
    ignoreAbstract: boolean;
    ignoreTableOfContents: boolean;
    ignoreAppendices: boolean;
    ignoreReferences: boolean;
    ignoreCaptions: boolean;
};

export type CountingOptionKey = keyof CountingOptions;

/** Outcome of attempting to exclude a section when its toggle is on. */
export type SectionStripStatus = 'stripped' | 'notFound' | 'incomplete';

export type StripStatuses = Partial<Record<CountingOptionKey, SectionStripStatus>>;

type StripResult = {
    text: string;
    status: SectionStripStatus;
};

export const COUNTING_OPTION_KEYS: Record<CountingOptionKey, string> = {
    ignoreAbstract: 'pdfWordCount.ignoreAbstract',
    ignoreTableOfContents: 'pdfWordCount.ignoreTableOfContents',
    ignoreAppendices: 'pdfWordCount.ignoreAppendices',
    ignoreReferences: 'pdfWordCount.ignoreReferences',
    ignoreCaptions: 'pdfWordCount.ignoreCaptions'
};

export const COUNTING_OPTION_DETAILS: Record<CountingOptionKey, { label: string; detail: string; shortLabel: string }> = {
    ignoreAbstract: {
        label: 'Ignore abstract',
        detail: 'Exclude the abstract/summary section from the word count',
        shortLabel: 'no abstract'
    },
    ignoreTableOfContents: {
        label: 'Ignore table of contents',
        detail: 'Exclude the table of contents from the word count',
        shortLabel: 'no toc'
    },
    ignoreAppendices: {
        label: 'Ignore appendices',
        detail: 'Exclude appendices from the word count',
        shortLabel: 'no appendices'
    },
    ignoreReferences: {
        label: 'Ignore references',
        detail: 'Exclude the references/bibliography section from the word count',
        shortLabel: 'no refs'
    },
    ignoreCaptions: {
        label: 'Ignore figure/table captions',
        detail: 'Exclude figure and table caption lines from the word count',
        shortLabel: 'no captions'
    }
};

// only match horizontal trailing space so the newline after the heading stays in the body
const ABSTRACT_START_PATTERN = /(?:^|\n)[ \t]*(?:abstract|summary)\b(?:[ \t]*[—\-–:.])?[ \t]*/i;
const TOC_START_PATTERN = /(?:^|\n)[ \t]*(?:table of contents|contents)[ \t]*(?:\n|$)/i;
const APPENDIX_SECTION_PATTERN =
    /(?:^|\n)\s*(?:\d+\.?\s*)?(?:appendix|appendices)\b(?:\s+[a-z]\.?|\s+\d+(?:\.\d+)?)?\s*(?:\n|$)/i;
const POST_REFERENCES_APPENDIX_START_PATTERN =
    /(?:^|\n)\s*A\.\s+(?:[A-Z][A-Za-z]*\s+){1,}[A-Z][A-Za-z]*\s*(?:\n|$)/;
// allow numbered headings such as "6.  REFERENCES"
const REFERENCE_SECTION_PATTERN =
    /(?:^|\n)\s*(?:\d+\.?\s*)?(?:references|bibliography|works cited|literature cited|citations)\s*(?:\n|$)/i;
// line-start figure/table captions such as "Figure 1:" or "Table 3."
const CAPTION_START_PATTERN =
    /^(?:Figure|Fig\.?|Table)\s+\d+(?:\.\d+)*[a-z]?(?:\s*[:\.]|\s*[-–—]|\s*\)|\s*$)/i;
const MAX_CAPTION_CONTINUATION_LINES = 4;

/**
 * Returns a short tooltip label for a section strip attempt.
 */
export function describeStripStatus(status: SectionStripStatus): string {
    switch (status) {
        case 'stripped':
            return 'found and excluded';
        case 'incomplete':
            return 'found, but not excluded';
        case 'notFound':
            return 'not found';
    }
}

/**
 * Returns whether a line looks like a section heading in flat PDF text.
 */
export function isHeadingLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 80) {
        return false;
    }
    // ignore bare page numbers
    if (/^\d{1,3}$/.test(trimmed)) {
        return false;
    }
    // ignore citation / bibliography lines
    if (/[[\]]/.test(trimmed)) {
        return false;
    }

    const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0 || words.length > 12) {
        return false;
    }

    // arabic-numbered headings: "1. Intro", "1 Intro", or glued "1INTRODUCTION"
    if (/^\d+\.\s+\S/.test(trimmed) || /^\d+\s+[A-Z]/.test(trimmed) || /^\d+[A-Z][A-Za-z]{2,}/.test(trimmed)) {
        return true;
    }
    // roman headings require a trailing dot so words like "Clang" / "ILSVRC" do not match
    if (/^[IVXLC]+\.\s+\S/.test(trimmed)) {
        return true;
    }
    // treat Contents as a heading so the abstract stops before the TOC
    if (/^(?:table of contents|contents)$/i.test(trimmed)) {
        return true;
    }
    // IEEE-style index-terms / keywords lines often end the abstract block
    if (/^(?:index\s*terms?|keywords?)\b/i.test(trimmed)) {
        return true;
    }

    // reject body prose that contains sentence punctuation or mid-line lowercase words
    if (/[.]/.test(trimmed) || /\s[a-z]{3,}/.test(trimmed)) {
        return false;
    }

    // short all-caps headings such as INTRODUCTION
    const letters = trimmed.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 4 && letters === letters.toUpperCase() && words.length <= 8) {
        return true;
    }

    // short title-case headings with little prose signal
    const alphaWords = words.filter((word) => /[A-Za-z]{2,}/.test(word));
    if (alphaWords.length >= 2 && alphaWords.length <= 6 && trimmed.length <= 50) {
        return alphaWords.every((word) => /^[A-Z]/.test(word.replace(/^[^A-Za-z]+/, '')));
    }

    return false;
}

/**
 * Returns whether a line looks like a TOC row rather than a real body heading.
 */
export function isTocEntryLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
        return false;
    }
    // dotted leaders common in TOC rows, e.g. "OP2  .  .  .  .  4"
    if (/\.\s{1,3}\.\s{1,3}\./.test(trimmed)) {
        return true;
    }
    // numbered TOC row ending in a page number, e.g. "1   Introduction3"
    if (/^\d+(?:\.\d+)*\s+\S.*\d\s*$/.test(trimmed)) {
        return true;
    }
    // unnumbered TOC row with a title glued to its page number, e.g. "References18"
    if (/^[A-Z][A-Za-z]+(?:\s+[A-Za-z]+)*\d+\s*$/.test(trimmed)) {
        return true;
    }
    return false;
}

/**
 * Returns whether a line starts a figure or table caption.
 */
export function isCaptionStartLine(line: string): boolean {
    return CAPTION_START_PATTERN.test(line.trim());
}

/**
 * Returns whether a line is a wrapped continuation of the current caption.
 */
export function isCaptionContinuationLine(line: string, continuationLinesIncluded: number): boolean {
    const trimmed = line.trim();
    if (!trimmed || continuationLinesIncluded >= MAX_CAPTION_CONTINUATION_LINES) {
        return false;
    }
    if (isCaptionStartLine(trimmed) || isHeadingLine(trimmed)) {
        return false;
    }
    if (/^\[?\d+\]/.test(trimmed)) {
        return false;
    }
    if (trimmed.length > 100) {
        return false;
    }
    // skip code blocks and table header rows that follow captions in extracted text
    if (/^(?:void|int|float|double|for|if|return|#include|System|Node)\b/.test(trimmed)) {
        return false;
    }
    if (/^\d+\.?\s+[A-Z]/.test(trimmed)) {
        return false;
    }
    // stop once the caption ends with a complete sentence rather than a hyphen wrap
    if (/[.!?]\s*$/.test(trimmed) && trimmed.length > 35 && /\s[a-z]{3,}/.test(trimmed) && !/-\s*$/.test(trimmed)) {
        return false;
    }
    return true;
}

/**
 * Removes figure and table caption lines from extracted PDF text.
 */
export function stripCaptions(text: string): StripResult {
    const parts = text.split(/(\n)/);
    let result = '';
    let inCaption = false;
    let continuationLines = 0;
    let removedAny = false;

    for (const part of parts) {
        if (part === '\n') {
            // blank lines mark the end of a caption block
            if (inCaption) {
                inCaption = false;
                continuationLines = 0;
            }
            result += part;
            continue;
        }

        if (isCaptionStartLine(part)) {
            removedAny = true;
            inCaption = true;
            continuationLines = 0;
            continue;
        }

        if (inCaption && isCaptionContinuationLine(part, continuationLines)) {
            removedAny = true;
            continuationLines += 1;
            continue;
        }

        inCaption = false;
        continuationLines = 0;
        result += part;
    }

    return {
        text: result,
        status: removedAny ? 'stripped' : 'notFound'
    };
}

/**
 * Returns the index of the references heading, if present.
 */
function findReferencesStart(text: string): number {
    return text.search(REFERENCE_SECTION_PATTERN);
}

/**
 * Returns the index of untitled appendix content placed after the references.
 */
function findPostReferencesAppendixStart(text: string): number {
    const referencesStart = findReferencesStart(text);
    if (referencesStart === -1) {
        return -1;
    }

    const relativeAppendixStart = text.slice(referencesStart).search(POST_REFERENCES_APPENDIX_START_PATTERN);
    if (relativeAppendixStart === -1) {
        return -1;
    }

    return referencesStart + relativeAppendixStart;
}

/**
 * Counts the number of characters in a string.
 */
export function countCharacters(text: string): number {
    return text.length;
}

/**
 * Counts the number of characters in a string, excluding whitespace.
 */
export function countCharactersExcludingSpaces(text: string): number {
    return text.replace(/\s/g, '').length;
}

/**
 * Counts the number of whitespace-delimited words in a string.
 */
export function countWords(text: string): number {
    return text.split(/\s+/).filter((word: string) => word.length > 0).length;
}

/**
 * Describes which document sections were successfully excluded from the count.
 */
export function describeExcludedSections(options: CountingOptions, stripStatuses: StripStatuses = {}): string {
    const excluded = (Object.keys(COUNTING_OPTION_DETAILS) as CountingOptionKey[])
        .filter((key) => options[key] && stripStatuses[key] === 'stripped')
        .map((key) => COUNTING_OPTION_DETAILS[key].label.replace(/^Ignore /i, '').toLowerCase());

    if (excluded.length === 0) {
        return 'all sections included';
    }

    return `excluding ${excluded.join(', ')}`;
}

/**
 * Removes a section from its start heading until the next generic heading.
 * If no end heading is found, leaves the text unchanged so the full count is kept.
 */
/**
 * Joins the kept prefix and suffix without gluing words across the cut.
 */
function joinStrippedParts(before: string, after: string): string {
    if (!before || !after) {
        return before + after;
    }
    // preserve a line break when the start match consumed the newline before the heading
    if (!/\n$/.test(before) && !/^\n/.test(after)) {
        return `${before}\n${after}`;
    }
    return before + after;
}

export function stripUntilNextHeading(
    text: string,
    startPattern: RegExp,
    // optional filter used to skip false headings such as TOC rows
    isIgnoredHeading: (line: string) => boolean = () => false
): StripResult {
    const start = text.search(startPattern);
    if (start === -1) {
        return { text, status: 'notFound' };
    }

    const match = text.slice(start).match(startPattern);
    if (!match) {
        return { text, status: 'notFound' };
    }

    // cut after a leading newline in the match so the previous line keeps its ending
    const cutStart = match[0].startsWith('\n') ? start + 1 : start;

    // body may continue on the same line after headings like "Abstract—"
    const contentStart = start + match[0].length;
    const remainder = text.slice(contentStart);
    let offset = 0;
    let isFirstLine = true;
    let wordsSeen = 0;

    for (const part of remainder.split(/(\n)/)) {
        if (part === '\n') {
            offset += 1;
            continue;
        }

        const lineStart = contentStart + offset;
        offset += part.length;

        // never treat the remainder of the start-heading line as the next heading
        if (isFirstLine) {
            wordsSeen += countWords(part);
            isFirstLine = false;
            continue;
        }

        // stop at the first subsequent real body heading
        if (wordsSeen > 0 && isHeadingLine(part) && !isIgnoredHeading(part)) {
            return {
                text: joinStrippedParts(text.slice(0, cutStart), text.slice(lineStart)),
                status: 'stripped'
            };
        }

        wordsSeen += countWords(part);
    }

    // start was found but no end heading — keep the full text
    return { text, status: 'incomplete' };
}

/**
 * Removes the abstract section from extracted PDF text, if one is found.
 */
export function stripAbstract(text: string): StripResult {
    // ignore TOC rows so the abstract does not swallow the Contents heading
    return stripUntilNextHeading(text, ABSTRACT_START_PATTERN, isTocEntryLine);
}

/**
 * Removes the table of contents from extracted PDF text, if one is found.
 */
export function stripTableOfContents(text: string): StripResult {
    // skip TOC rows so entries like "1   Introduction3" do not end the section early
    return stripUntilNextHeading(text, TOC_START_PATTERN, isTocEntryLine);
}

/**
 * Removes appendices from extracted PDF text, stopping before references when present.
 */
export function stripAppendices(text: string): StripResult {
    const preReferencesAppendixStart = text.search(APPENDIX_SECTION_PATTERN);
    if (preReferencesAppendixStart !== -1) {
        const afterStart = text.slice(preReferencesAppendixStart);
        const referenceOffset = afterStart.search(REFERENCE_SECTION_PATTERN);
        if (referenceOffset !== -1) {
            return {
                text: text.slice(0, preReferencesAppendixStart) + text.slice(preReferencesAppendixStart + referenceOffset),
                status: 'stripped'
            };
        }

        return {
            text: text.slice(0, preReferencesAppendixStart),
            status: 'stripped'
        };
    }

    const postReferencesAppendixStart = findPostReferencesAppendixStart(text);
    if (postReferencesAppendixStart !== -1) {
        return {
            text: text.slice(0, postReferencesAppendixStart),
            status: 'stripped'
        };
    }

    return { text, status: 'notFound' };
}

/**
 * Removes the references section from extracted PDF text, if one is found.
 */
export function stripReferences(text: string): StripResult {
    const referencesStart = findReferencesStart(text);
    if (referencesStart === -1) {
        return { text, status: 'notFound' };
    }

    const postReferencesAppendixStart = findPostReferencesAppendixStart(text);
    const referencesEnd = postReferencesAppendixStart === -1 ? text.length : postReferencesAppendixStart;
    return {
        text: text.slice(0, referencesStart) + text.slice(referencesEnd),
        status: 'stripped'
    };
}

/**
 * Applies enabled section exclusions to extracted PDF text.
 */
export function applySectionExclusions(
    text: string,
    options: CountingOptions
): { text: string; stripStatuses: StripStatuses } {
    let result = text;
    const stripStatuses: StripStatuses = {};

    if (options.ignoreAbstract) {
        const stripped = stripAbstract(result);
        result = stripped.text;
        stripStatuses.ignoreAbstract = stripped.status;
    }
    if (options.ignoreTableOfContents) {
        const stripped = stripTableOfContents(result);
        result = stripped.text;
        stripStatuses.ignoreTableOfContents = stripped.status;
    }
    if (options.ignoreAppendices) {
        const stripped = stripAppendices(result);
        result = stripped.text;
        stripStatuses.ignoreAppendices = stripped.status;
    }
    if (options.ignoreReferences) {
        const stripped = stripReferences(result);
        result = stripped.text;
        stripStatuses.ignoreReferences = stripped.status;
    }
    if (options.ignoreCaptions) {
        const stripped = stripCaptions(result);
        result = stripped.text;
        stripStatuses.ignoreCaptions = stripped.status;
    }

    return { text: result, stripStatuses };
}

/**
 * Derives word and character counts from extracted PDF text.
 */
export function getPdfStatsFromText(text: string, stripStatuses: StripStatuses = {}): PdfStats {
    return {
        wordCount: countWords(text),
        charCount: countCharacters(text),
        charCountExcludingSpaces: countCharactersExcludingSpaces(text),
        stripStatuses
    };
}

/**
 * Applies counting options and returns stats for the resulting text.
 */
export function getPdfStatsForOptions(text: string, options: CountingOptions): PdfStats {
    const excluded = applySectionExclusions(text, options);
    return getPdfStatsFromText(excluded.text, excluded.stripStatuses);
}
