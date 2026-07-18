import { createRequire } from "module";
import * as path from "path";
import { pathToFileURL } from "url";


/* Types */

type PdfDocument = {
    numPages: number;
    getPage: (pageNumber: number) => Promise<PdfPage>;
    cleanup: () => Promise<void> | void;
};

type PdfModule = {
    getDocument: (src: {
        data: Uint8Array;
        useSystemFonts?: boolean;
        disableFontFace?: boolean;
    }) => { promise: Promise<PdfDocument> };
    GlobalWorkerOptions: { workerSrc: string };
};

type PdfPage = {
    getTextContent: () => Promise<{ items: Array<PdfTextContentItem | { type: string }> }>;
};

export type PdfStats = {
    wordCount: number;
    charCount: number;
    charCountExcludingSpaces: number;
};

type PdfTextContentItem = {
    str: string;
    transform: number[] | Float32Array;
    width: number;
    height: number;
    hasEOL?: boolean;
};

/**
 * Minimal text-item shape used for position-aware assembly.
 * Matches the fields we rely on from pdf.js getTextContent().
 */
export type PdfTextItem = {
    str: string;
    transform: number[];
    width: number;
    height: number;
    hasEOL?: boolean;
};


/* Constants */

const PUNCTUATION_ONLY_PATTERN = /^[\p{P}]+$/u;
const SPACE_GAP_FACTOR = 0.15;  // gap larger than this fraction of font height becomes a space
const LINE_Y_FACTOR = 0.5;  // y delta larger than this fraction of font height starts a new line

let pdfModulePromise: Promise<PdfModule> | undefined;


/* Private methods */

/**
 * Assembles readable text from positioned PDF text items.
 * Inserts spaces from horizontal gaps and joins soft hyphen line breaks.
 */
export function assembleTextFromItems(items: readonly PdfTextItem[]): string {
    const runs = items
        .filter((item) => item.str.length > 0 || item.hasEOL)
        .map((item) => {
            const x = item.transform[4] ?? 0;
            const y = item.transform[5] ?? 0;
            const height =
                item.height ||
                Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) ||
                10;
            const width = item.width || 0;
            return {
                str: item.str,
                x,
                y,
                height,
                endX: x + width,
                hasEOL: Boolean(item.hasEOL)
            };
        });

    let out = "";
    for (let i = 0; i < runs.length; i++) {
        const cur = runs[i];
        const prev = i > 0 ? runs[i - 1] : undefined;

        if (prev) {
            const avgHeight = (prev.height + cur.height) / 2 || 10;
            const sameLine = Math.abs(cur.y - prev.y) <= avgHeight * LINE_Y_FACTOR;
            const lineBreak = prev.hasEOL || !sameLine;

            if (lineBreak) {
                if (shouldJoinHyphenatedLineBreak(out, cur.str)) {
                    out = out.slice(0, -1);
                } else if (cur.str.length > 0 && !/\s$/.test(out)) {
                    out += "\n";
                }
            } else if (cur.str.length > 0) {
                const gap = cur.x - prev.endX;
                const needsSpace =
                    gap > avgHeight * SPACE_GAP_FACTOR &&
                    !/\s$/.test(out) &&
                    !/^\s/.test(cur.str);
                if (needsSpace) {
                    out += " ";
                }
            }
        }

        out += cur.str;
    }

    return out;
}

/**
 * Counts characters, including punctuation and whitespace.
 */
export function countCharacters(text: string): number {
    return text.length;
}

/**
 * Counts characters, excluding all whitespace.
 */
export function countCharactersExcludingSpaces(text: string): number {
    return text.replace(/\s/g, "").length;
}

/**
 * Counts whitespace-delimited words, skipping punctuation-only tokens.
 */
