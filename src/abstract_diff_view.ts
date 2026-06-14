import { createTwoFilesPatch } from 'diff';
import { Diff2HtmlConfig, html } from 'diff2html';
import { App, Modal, TFile } from 'obsidian';
import { SYNC_WARNING } from './constants';
import FileModal from './file_modal';
import type { vItem, vRecoveryItem, vSyncItem } from './interfaces';
import type OpenSyncHistoryPlugin from './main';

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
	leftHistory: HTMLElement[];
	rightHistory: HTMLElement[];
	htmlConfig: Diff2HtmlConfig;
	ids: { left: number; right: number };

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
		// @ts-ignore
		this.syncHistoryContentContainer = this.contentEl.createDiv({
			cls: ['sync-history-content-container', 'diff'],
		});
		if (this.plugin.settings.colorBlind) {
			this.syncHistoryContentContainer.addClass('colorblind');
		}
	}

	onOpen() {
		super.onOpen();
		// in onOpen() of the child classes these calls need to be implemented

		// initial versions are different
		//

		// same
		// const diff = this.getDiff();
		// this.makeHistoryLists(FILE_REC_WARNING);

		// // Sync needs to make buttons as well
		// //

		// // same
		// this.basicHtml(diff);

		// // appending the versions is different
		// //

		// // same
		// this.makeMoreGeneralHtml();
	}

	abstract getInitialVersions(): Promise<void | boolean>;

	abstract appendVersions(): void;

	protected isBinaryFile(): boolean {
		const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'pdf', 'zip'];
		return binaryExtensions.includes(this.file.extension);
	}

	protected getBinaryPreview(): string {
		const leftBlob = new Blob([this.leftContent as Uint8Array]);
		const rightBlob = new Blob([this.rightContent as Uint8Array]);
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
	}

	public getDiff(): string {
		if (this.isBinaryFile()) {
			return this.getBinaryPreview();
		}

		const decoder = new TextDecoder('utf-8');
		const leftStr = this.leftContent instanceof Uint8Array ? decoder.decode(this.leftContent) : this.leftContent;
		const rightStr = this.rightContent instanceof Uint8Array ? decoder.decode(this.rightContent) : this.rightContent;

		// the second type is needed for the Git view, it reimplements getDiff
		// get diff
		const uDiff = createTwoFilesPatch(
			this.file.basename,
			this.file.basename,
			leftStr as string,
			rightStr as string
		);

		// create HTML from diff
		const diff = html(uDiff, this.htmlConfig);
		return diff;
	}

	public makeHistoryLists(warning: string): void {
		// create both history lists
		this.leftHistory = this.createHistory(this.contentEl, true, warning);
		this.rightHistory = this.createHistory(this.contentEl, false, warning);
	}

	private createHistory(
		el: HTMLElement,
		left: boolean = false,
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

	public basicHtml(diff: string, diffType: string): void {
		// set title
		this.titleEl.setText(diffType);
		// add diff to container
		this.syncHistoryContentContainer.innerHTML = diff;

		// add history lists and diff to DOM
		this.contentEl.appendChild(this.leftHistory[0]);
		this.contentEl.appendChild(this.syncHistoryContentContainer);
		this.contentEl.appendChild(this.rightHistory[0]);
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
		left: boolean = false
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
