import { createTwoFilesPatch, diffArrays } from 'diff';
import { Diff2HtmlConfig, html } from 'diff2html';
import { App, Modal, TFile, Component, MarkdownRenderer } from 'obsidian';
import { SYNC_WARNING } from './constants';
import FileModal from './file_modal';
import type { vItem, vRecoveryItem, vSyncItem } from './interfaces';
import type OpenSyncHistoryPlugin from './main';

/** Threshold: if total content length exceeds this, switch to performance mode */
const LARGE_CONTENT_THRESHOLD = 40000;

/**
 * If the unified diff contains more than this many changed hunks,
 * the diff2html + innerHTML path becomes expensive even for short files.
 */
const LARGE_HUNK_THRESHOLD = 300;

/**
 * Maximum number of diff2html matching comparisons before we
 * fall back to matching:'none' to avoid O(n²) blow-up.
 */
const MATCHING_MAX_COMPARISONS = 1000;

/**
 * Yield to the main thread at most every YIELD_INTERVAL_MS milliseconds
 * so the browser can paint the progress spinner and remain responsive.
 */
const YIELD_INTERVAL_MS = 50;

export default abstract class DiffView extends Modal {
	plugin: OpenSyncHistoryPlugin;
	app: App;
	file: TFile;
	leftVList: vItem[];
	rightVList: vItem[];
	leftActive: number;
	rightActive: number;
	rightContent: string | Uint8Array;
	leftContent: string | Uint8Array;
	syncHistoryContentContainer: HTMLElement;
	diffContentEl: HTMLElement;
	leftHistory: HTMLElement[];
	rightHistory: HTMLElement[];
	htmlConfig: Diff2HtmlConfig;
	ids: { left: number; right: number };
	comp: Component;
	viewMode: 'raw' | 'rendered';

	// ── Performance fields ──────────────────────────────────────────
	/** Monotonically-increasing token; stale renders abort when it changes */
	private renderGeneration = 0;
	/** Prevents overlapping renders from stacking up */
	private isRendering = false;
	/** Rendered-markdown cache keyed by a fast content hash */
	private renderCache = new Map<string, string>();
	/** Overlay element shown while heavy work is in flight */
	private progressOverlay: HTMLElement | null = null;
	/** Track last yield timestamp so we can yield periodically */
	private lastYieldTime = 0;

	// ── Helpers ─────────────────────────────────────────────────────