export function countWords(text: string): number {
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
 * pdf.js expects a few browser globals that are missing in the extension host.
 */
function ensureDomPolyfills(): void {
    const globalObject = globalThis as typeof globalThis & {
        DOMMatrix?: new (init?: string | number[]) => object;
        Path2D?: new () => object;
    };

    if (typeof globalObject.DOMMatrix === "undefined") {
        class DOMMatrixPolyfill {
            a = 1;
            b = 0;
            c = 0;
            d = 1;
            e = 0;
            f = 0;

            constructor(init?: string | number[]) {
                if (Array.isArray(init) && init.length >= 6) {
                    [this.a, this.b, this.c, this.d, this.e, this.f] = init;
                }
            }

            multiplySelf(): this {
                return this;
            }

            translateSelf(x = 0, y = 0): this {
                this.e += x;
                this.f += y;
                return this;
            }

            scaleSelf(): this {
                return this;
            }

            inverse(): DOMMatrixPolyfill {
                return new DOMMatrixPolyfill();
            }

            static fromMatrix(matrix: {
                a: number;
                b: number;
                c: number;
                d: number;
                e: number;
                f: number;
            }): DOMMatrixPolyfill {
                return new DOMMatrixPolyfill([
                    matrix.a,
                    matrix.b,
                    matrix.c,
                    matrix.d,
                    matrix.e,
                    matrix.f
                ]);
            }
        }

        globalObject.DOMMatrix = DOMMatrixPolyfill;
    }

    if (typeof globalObject.Path2D === "undefined") {
        globalObject.Path2D = class Path2DPolyfill {};
    }
}

/**
 * Loads pdf.js once and points its worker at the packaged worker script.
 */
async function getPdfModule(): Promise<PdfModule> {
    if (!pdfModulePromise) {
        pdfModulePromise = (async () => {
            ensureDomPolyfills();
            const pdfjs = (await import(
                "pdfjs-dist/legacy/build/pdf.mjs"
            )) as unknown as PdfModule;
            const require = createRequire(__filename);
            const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
            const workerPath = path.join(packageRoot, "legacy/build/pdf.worker.mjs");
            // Electron/extension host resolves workers more reliably via file URLs.
            pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
            return pdfjs;
        })();
    }
    return pdfModulePromise;
}

/**
 * Parses a PDF buffer and returns word/character stats.
 */
export async function getPdfStatsFromBuffer(data: Uint8Array): Promise<PdfStats> {
    const text = await extractPdfTextFromBuffer(data);
    return getPdfStatsFromText(text);
}

/**
 * Returns whether a line break between previous output and the next item
 * is a soft hyphenation that should be joined.
 */
export function shouldJoinHyphenatedLineBreak(output: string, nextText: string): boolean {
    return /[\p{L}\p{N}]-$/u.test(output) && /^[\p{Ll}]/u.test(nextText);
}


/* Public methods */

/**
 * Extracts text from a PDF buffer using position-aware assembly.
 */
export async function extractPdfTextFromBuffer(data: Uint8Array): Promise<string> {
    const pdfjs = await getPdfModule();
    const doc = await pdfjs.getDocument({
        data,
        useSystemFonts: true,
        disableFontFace: true
    }).promise;

    try {
        const pages: string[] = [];
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
            const page = await doc.getPage(pageNumber);
            const content = await page.getTextContent();
            const items: PdfTextItem[] = [];

            for (const item of content.items) {
                if (!("str" in item)) {
                    continue;
                }
                items.push({
                    str: item.str,
                    transform: Array.from(item.transform),
                    width: item.width,
                    height: item.height,
                    hasEOL: item.hasEOL
                });
            }

            pages.push(assembleTextFromItems(items));
        }

        return pages.join("\n\n");
    } finally {
        await doc.cleanup();
    }
}

/**
 * Derives word and character counts from extracted PDF text.
 */
export function getPdfStatsFromText(text: string): PdfStats {
    return {
        wordCount: countWords(text),
        charCount: countCharacters(text),
        charCountExcludingSpaces: countCharactersExcludingSpaces(text)
    };
}
