# Change Log

All notable changes will be documented in this file.

<!-- Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file. -->

## [Unreleased]

- Add page count, file size, and words per page stats to the status bar tooltip.

## Pre-Release v0.0.3

- Bundle pdf.js into the CJS extension to fix import bug.
- Copy PDF bytes into a plain `Uint8Array` before parsing so Electron's fake-worker `structuredClone` does not throw `DataCloneError`.
- Improve tests so command success is asserted (return values + messages), not just non-throw.
- Cover the status bar/recount path with an open PDF, and smoke-test the bundled `dist/pdfText.js` parser.

## Pre-Release v0.0.2

Add Open VSX deployment and update extension description and notes.

## Pre-Release v0.0.1

Initial release of pdf-word-count, a lightweight extension that displays the word count of PDF documents in the status bar.
Only deployed to the VS Code Marketplace in this initial pre-release.