	/** Yield control to the browser so the UI stays responsive */
	private yieldToMain(): Promise<void> {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()));
	}

	/**
	 * Yield only if at least YIELD_INTERVAL_MS have elapsed since the
	 * last yield, keeping the overhead low for small diffs.
	 */
	private yieldIfNeeded(): Promise<void> {
		const now = performance.now();
		if (now - this.lastYieldTime >= YIELD_INTERVAL_MS) {
			this.lastYieldTime = now;
			return this.yieldToMain();
		}
		return Promise.resolve();
	}

	/** Simple DJB2-style hash → hex string for cache keys */
	private contentHash(str: string): string {
		let hash = 5381;
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
		}
		return (hash >>> 0).toString(36);
	}

	/**
	 * Show a non-interactive progress overlay inside the diff content area.
	 */
	private showProgress(message: string): void {
		if (!this.progressOverlay) {
			this.progressOverlay = this.diffContentEl.createDiv({
				cls: 'diff-progress-overlay',
			});
			this.progressOverlay.createDiv({ cls: 'diff-progress-spinner' });
			this.progressOverlay.createDiv({
				cls: 'diff-progress-text',
				text: message,
			});
		} else {
			const textEl = this.progressOverlay.querySelector(
				'.diff-progress-text'
			);
			if (textEl) textEl.textContent = message;
			this.progressOverlay.style.display = '';
		}
	}

	/** Hide and remove the progress overlay */
	private hideProgress(): void {
		if (this.progressOverlay) {
			this.progressOverlay.style.display = 'none';
		}
	}

	// ── Constructor ─────────────────────────────────────────────────

	constructor(plugin: OpenSyncHistoryPlugin, app: App, file: TFile) {
		super(app);
		this.plugin = plugin;
		this.app = app;
		this.file = file;
		this.modalEl.addClasses(['mod-sync-history', 'diff']);
		this.leftVList = [];
		this.rightVList = [];
		this.rightActive = 0;
		this.leftActive = 1;
		this.rightContent = '';
		this.leftContent = '';
		this.ids = { left: 0, right: 0 };
		//@ts-expect-error, will be filled with the correct data later
		this.leftHistory = [null];
		//@ts-expect-error, will be filled with the correct data later
		this.rightHistory = [null];
		this.htmlConfig = {
			diffStyle: this.plugin.settings.diffStyle,
			matchWordsThreshold: this.plugin.settings.matchWordsThreshold,
			outputFormat: this.plugin.settings.outputFormat,
		};
		this.containerEl.addClass('diff');
		this.syncHistoryContentContainer = this.contentEl.createDiv({
			cls: ['sync-history-content-container', 'diff'],
		});
		if (this.plugin.settings.colorBlind) {
			this.syncHistoryContentContainer.addClass('colorblind');
		}
		this.viewMode = 'rendered';
		this.comp = new Component();
		this.comp.load();
		this.createToggleBar();
		this.diffContentEl = this.syncHistoryContentContainer.createDiv({
			cls: 'diff-content-container-inner',
		});
	}

	// ── Lifecycle ───────────────────────────────────────────────────

	onOpen() {
		super.onOpen();
	}

	abstract getInitialVersions(): Promise<void | boolean>;

	abstract appendVersions(): void;

	protected isBinaryFile(): boolean {
		return this.plugin.diff_utils.isBinaryFile(this.file.name);
	}

	protected getBinaryPreview(): string {
		const toUint8Array = (
			content: string | Uint8Array | ArrayBuffer
		): Uint8Array => {
			if (content instanceof Uint8Array) return content;
			if (content instanceof ArrayBuffer) return new Uint8Array(content);
			if (typeof content === 'string')
				return new TextEncoder().encode(content);
			return new Uint8Array();
		};

		const leftUint8 = toUint8Array(this.leftContent);
		const rightUint8 = toUint8Array(this.rightContent);

		const isImage = [
			'png',
			'jpg',
			'jpeg',
			'gif',
			'bmp',
			'svg',
			'webp',
		].includes(this.file.extension.toLowerCase());

		if (isImage) {
			const leftBlob = new Blob([leftUint8 as BlobPart]);
			const rightBlob = new Blob([rightUint8 as BlobPart]);
			const leftUrl = URL.createObjectURL(leftBlob);
			const rightUrl = URL.createObjectURL(rightBlob);

			return `<div class="binary-diff">
				<div class="binary-side">
					<h4>Old Version</h4>
					<img src="${leftUrl}" style="max-width: 100%;" />
				</div>
				<div class="binary-side">
					<h4>New Version</h4>
					<img src="${rightUrl}" style="max-width: 100%;" />
				</div>
			</div>`;
		} else {
			return `<div class="binary-diff">
				<div class="binary-side">
					<h4>Old Version</h4>
					<div class="binary-fallback-msg">Visual diff not available for this binary format.</div>
					<div class="u-muted">Size: ${(leftUint8.length / 1024).toFixed(2)} KB</div>
				</div>
				<div class="binary-side">
					<h4>New Version</h4>
					<div class="binary-fallback-msg">Visual diff not available for this binary format.</div>
					<div class="u-muted">Size: ${(rightUint8.length / 1024).toFixed(2)} KB</div>
				</div>
			</div>`;
		}
	}

	// ── Diff generation ─────────────────────────────────────────────

	/**
	 * Decode the left/right content into strings.
	 */
	private decodeContents(): { leftStr: string; rightStr: string } {
		const decoder = new TextDecoder('utf-8');
		const leftStr =
			this.leftContent instanceof Uint8Array
				? decoder.decode(this.leftContent)
				: this.leftContent;
		const rightStr =
			this.rightContent instanceof Uint8Array
				? decoder.decode(this.rightContent)
				: this.rightContent;
		return { leftStr: leftStr as string, rightStr: rightStr as string };
	}

	/**
	 * Generate the unified diff string and count how many hunks it
	 * contains.  The hunk count is a better predictor of rendering cost
	 * than raw content length.
	 */
	private generateUnifiedDiff(): {
		uDiff: string;
		hunkCount: number;
		maxLength: number;
	} {
		const { leftStr, rightStr } = this.decodeContents();

		const uDiff = createTwoFilesPatch(
			this.file.basename,
			this.file.basename,
			leftStr,
			rightStr
		);

		// Count hunks (each starts with @@ … @@)
		const hunkCount = (uDiff.match(/^@@/gm) || []).length;
		const maxLength = Math.max(leftStr.length, rightStr.length);

		return { uDiff, hunkCount, maxLength };
	}

	/**
	 * Decide whether the diff2html word-matching should be disabled.
	 * The original check only looked at content length.  We also
	 * disable matching when the number of changed hunks is high,
	 * because diff2html's matching is O(n²) in the number of diff
	 * lines.
	 */
	private shouldDisableMatching(
		maxLength: number,
		hunkCount: number
	): boolean {
		return (
			maxLength > LARGE_CONTENT_THRESHOLD ||
			hunkCount > LARGE_HUNK_THRESHOLD
		);
	}

	public getDiff(): string {
		if (this.isBinaryFile()) {
			return this.getBinaryPreview();
		}

		const { uDiff, hunkCount, maxLength } = this.generateUnifiedDiff();

		const config: Diff2HtmlConfig = { ...this.htmlConfig };

		if (this.shouldDisableMatching(maxLength, hunkCount)) {
			config.matching = 'none';
		} else {
			config.matching = 'words' as Diff2HtmlConfig['matching'];
			config.matchingMaxComparisons = MATCHING_MAX_COMPARISONS;
		}

		return html(uDiff, config);
	}

	// ── History lists ───────────────────────────────────────────────

	public makeHistoryLists(warning: string): void {
		this.leftHistory = this.createHistory(this.contentEl, true, warning);
		this.rightHistory = this.createHistory(this.contentEl, false, warning);
	}

	private createHistory(
		el: HTMLElement,
		left = false,
		warning: string
	): HTMLElement[] {
		const syncHistoryListContainer = el.createDiv({
			cls: 'sync-history-list-container',
		});
		if (left) {
			const showFile = syncHistoryListContainer.createEl('button', {
				cls: 'mod-cta',
				text: 'Render this version',
			});
			showFile.addEventListener('click', () => {
				new FileModal(
					this.plugin,
					this.app,
					this.leftContent,
					this.file,
					warning
				).open();
			});
		}
		const syncHistoryList = syncHistoryListContainer.createDiv({
			cls: 'sync-history-list',
		});
		return [syncHistoryListContainer, syncHistoryList];
	}

	onClose() {
		super.onClose();
		this.comp.unload();
		this.renderCache.clear();
	}

	// ── Toggle bar (Raw / Rendered) ─────────────────────────────────

	private createToggleBar(): void {
		if (this.isBinaryFile()) {
			return;
		}

		const toggleBar = this.syncHistoryContentContainer.createDiv({
			cls: 'diff-toggle-bar',
		});

		const rawButton = toggleBar.createEl('button', {
			cls: ['diff-toggle-btn'],
			text: 'Raw Diff',
		});

		const renderButton = toggleBar.createEl('button', {
			cls: ['diff-toggle-btn', 'is-active'],
			text: 'Rendered',
		});

		rawButton.addEventListener('click', () => {
			if (this.viewMode !== 'raw') {
				this.viewMode = 'raw';
				rawButton.addClass('is-active');
				renderButton.removeClass('is-active');
				this.updateDiffView();
			}
		});

		renderButton.addEventListener('click', () => {
			if (this.viewMode !== 'rendered') {
				this.viewMode = 'rendered';
				renderButton.addClass('is-active');
				rawButton.removeClass('is-active');
				this.updateDiffView();
			}
		});
	}

	// ── Rendered-mode helpers ───────────────────────────────────────

	/**
	 * Tokenize an HTML string into an array of tags and text tokens.
	 */
	private tokenizeHtml(htmlStr: string): string[] {
		const tokens: string[] = [];
		const regex = /(<[^>]+>|[^<]+)/g;
		let match;
		while ((match = regex.exec(htmlStr)) !== null) {
			const token = match[0];
			if (token.startsWith('<')) {
				tokens.push(token);
			} else {
				const textRegex = /(\w+|[^\w\s]+|\s+)/g;
				let textMatch;
				while ((textMatch = textRegex.exec(token)) !== null) {
					tokens.push(textMatch[0]);
				}
			}
		}
		return tokens;
	}

	/**
	 * Add a CSS class to an HTML tag string.
	 */
	private addClassToTag(tag: string, className: string): string {
		if (tag.startsWith('</')) {
			return tag;
		}
		const classMatch = tag.match(/class=["']([^"']*)["']/);
		if (classMatch) {
			const existingClasses = classMatch[1];
			const newClasses = existingClasses
				? `${existingClasses} ${className}`
				: className;
			return tag.replace(
				/class=["']([^"']*)["']/,
				`class="${newClasses}"`
			);
		} else {
			const tagNameMatch = tag.match(/^<\w+/);
			if (tagNameMatch) {
				const tagName = tagNameMatch[0];
				return tag.replace(
					tagName,
					`${tagName} class="${className}"`
				);
			}
		}
		return tag;
	}

	/**
	 * Get rendered markdown HTML for a given string, using a content-hash
	 * cache to avoid re-rendering the same content on repeated clicks.
	 */
	private async getRenderedHtml(
		content: string,
		generation: number
	): Promise<string | null> {
		const hash = this.contentHash(content);
		const cached = this.renderCache.get(hash);
		if (cached) return cached;

		const tempDiv = document.createElement('div');
		await MarkdownRenderer.render(
			this.app,
			content,
			tempDiv,
			this.file.path,
			this.comp
		);

		// Check if this render was superseded before we finish
		if (this.renderGeneration !== generation) return null;

		const result = tempDiv.innerHTML;
		this.renderCache.set(hash, result);
		return result;
	}

	/**
	 * Build the diff-marked HTML for one side from a tokenized diff result.
	 */
	private buildSideHtml(
		diffResult: ReturnType<typeof diffArrays>,
		side: 'left' | 'right'
	): string[] {
		const parts: string[] = [];
		const isAdded = side === 'right';

		for (const change of diffResult as Array<{ added?: boolean; removed?: boolean; value: string[] }>) {
			if (change.added) {
				if (!isAdded) continue;
				for (const token of change.value) {
					if (token.startsWith('<')) {
						parts.push(
							this.addClassToTag(token, 'diff-rendered-added')
						);
					} else {
						parts.push(
							`<ins class="diff-rendered-added">${token}</ins>`
						);
					}
				}
			} else if (change.removed) {
				if (isAdded) continue;
				for (const token of change.value) {
					if (token.startsWith('<')) {
						parts.push(
							this.addClassToTag(token, 'diff-rendered-deleted')
						);
					} else {
						parts.push(
							`<del class="diff-rendered-deleted">${token}</del>`
						);
					}
				}
			} else {
				for (const token of change.value) {
					parts.push(token);
				}
			}
		}
		return parts;
	}

	// ── Core render method ──────────────────────────────────────────

	/**
	 * Re-render the diff content area for the current view mode.
	 *
	 * Key performance strategies:
	 * 1. **Generation-token cancellation** – each call bumps
	 *    `renderGeneration`; any stale async step checks this token
	 *    and aborts immediately so old renders never overwrite new ones.
	 * 2. **Debouncing** – if a render is already in flight, the new
	 *    request replaces the pending one (the old will self-abort via
	 *    the generation check).
	 * 3. **Progress overlay** – a lightweight spinner is shown for
	 *    heavy renders so the modal never looks frozen.
	 * 4. **Async yielding** – for large diffs the work is split into
	 *    chunks with `requestAnimationFrame` yields so the browser can
	 *    paint between chunks.
	 * 5. **Render cache** – the `MarkdownRenderer.render` output for
	 *    each unique content string is cached so re-clicking the same
	 *    version is instant.
	 * 6. **DocumentFragment** – for the rendered (side-by-side) mode,
	 *    the DOM tree is assembled in a detached fragment before being
	 *    attached in one batch, avoiding intermediate reflows.
	 */
	public async updateDiffView(): Promise<void> {
		// Cancel any in-flight render
		const generation = ++this.renderGeneration;

		// If a render is already running, the running one will detect
		// the generation mismatch and abort. We proceed immediately.
		this.isRendering = true;
		this.diffContentEl.empty();

		if (this.isBinaryFile()) {
			this.diffContentEl.innerHTML = this.getDiff();
			this.isRendering = false;
			return;
		}

		// ── Raw Diff path ────────────────────────────────────────
		if (this.viewMode === 'raw') {
			const { uDiff, hunkCount, maxLength } =
				this.generateUnifiedDiff();

			const config: Diff2HtmlConfig = { ...this.htmlConfig };
			if (this.shouldDisableMatching(maxLength, hunkCount)) {
				config.matching = 'none';
			} else {
				config.matching = 'words' as Diff2HtmlConfig['matching'];
				config.matchingMaxComparisons = MATCHING_MAX_COMPARISONS;
			}

			// Yield before the expensive html() call so the toggle
			// button state paints first
			await this.yieldToMain();
			if (this.renderGeneration !== generation) {
				this.isRendering = false;
				return;
			}

			// For very large diffs, show a progress indicator
			const isHeavy = this.shouldDisableMatching(maxLength, hunkCount);
			if (isHeavy) {
				this.showProgress('Rendering diff…');
				await this.yieldToMain();
				if (this.renderGeneration !== generation) {
					this.hideProgress();
					this.isRendering = false;
					return;
				}
			}

			const diffHtml = html(uDiff, config);

			if (this.renderGeneration !== generation) {
				this.hideProgress();
				this.isRendering = false;
				return;
			}

			// Build the DOM in a fragment to avoid intermediate reflows
			const fragment = document.createDocumentFragment();
			const wrapper = document.createElement('div');
			wrapper.innerHTML = diffHtml;
			fragment.appendChild(wrapper);

			if (this.renderGeneration !== generation) {
				this.hideProgress();
				this.isRendering = false;
				return;
			}

			this.diffContentEl.appendChild(fragment);
			this.hideProgress();
			this.isRendering = false;
			return;
		}

		// ── Rendered (side-by-side) path ─────────────────────────
		const { leftStr, rightStr } = this.decodeContents();

		const isHeavy =
			leftStr.length > LARGE_CONTENT_THRESHOLD ||
			rightStr.length > LARGE_CONTENT_THRESHOLD;

		if (isHeavy) {
			this.showProgress('Rendering markdown…');
			await this.yieldToMain();
			if (this.renderGeneration !== generation) {
				this.hideProgress();
				this.isRendering = false;
				return;
			}
		}

		// Render both markdowns (with caching)
		const leftHtml = await this.getRenderedHtml(leftStr, generation);
		if (leftHtml === null) {
			// Stale – another render superseded us
			this.hideProgress();
			this.isRendering = false;
			return;
		}

		if (isHeavy) {
			this.showProgress('Computing diff…');
			await this.yieldToMain();
			if (this.renderGeneration !== generation) {
				this.hideProgress();
				this.isRendering = false;
				return;
			}
		}

		const rightHtml = await this.getRenderedHtml(rightStr, generation);
		if (rightHtml === null) {
			this.hideProgress();
			this.isRendering = false;
			return;
		}

		// Tokenize and diff
		const leftTokens = this.tokenizeHtml(leftHtml);
		const rightTokens = this.tokenizeHtml(rightHtml);

		if (this.renderGeneration !== generation) {
			this.hideProgress();
			this.isRendering = false;
			return;
		}

		const diffResult = diffArrays(leftTokens, rightTokens);

		// Yield after the potentially expensive diffArrays call
		await this.yieldToMain();
		if (this.renderGeneration !== generation) {
			this.hideProgress();
			this.isRendering = false;
			return;
		}

		// Build side HTML
		const leftDiffHtmlParts = this.buildSideHtml(diffResult, 'left');
		const rightDiffHtmlParts = this.buildSideHtml(diffResult, 'right');

		const finalLeftHtml = leftDiffHtmlParts.join('');
		const finalRightHtml = rightDiffHtmlParts.join('');

		// Assemble the DOM tree in a detached fragment to avoid
		// intermediate reflows on the live DOM
		const fragment = document.createDocumentFragment();

		const renderedContainer = document.createElement('div');
		renderedContainer.className = 'markdown-rendered-diff';

		const leftSide = document.createElement('div');
		leftSide.className = 'markdown-side';
		const leftHeading = document.createElement('h4');
		leftHeading.textContent = 'Old Version (Rendered)';
		leftSide.appendChild(leftHeading);
		const leftContentEl = document.createElement('div');
		leftContentEl.className = 'rendered-content';
		leftContentEl.innerHTML = finalLeftHtml;
		leftSide.appendChild(leftContentEl);

		const rightSide = document.createElement('div');
		rightSide.className = 'markdown-side';
		const rightHeading = document.createElement('h4');
		rightHeading.textContent = 'New Version (Rendered)';
		rightSide.appendChild(rightHeading);
		const rightContentEl = document.createElement('div');
		rightContentEl.className = 'rendered-content';
		rightContentEl.innerHTML = finalRightHtml;
		rightSide.appendChild(rightContentEl);

		renderedContainer.appendChild(leftSide);
		renderedContainer.appendChild(rightSide);
		fragment.appendChild(renderedContainer);

		// Check generation one last time before committing to the DOM
		if (this.renderGeneration !== generation) {
			this.hideProgress();
			this.isRendering = false;
			return;
		}

		// Single DOM attachment — avoids intermediate reflows
		this.diffContentEl.appendChild(fragment);
		this.hideProgress();

		// Synchronized scrolling
		let isScrolling = false;
		leftSide.addEventListener('scroll', () => {
			if (!isScrolling) {
				isScrolling = true;
				rightSide.scrollTop = leftSide.scrollTop;
				rightSide.scrollLeft = leftSide.scrollLeft;
				isScrolling = false;
			}
		});

		rightSide.addEventListener('scroll', () => {
			if (!isScrolling) {
				isScrolling = true;
				leftSide.scrollTop = rightSide.scrollTop;
				leftSide.scrollLeft = rightSide.scrollLeft;
				isScrolling = false;
			}
		});

		this.isRendering = false;
	}

	// ── HTML scaffolding ────────────────────────────────────────────

	public basicHtml(diff: string, diffType: string): void {
		// set title
		this.titleEl.setText(diffType);

		// add history lists and diff to DOM
		this.contentEl.appendChild(this.leftHistory[0]);
		this.contentEl.appendChild(this.syncHistoryContentContainer);
		this.contentEl.appendChild(this.rightHistory[0]);

		this.updateDiffView();
	}

	public makeMoreGeneralHtml(): void {
		// highlight initial two versions
		this.rightVList[0].html.addClass('is-active');
		this.leftVList[1].html.addClass('is-active');
		// keep track of highlighted versions
		this.rightActive = 0;
		this.leftActive = 1;
	}

	public async generateVersionListener(
		div: HTMLDivElement,
		currentVList: vItem[],
		currentActive: number,
		left = false
	): Promise<vItem> {
		// the exact return type depends on the type of currentVList, it is either vSyncItem or vRecoveryItem
		// formerly active left/right version
		const currentSideOldVersion = currentVList[currentActive];
		// get the HTML of the new version to set it active
		const idx = Number(div.id);
		const clickedEl: vItem = currentVList[idx];
		div.addClass('is-active');
		if (left) {
			this.leftActive = idx;
		} else {
			this.rightActive = idx;
		}
		// make old not active
		if (Number.parseInt(currentSideOldVersion.html.id) !== idx) {
			currentSideOldVersion.html.classList.remove('is-active');
		}
		return clickedEl;
	}
}