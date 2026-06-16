# Diff View Performance Improvement Plan

## What
Identify why the raw‑diff view hangs when rendering very large files or files with a massive number of changes.

## We
Examine the current diff pipeline (content decoding, unified‑diff generation, `diff2html` HTML rendering, tokenisation, `diffArrays`, DOM insertion) and the UI‑thread handling around it.

## Where
The logic lives in **`src/abstract_diff_view.ts`** (methods `generateUnifiedDiff`, `shouldDisableMatching`, `updateDiffView`, `tokenizeHtml`, `buildSideHtml`, and the progress‑overlay helpers) and is invoked from the concrete views in **`src/diff_view.ts`**, **`src/recovery_diff_view.ts`**, and **`src/git_diff_view.ts`**.

## Why (Root Causes)
1. **Synchronous, CPU‑heavy work** – Myers diff, `diff2html` word‑matching, tokenisation, and `diffArrays` run on the main thread, blocking the UI.
2. **Insufficient heuristics** – The only size guard (`LARGE_CONTENT_THRESHOLD`) checks raw character length, not the number of changed hunks. Files with a modest character count but thousands of hunks still trigger the expensive O(n²) matching path, leading to freezes.

## How (Fixes)
1. **Async chunking & yielding** – Split heavy stages into small chunks and `await requestAnimationFrame()` (or `setTimeout(0)`) between them so the browser can paint.
2. **Hunk‑count guard** – Compute `hunkCount` (already done) and treat `hunkCount > LARGE_HUNK_THRESHOLD` the same as a length overflow: disable word‑matching (`config.matching = 'none'`) and switch to a lighter rendering path.
3. **Generation‑token cancellation** – Increment a `renderGeneration` token for each render; async steps abort early if the token has changed, preventing stale renders from overwriting newer ones.
4. **Progress overlay** – Re‑use the existing `diff-progress-overlay` (styled in `src/styles.scss`) to show a spinner and message while heavy work is in flight, so the user perceives activity instead of a frozen UI.
5. **Render caching** – Keep the `renderCache` for already‑rendered markdown to avoid re‑rendering the same version on repeated clicks.
6. **DocumentFragment assembly** – Build the final HTML inside a detached fragment before a single `appendChild`, eliminating intermediate reflows.
7. **Debounce version‑click handling** – If a render is in progress, cancel it via the token and start a new one only after the click processing finishes.

## Is (Verification)
All changes are internal to the diff view class; they preserve the public API, keep existing functionality, and are testable through the plugin UI. No external behaviour changes are introduced.

## When (Phased Implementation)
- **Phase 1 (Immediate):** Add the hunk‑count check and generation‑token logic to `updateDiffView`.
- **Phase 2 (Short‑term):** Insert `await this.yieldToMain()` yields at the start of each heavy block and show the progress overlay.
- **Phase 3 (Mid‑term):** Restructure raw‑diff rendering to use `DocumentFragment` and ensure the overlay hides on completion.
- **Phase 4 (Optional):** Add unit‑style tests for the new guard thresholds and token cancellation.

## Who (Ownership)
- **Primary owner:** Plugin maintainer (responsible for `src/abstract_diff_view.ts`).
- **Reviewers:** Contributors familiar with the Obsidian plugin API and front‑end performance profiling.

## Which (Files to Modify)
- `src/abstract_diff_view.ts` – core logic and UI helpers.
- `src/styles.scss` – ensure overlay styles are present (already defined).
- Optionally concrete view files (`src/diff_view.ts`, `src/recovery_diff_view.ts`, `src/git_diff_view.ts`) if they need to propagate new flags or reset the generation token on version changes.

---

**Summary** – By adding a hunk‑count threshold, async yielding, generation‑token cancellation, a progress overlay, and fragment‑based DOM insertion, we eliminate the main‑thread blockage that makes raw diffs appear hung on large or heavily‑changed files, while keeping the UI responsive and preserving full diff fidelity.