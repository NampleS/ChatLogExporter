/**
 * @name ChatLogExporter
 * @author NampleS
 * @version 2.6.38
 * @description Collects every accessible Discord message and exports an LLM-friendly AI Archive containing structured JSONL, readable Markdown, identity maps, and channel hierarchy metadata. Also exports a selected message range as a long Discord-style screenshot image (copy to clipboard or save to file).
 */

// ---------------------------------------------------------------------------
// Signed auto-update (GitHub-hosted). The plugin checks a tiny version.json on
// GitHub; when a newer version is published it downloads the new plugin file,
// verifies it was signed with the author's ed25519 private key (the matching
// public key is baked in below by the release script), and only then overwrites
// itself in place. No server needed. The public key is injected by
// tools/push-plugin.mjs on every release — do not edit it by hand.
// ---------------------------------------------------------------------------
const UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEA35bvcLPmTFfgJ3ePZ9rjNQTM8zOsOlf/FMmk2QCY5T8=";
const UPDATE_REPO = "NampleS/ChatLogExporter";
const UPDATE_BRANCH = "main";
const UPDATE_RAW_BASE = `https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}`;

module.exports = class ChatLogExporter {
	constructor () {
		this.name = "ChatLogExporter";
		this.version = "2.6.38";
		this.defaultSettings = {
			pageSize: 100,
			fetchDelayMs: 350,
			exportFormat: "ai_archive",
			aiSplitMessages: 25000,
			aiSplitSizeMB: 10,
			exportOrder: "oldest",
			includeAttachments: true,
			includeEmbeds: true,
			includeReactions: true,
			includeReplyInfo: true,
			includeMessageLinks: true,
			includeIds: true,
			includeEditedAt: true,
			shortcutEnabled: true,
			outputFolder: "",
			autoUpdate: true,
			shotMaxHeight: 15000
		};
		this.settings = Object.assign({}, this.defaultSettings);
		this.panel = null;
		this.shortcutHandler = null;
		this.panelEscHandler = null;
		this.panelMonitor = null;
		this.manifestCache = null;
		this.currentUi = null;
		this.abortCollect = false;
		this.collecting = false;
		this.exporting = false;
		this.preferredFetchTransport = null;
		this.progressState = this.makeIdleProgress();
		this.currentGuildSnapshot = null;
		this.lastPanelState = null;
		this.contextUnpatches = [];
		this.targetScope = null;
		this.collectionDiagnostics = null;
		this.lastCollectionDiagnosticText = "";
		this.floatingProgress = null;
		this.rangeSelection = null;
		this.rangeModal = null;
		this.rangeEscHandler = null;
		this.messageContextDomHandler = null;
		this.messageContextObserver = null;
		this.pendingMessageContext = null;
		this.fallbackRangeSubmenu = null;
		this.fallbackRangeSubmenuCloseTimer = null;
		this.messageContextWatchTimer = null;
		this.updating = false;
		this.updateGen = 0;
		this.updateCheckTimer = null;
		this.latestVersion = "";
		this.lastUpdateError = "";
		this.updateFailToasted = false;
	}

	getName () {return this.name;}
	getAuthor () {return "NampleS";}
	getVersion () {return this.version;}
	getDescription () {return "Builds a persistent per-server or per-DM cache and exports LLM-friendly AI archives with JSONL messages, Markdown transcripts, stable user identities, reply relationships, and forum/thread hierarchy.";}

	start () {
		this.loadSettings();
		this.ensureBaseFolders();
		this.injectCss();
		this.bindShortcut();
		this.bindContextMenus();
		this.bindMessageContextFallback();
		this.updateGen++;
		this.scheduleUpdateChecks(this.updateGen);
		BdApi.UI.showToast("ChatLogExporter loaded", {type: "success"});
	}

	stop () {
		this.abortCollect = true;
		this.collecting = false;
		this.exporting = false;
		this.removePanel();
		this.removeFloatingProgress();
		this.removeRangeModal();
		if (this.shotOverlay) {try {this.shotOverlay.remove();} catch (_) {} this.shotOverlay = null;}
		if (this.shotEscHandler) {document.removeEventListener("keydown", this.shotEscHandler, true); this.shotEscHandler = null;}
		this.shotCancel = true;
		if (this.shotProgress) this.removeShotProgress(this.shotProgress);
		this.updateGen++;
		if (this.updateCheckTimer) {clearTimeout(this.updateCheckTimer); this.updateCheckTimer = null;}
		for (const unpatch of this.contextUnpatches.splice(0)) {try {unpatch();} catch (_) {}}
		if (this.messageContextDomHandler) document.removeEventListener("contextmenu", this.messageContextDomHandler, true);
		this.messageContextDomHandler = null;
		this.stopMessageContextWatch();
		this.messageContextObserver = null;
		this.pendingMessageContext = null;
		this.removeFallbackRangeSubmenu();
		if (this.shortcutHandler) document.removeEventListener("keydown", this.shortcutHandler, true);
		this.shortcutHandler = null;
		clearInterval(this.panelMonitor);
		this.panelMonitor = null;
		BdApi.DOM.removeStyle("ChatLogExporterCSS");
	}

	makeIdleProgress () {
		return {
			active: false,
			mode: "",
			guildId: "",
			guildName: "",
			status: "",
			progress: 0,
			channelsDone: 0,
			channelsTotal: 0,
			currentChannel: "",
			requests: 0,
			received: 0,
			saved: 0,
			failed: 0,
			processedItems: 0,
			totalItems: 0,
			phase: "",
			startedAt: 0,
			updatedAt: 0
		};
	}

	loadSettings () {
		const stored = BdApi.Data.load(this.name, "settings") || {};
		this.settings = Object.assign({}, this.defaultSettings, stored);
		delete this.settings.injectButton;
		if (!stored.aiArchiveMigrationV2) {
			this.settings.exportFormat = "ai_archive";
			this.settings.aiArchiveMigrationV2 = true;
			this.saveSettings();
		}
	}

	saveSettings () {BdApi.Data.save(this.name, "settings", this.settings);}

	// ───────────────────────── Signed auto-update ─────────────────────────────
	// Ported from the author's proven BetterDiscord update system. Hosted on
	// GitHub instead of a relay server: it reads version.json, and only installs
	// a newer plugin file after verifying the author's ed25519 signature.

	cmpVersion (a, b) {
		const pa = String(a || "0").split(".").map(n => parseInt(n, 10) || 0);
		const pb = String(b || "0").split(".").map(n => parseInt(n, 10) || 0);
		const len = Math.max(pa.length, pb.length);
		for (let i = 0; i < len; i++) {const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1;}
		return 0;
	}

	scheduleUpdateChecks (gen) {
		// First look shortly after load, then every 6 hours while enabled.
		setTimeout(() => {if (this.updateGen === gen) this.checkUpdate(false);}, 12000);
		const tick = () => {
			if (this.updateGen !== gen) return;
			this.updateCheckTimer = setTimeout(() => {if (this.updateGen !== gen) return; this.checkUpdate(false); tick();}, 6 * 60 * 60 * 1000);
		};
		tick();
	}

	ghFetchText (url) {
		return new Promise((resolve, reject) => {
			// Node https bypasses Discord's CSP/CORS; fall back to BdApi.Net.fetch.
			try {
				const https = require("https");
				const req = https.get(url, {headers: {"User-Agent": "ChatLogExporter-Updater", "Accept": "text/plain,application/json,*/*", "Cache-Control": "no-cache"}}, res => {
					const status = res.statusCode || 0;
					if (status >= 300 && status < 400 && res.headers.location) {res.resume(); let next; try {next = new URL(res.headers.location, url).href;} catch (_) {return reject(new Error("리다이렉트 오류"));} return this.ghFetchText(next).then(resolve, reject);}
					if (status !== 200) {res.resume(); return reject(new Error("HTTP " + status));}
					let data = ""; res.setEncoding("utf8");
					res.on("data", chunk => {data += chunk;});
					res.on("end", () => resolve(data));
					res.on("error", reject);
				});
				req.on("error", reject);
				req.setTimeout(30000, () => {try {req.destroy();} catch (_) {} reject(new Error("시간 초과"));});
				return;
			}
			catch (_) {}
			try {
				const doFetch = (BdApi.Net && typeof BdApi.Net.fetch === "function") ? BdApi.Net.fetch : fetch;
				doFetch(url, {method: "GET"}).then(res => res.ok ? res.text() : Promise.reject(new Error("HTTP " + res.status))).then(resolve, reject);
			}
			catch (error) {reject(error);}
		});
	}

	ownFilePath () {
		const path = require("path");
		let filename = "ChatLogExporter.plugin.js";
		try {const meta = BdApi.Plugins.get(this.name); if (meta && meta.filename) filename = meta.filename;} catch (_) {}
		return path.join(BdApi.Plugins.folder, filename);
	}

	b64ToBytes (b64) {
		const bin = atob(String(b64 || "").trim());
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	// Returns null when the signature is valid, otherwise a reason string.
	// Avoids Buffer (not always present in the Discord renderer): bytes come from
	// atob + TextEncoder. Tries node crypto first, then WebCrypto Ed25519.
	async verifySignature (text, sigB64) {
		if (!UPDATE_PUBLIC_KEY) return "이 판에는 공개 열쇠가 안 박혀 있어";
		if (!sigB64) return "서명이 없어";
		let data, sig, spki;
		try {
			data = new TextEncoder().encode(text);
			sig = this.b64ToBytes(sigB64);
			spki = this.b64ToBytes(UPDATE_PUBLIC_KEY);
		}
		catch (e) {return "서명을 읽지 못했어: " + ((e && e.message) || e);}
		let nodeErr = "";
		try {
			const nodeCrypto = require("crypto");
			if (nodeCrypto && typeof nodeCrypto.verify === "function") {
				const key = nodeCrypto.createPublicKey({key: spki, format: "der", type: "spki"});
				return nodeCrypto.verify(null, data, key, sig) ? null : "서명이 안 맞아 — 받은 파일을 버렸어";
			}
			nodeErr = "verify 없음";
		}
		catch (e) {nodeErr = (e && e.message) || String(e);}
		try {
			const subtle = globalThis.crypto && globalThis.crypto.subtle;
			if (!subtle) return "서명을 확인할 방법이 없어 (노드: " + nodeErr + " / 웹: 없음)";
			const key = await subtle.importKey("spki", spki, {name: "Ed25519"}, false, ["verify"]);
			const ok = await subtle.verify({name: "Ed25519"}, key, sig, data);
			return ok ? null : "서명이 안 맞아 — 받은 파일을 버렸어";
		}
		catch (e) {return "서명 확인 실패 (노드: " + nodeErr + " / 웹: " + ((e && e.message) || e) + ")";}
	}

	async checkUpdate (manual) {
		if (!manual && !this.settings.autoUpdate) return;
		if (this.updating) return;
		this.updating = true;
		try {
			const metaText = await this.ghFetchText(`${UPDATE_RAW_BASE}/version.json?t=${Date.now()}`);
			let meta; try {meta = JSON.parse(metaText);} catch (_) {throw new Error("version.json 을 읽지 못했어");}
			const remote = meta && meta.version;
			if (!remote) throw new Error("원격 판번호를 못 읽었어");
			this.latestVersion = remote;
			if (this.cmpVersion(remote, this.version) <= 0) {
				if (manual) BdApi.UI.showToast("이미 최신이야 (v" + this.version + ")", {type: "info"});
				return;
			}
			if (!UPDATE_PUBLIC_KEY) {
				BdApi.UI.showToast("새 판 v" + remote + " 이 있는데 서명 열쇠가 없어 설치는 안 할게. 주인한테 파일을 받아줘.", {type: "warning", timeout: 10000});
				return;
			}
			const text = await this.ghFetchText(`${UPDATE_RAW_BASE}/ChatLogExporter.plugin.js?t=${Date.now()}`);
			// Make sure we really got this plugin before overwriting ourselves.
			if (typeof text !== "string" || text.length < 5000) throw new Error("받은 파일이 너무 짧아");
			if (text.indexOf("module.exports = class ChatLogExporter") < 0) throw new Error("받은 파일이 이 플러그인이 아니야");
			const gotVer = (text.match(/@version\s+([0-9][0-9.]*)/) || [])[1];
			if (gotVer !== remote) throw new Error("판번호가 안 맞아 (" + gotVer + " / " + remote + ")");
			const bad = await this.verifySignature(text, meta.sig);
			if (bad) throw new Error(bad);

			const fs = require("fs");
			const target = this.ownFilePath();
			if (!fs.existsSync(target)) throw new Error("내 파일을 못 찾았어: " + target);
			try {fs.copyFileSync(target, target + ".bak-" + this.version);} catch (_) {}
			BdApi.UI.showToast("ChatLogExporter v" + this.version + " → v" + remote + " 업데이트할게", {type: "success", timeout: 6000});
			// Overwrite IN PLACE (never rename): BetterDiscord treats a rename as a
			// disable, which left friends' plugins turned off after each update.
			fs.writeFileSync(target, text, "utf8");
			const name = this.name;
			setTimeout(() => {try {if (BdApi.Plugins.isLoaded(name) && !BdApi.Plugins.isEnabled(name)) BdApi.Plugins.enable(name);} catch (_) {}}, 4000);
		}
		catch (e) {
			const msg = (e && e.message) || String(e);
			this.lastUpdateError = msg;
			if (manual) BdApi.UI.showToast("업데이트 실패: " + msg, {type: "error", timeout: 9000});
			else if (!this.updateFailToasted) {this.updateFailToasted = true; BdApi.UI.showToast("ChatLogExporter 자동 업데이트 실패: " + msg, {type: "warning", timeout: 9000});}
		}
		finally {this.updating = false;}
	}

	get fs () {return require("fs");}
	get path () {return require("path");}

	getCacheRoot () {return this.path.join(BdApi.Plugins.folder, "ChatLogExporterCache");}
	getGuildDir (guildId) {return this.path.join(this.getCacheRoot(), String(guildId));}
	getChannelsDir (guildId) {return this.path.join(this.getGuildDir(guildId), "channels");}
	getManifestPath (guildId) {return this.path.join(this.getGuildDir(guildId), "manifest.json");}
	getChannelDataPath (guildId, channelId) {return this.path.join(this.getChannelsDir(guildId), `${String(channelId)}.jsonl`);}
	getDefaultOutputFolder () {
		// BetterDiscord's sandbox may incorrectly resolve Node's built-in `os`
		// module as a file inside the Discord installation directory. Derive the
		// home directory from environment variables instead, then fall back to a
		// dedicated export folder beside the plugin.
		const env = typeof process !== "undefined" && process.env ? process.env : {};
		const home = env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : "");
		const candidates = [];
		if (home) candidates.push(this.path.join(home, "Downloads"));
		candidates.push(this.path.join(BdApi.Plugins.folder, "ChatLogExporterExports"));
		for (const candidate of candidates) {
			try {
				this.fs.mkdirSync(candidate, {recursive: true});
				if (this.fs.existsSync(candidate)) return candidate;
			}
			catch (_) {}
		}
		return BdApi.Plugins.folder;
	}
	getOutputFolder () {return String(this.settings.outputFolder || "").trim() || this.getDefaultOutputFolder();}

	ensureBaseFolders () {
		this.fs.mkdirSync(this.getCacheRoot(), {recursive: true});
		this.fs.mkdirSync(this.getOutputFolder(), {recursive: true});
	}

	getWebpackModule (filter) {try {return BdApi.Webpack.getModule(filter, {searchExports: true});} catch (_) {return null;}}
	getStore (name, fallbackFilter) {
		try {
			if (BdApi.Webpack && typeof BdApi.Webpack.getStore === "function") {
				const store = BdApi.Webpack.getStore(name);
				if (store) return store;
			}
		}
		catch (_) {}
		return fallbackFilter ? this.getWebpackModule(fallbackFilter) : null;
	}

	getStores () {
		return {
			SelectedChannelStore: this.getStore("SelectedChannelStore", m => m && typeof m.getChannelId === "function"),
			SelectedGuildStore: this.getStore("SelectedGuildStore", m => m && typeof m.getGuildId === "function"),
			ChannelStore: this.getStore("ChannelStore", m => m && typeof m.getChannel === "function"),
			GuildChannelStore: this.getStore("GuildChannelStore", m => m && typeof m.getChannels === "function"),
			GuildStore: this.getStore("GuildStore", m => m && typeof m.getGuild === "function"),
			UserStore: this.getStore("UserStore", m => m && typeof m.getUser === "function"),
			MessageStore: this.getStore("MessageStore", m => m && typeof m.getMessages === "function"),
			PrivateChannelSortStore: this.getStore("PrivateChannelSortStore", m => m && (typeof m.getPrivateChannelIds === "function" || typeof m.getSortedPrivateChannels === "function"))
		};
	}


	getDmDisplayName (channel) {
		if (!channel) return "DM";
		if (channel.name) return channel.name;
		const stores = this.getStores();
		let ids = [];
		try {
			if (Array.isArray(channel.recipients)) ids = channel.recipients.map(value => typeof value === "object" ? value.id : value).filter(Boolean);
			else if (typeof channel.getRecipientId === "function") {const id = channel.getRecipientId(); if (id) ids = [id];}
		}
		catch (_) {}
		const names = ids.map(id => {
			try {const user = stores.UserStore && stores.UserStore.getUser(String(id)); return user && (user.globalName || user.global_name || user.username);} catch (_) {return null;}
		}).filter(Boolean);
		if (names.length) return names.join(", ");
		return `DM ${String(channel.id || "").slice(-6)}`;
	}

	makeGuildScope (guild) {
		if (!guild || !guild.id) return null;
		return {type: "guild", sourceId: String(guild.id), cacheId: String(guild.id), name: guild.name || String(guild.id), guildId: String(guild.id), channelId: "", channel: null};
	}

	makeDmScope (channel) {
		if (!channel || !channel.id || ![1, 3].includes(Number(channel.type))) return null;
		return {type: "dm", sourceId: String(channel.id), cacheId: `dm_${String(channel.id)}`, name: this.getDmDisplayName(channel), guildId: "", channelId: String(channel.id), channel};
	}

	getCurrentScopeInfo () {
		const info = this.getCurrentGuildInfo();
		if (info.isDM && info.channelId) {
			const channel = info.channel || {id: info.channelId, type: 1};
			return this.makeDmScope(channel);
		}
		if (info.guildId) {
			const guild = info.stores && info.stores.GuildStore && info.stores.GuildStore.getGuild(info.guildId) || {id: info.guildId, name: info.guildName};
			return this.makeGuildScope(guild);
		}
		return null;
	}

	getActiveScopeInfo () {return this.targetScope || this.getCurrentScopeInfo();}

	findDmChannelForUser (userId) {
		if (!userId) return null;
		const stores = this.getStores();
		const found = [];
		const add = channel => {
			if (!channel || !channel.id || ![1, 3].includes(Number(channel.type))) return;
			const recipients = Array.isArray(channel.recipients) ? channel.recipients.map(value => String(typeof value === "object" ? value.id : value)) : [];
			let recipientId = "";
			try {recipientId = typeof channel.getRecipientId === "function" ? String(channel.getRecipientId() || "") : "";} catch (_) {}
			if (recipients.includes(String(userId)) || recipientId === String(userId)) found.push(channel);
		};
		try {
			const ids = stores.PrivateChannelSortStore && stores.PrivateChannelSortStore.getPrivateChannelIds && stores.PrivateChannelSortStore.getPrivateChannelIds();
			for (const id of ids || []) add(stores.ChannelStore && stores.ChannelStore.getChannel(String(id)));
		}
		catch (_) {}
		try {this.deepWalkChannels(stores.ChannelStore, add);} catch (_) {}
		if (found.length) return found[0];
		const current = this.getCurrentGuildInfo();
		if (current.isDM && current.channel) {
			const recipients = Array.isArray(current.channel.recipients) ? current.channel.recipients.map(value => String(typeof value === "object" ? value.id : value)) : [];
			if (recipients.includes(String(userId))) return current.channel;
		}
		return null;
	}

	resolveGuildContextTarget (props = {}) {
		const guild = props.guild || props.targetGuild || props.contextGuild;
		return this.makeGuildScope(guild);
	}

	resolveDmContextTarget (props = {}) {
		const stores = this.getStores();
		let channel = props.channel || props.targetChannel || props.contextChannel || null;
		const channelId = props.channelId || props.channel_id || null;
		if (!channel && channelId && stores.ChannelStore) {try {channel = stores.ChannelStore.getChannel(String(channelId));} catch (_) {}}
		if (channel) return [1, 3].includes(Number(channel.type)) ? this.makeDmScope(channel) : null;
		let onDmRoute = false;
		try {onDmRoute = /^\/channels\/@me(?:\/|$)/.test(String(location.pathname || ""));} catch (_) {}
		if (!onDmRoute) return null;
		const user = props.user || props.targetUser || props.contextUser;
		if (user && user.id) {
			channel = this.findDmChannelForUser(user.id);
			if (channel) return this.makeDmScope(channel);
		}
		return null;
	}

	appendContextMenuItem (tree, item) {
		if (!tree || !item) return;
		const props = tree.props || tree;
		if (!props || typeof props !== "object") return;
		if (Array.isArray(props.children)) props.children.push(item);
		else if (props.children == null) props.children = [item];
		else if (typeof props.children !== "function") props.children = [props.children, item];
	}

	getContextNodeLabel (node) {
		if (node == null) return "";
		if (typeof node === "string" || typeof node === "number") return String(node);
		const props = node.props || node;
		if (!props || typeof props !== "object") return "";
		for (const value of [props.label, props.name, props.text, props.children]) {
			if (typeof value === "string" || typeof value === "number") return String(value);
		}
		return "";
	}

	insertMessageContextMenuItem (tree, item) {
		if (!tree || !item) return;
		const arrays = [];
		const seen = new WeakSet();
		const walk = (value, depth = 0) => {
			if (!value || typeof value !== "object" || depth > 8) return;
			if (seen.has(value)) return;
			seen.add(value);
			if (Array.isArray(value)) {arrays.push(value); for (const child of value) walk(child, depth + 1); return;}
			const props = value.props || value;
			if (props && typeof props === "object") {
				if (Array.isArray(props.children)) arrays.push(props.children);
				if (props.children && typeof props.children !== "function") walk(props.children, depth + 1);
			}
		};
		walk(tree);
		const duplicate = arrays.some(array => array.some(node => String((node && (node.key || node.props && node.props.id)) || "").includes("chatlogexporter-message-range")));
		if (duplicate) return;
		let best = null;
		for (const array of arrays) {
			if (!Array.isArray(array) || !array.length) continue;
			const labels = array.map(node => this.getContextNodeLabel(node).toLowerCase());
			let index = labels.findIndex(label => /copy text|텍스트 복사|메시지 텍스트 복사/.test(label));
			if (index >= 0) {best = {array, index: index + 1, score: 4}; break;}
			index = labels.findIndex(label => /pin message|메시지 고정|apps|앱|mark unread|읽지 않음/.test(label));
			if (index >= 0 && (!best || best.score < 3)) best = {array, index, score: 3};
			else if (!best && labels.some(Boolean)) best = {array, index: array.length, score: 1};
		}
		if (best) best.array.splice(Math.max(0, best.index), 0, item);
		else this.appendContextMenuItem(tree, item);
	}

	buildScopeContextItem (scope) {
		if (!scope || !BdApi.ContextMenu || typeof BdApi.ContextMenu.buildItem !== "function") return null;
		return BdApi.ContextMenu.buildItem({
			type: "submenu",
			label: "ChatLogExporter",
			id: `chatlogexporter-${scope.type}-${scope.sourceId}`,
			items: [
				{label: "열기", action: () => this.openForScope(scope)},
				{label: "전체 수집", action: () => this.safeAction(`${scope.name} 전체 수집`, () => this.collectServer("full", scope))},
				{label: "최근 업데이트", action: () => this.safeAction(`${scope.name} 최근 업데이트`, () => this.collectServer("recent", scope))},
				{label: "내보내기", action: () => this.safeAction(`${scope.name} 내보내기`, () => this.exportCurrentServer(scope))},
				{type: "separator"},
				{label: "최근 수집 진단 복사", action: () => this.safeAction("최근 수집 진단 복사", () => this.copyLastCollectionDiagnostics(true))}
			]
		});
	}

	bindContextMenus () {
		for (const unpatch of this.contextUnpatches.splice(0)) {try {unpatch();} catch (_) {}}
		if (!BdApi.ContextMenu || typeof BdApi.ContextMenu.patch !== "function") return;
		const patch = (navId, resolver) => {
			try {
				const unpatch = BdApi.ContextMenu.patch(navId, (tree, props) => {
					try {
						const scope = resolver.call(this, props || {});
						if (!scope) return;
						this.appendContextMenuItem(tree, this.buildScopeContextItem(scope));
					}
					catch (error) {console.warn(`[ChatLogExporter] ${navId} context patch failed`, error);}
				});
				if (typeof unpatch === "function") this.contextUnpatches.push(unpatch);
			}
			catch (error) {console.warn(`[ChatLogExporter] Could not patch ${navId}`, error);}
		};
		patch("guild-context", this.resolveGuildContextTarget);
		for (const navId of ["user-context", "channel-context", "dm-context", "gdm-context"]) patch(navId, this.resolveDmContextTarget);

		// Discord changes the message menu navId between client builds. Patch
		// every known variant, then keep a DOM fallback below for builds whose
		// internal navId is not exposed to BetterDiscord.
		for (const navId of ["message", "message-context", "message-context-menu", "message-actions", "message-default"]) {
			try {
				const unpatch = BdApi.ContextMenu.patch(navId, (tree, props) => {
					try {
						const target = this.resolveMessageContextTarget(props || {});
						if (!target) return;
						this.insertMessageContextMenuItem(tree, this.buildMessageRangeContextItem(target));
					}
					catch (error) {console.warn(`[ChatLogExporter] ${navId} range context patch failed`, error);}
				});
				if (typeof unpatch === "function") this.contextUnpatches.push(unpatch);
			}
			catch (error) {console.warn(`[ChatLogExporter] Could not patch ${navId}`, error);}
		}
	}

	findMessageInContextProps (value) {
		const direct = value && [value.message, value.targetMessage, value.contextMessage, value.item && value.item.message, value.messageRecord].find(Boolean);
		if (direct) {
			try {return typeof direct.toJS === "function" ? direct.toJS() : direct;} catch (_) {return direct;}
		}
		const queue = [{value, depth: 0}];
		const seen = new WeakSet();
		let visited = 0;
		while (queue.length && visited++ < 350) {
			const current = queue.shift();
			let item = current.value;
			if (!item || typeof item !== "object" || current.depth > 6) continue;
			if (typeof Node !== "undefined" && item instanceof Node) continue;
			if (seen.has(item)) continue;
			seen.add(item);
			try {if (typeof item.toJS === "function") item = item.toJS();} catch (_) {}
			if (item && item.id && (item.channel_id || item.channelId) && (item.author || item.content != null || item.timestamp)) return item;
			for (const key of Object.keys(item)) {
				if (["children", "ref", "owner", "_owner", "return", "child", "sibling", "stateNode"].includes(key)) continue;
				let child;
				try {child = item[key];} catch (_) {continue;}
				if (child && typeof child === "object") queue.push({value: child, depth: current.depth + 1});
			}
		}
		return null;
	}

	findChannelInContextProps (value, channelId = "") {
		const direct = value && [value.channel, value.targetChannel, value.contextChannel, value.item && value.item.channel].find(Boolean);
		if (direct && (!channelId || String(direct.id || "") === String(channelId))) return direct;
		const queue = [{value, depth: 0}];
		const seen = new WeakSet();
		let visited = 0;
		while (queue.length && visited++ < 250) {
			const current = queue.shift();
			const item = current.value;
			if (!item || typeof item !== "object" || current.depth > 5) continue;
			if (typeof Node !== "undefined" && item instanceof Node) continue;
			if (seen.has(item)) continue;
			seen.add(item);
			if (item.id && item.type != null && (!channelId || String(item.id) === String(channelId))) return item;
			for (const key of Object.keys(item)) {
				if (["children", "ref", "owner", "_owner", "return", "child", "sibling", "stateNode"].includes(key)) continue;
				let child;
				try {child = item[key];} catch (_) {continue;}
				if (child && typeof child === "object") queue.push({value: child, depth: current.depth + 1});
			}
		}
		return null;
	}

	getMessageFromStore (channelId, messageId) {
		const stores = this.getStores();
		const store = stores.MessageStore;
		if (!store || !channelId || !messageId) return null;
		try {
			if (typeof store.getMessage === "function") {
				const found = store.getMessage(String(channelId), String(messageId));
				if (found) return typeof found.toJS === "function" ? found.toJS() : found;
			}
		}
		catch (_) {}
		try {
			const collection = store.getMessages && store.getMessages(String(channelId));
			if (!collection) return null;
			if (typeof collection.get === "function") {
				const found = collection.get(String(messageId));
				if (found) return typeof found.toJS === "function" ? found.toJS() : found;
			}
			let values = [];
			if (typeof collection.toArray === "function") values = collection.toArray();
			else if (Array.isArray(collection)) values = collection;
			else if (Array.isArray(collection._array)) values = collection._array;
			else if (collection._map && typeof collection._map.values === "function") values = Array.from(collection._map.values());
			const found = values.find(entry => String(entry && entry.id || "") === String(messageId));
			return found && typeof found.toJS === "function" ? found.toJS() : found || null;
		}
		catch (_) {return null;}
	}

	resolveMessageTargetFromParts (channelId, messageId, message = null, channel = null, root = null) {
		if (!channelId || !messageId) return null;
		const stores = this.getStores();
		if (!channel && stores.ChannelStore) {try {channel = stores.ChannelStore.getChannel(String(channelId));} catch (_) {}}
		if (!message) message = this.getMessageFromStore(channelId, messageId);
		if (!message && root) {
			const contentNode = root.querySelector && root.querySelector(`[id^="message-content-${messageId}"], [id="message-content-${messageId}"]`);
			const timeNode = root.querySelector && root.querySelector("time[datetime]");
			const authorNode = root.querySelector && root.querySelector('[class*="username"], [class*="headerText"] span');
			const authorName = authorNode && String(authorNode.textContent || "").trim() || "Unknown";
			message = {
				id: String(messageId), channel_id: String(channelId),
				content: contentNode && String(contentNode.textContent || "") || "",
				timestamp: timeNode && timeNode.getAttribute("datetime") || new Date().toISOString(),
				author: {id: "", username: authorName, global_name: authorName}
			};
		}
		if (!message || !channel) return null;
		let scope = null;
		if ([1, 3].includes(Number(channel.type)) || !(channel.guild_id || channel.guildId)) scope = this.makeDmScope(channel);
		else {
			const guildId = String(channel.guild_id || channel.guildId || "");
			let guild = null;
			try {guild = stores.GuildStore && stores.GuildStore.getGuild(guildId);} catch (_) {}
			scope = this.makeGuildScope(guild || {id: guildId, name: guildId});
		}
		if (!scope) return null;
		return {message, channel, channelId: String(channelId), scope};
	}

	resolveMessageContextTarget (props = {}) {
		let message = this.findMessageInContextProps(props);
		if (message && typeof message.toJS === "function") {try {message = message.toJS();} catch (_) {}}
		if (!message || !message.id) return null;
		const channelId = String(message.channel_id || message.channelId || props.channelId || props.channel_id || props.channel && props.channel.id || "");
		const channel = this.findChannelInContextProps(props, channelId);
		return this.resolveMessageTargetFromParts(channelId, String(message.id), message, channel);
	}

	resolveMessageContextFromElement (element) {
		if (!element || typeof element.closest !== "function") return null;
		const root = element.closest('[id^="chat-messages-"], [data-list-item-id^="chat-messages___"], [data-list-item-id*="chat-messages"]');
		if (!root) return null;
		let channelId = "";
		let messageId = "";
		const links = [];
		try {
			const closestLink = element.closest('a[href*="/channels/"]');
			if (closestLink) links.push(closestLink);
			for (const link of root.querySelectorAll('a[href*="/channels/"]')) if (!links.includes(link)) links.push(link);
		}
		catch (_) {}
		for (const link of links) {
			let pathname = "";
			try {pathname = new URL(link.href, location.origin).pathname;} catch (_) {pathname = String(link.getAttribute("href") || "");}
			const match = pathname.match(/^\/channels\/(?:@me|\d+)\/(\d+)\/(\d+)/);
			if (match) {channelId = match[1]; messageId = match[2]; break;}
		}
		if (!messageId) {
			for (const raw of [root.id, root.getAttribute("data-list-item-id"), root.getAttribute("aria-labelledby")]) {
				const ids = String(raw || "").match(/\d{15,22}/g) || [];
				if (ids.length >= 2) {channelId = ids[ids.length - 2]; messageId = ids[ids.length - 1]; break;}
				if (ids.length === 1) messageId = ids[0];
			}
		}
		if (!channelId) {
			const info = this.getCurrentGuildInfo();
			channelId = String(info.channelId || "");
		}
		return this.resolveMessageTargetFromParts(channelId, messageId, null, null, root);
	}

	bindMessageContextFallback () {
		if (this.messageContextDomHandler) document.removeEventListener("contextmenu", this.messageContextDomHandler, true);
		this.stopMessageContextWatch();
		this.messageContextDomHandler = event => {
			try {
				const target = this.resolveMessageContextFromElement(event.target);
				if (!target) return;
				this.pendingMessageContext = {target, x: Number(event.clientX || 0), y: Number(event.clientY || 0), time: Date.now(), injected: false};
				for (const delay of [0, 20, 60, 140, 300]) setTimeout(() => this.injectFallbackMessageRangeMenu(), delay);
				this.startMessageContextWatch();
			}
			catch (error) {console.warn("[ChatLogExporter] message context fallback failed", error);}
		};
		document.addEventListener("contextmenu", this.messageContextDomHandler, true);
	}

	// The observer only needs to run in the short window between a right-click and
	// Discord painting its menu. Leaving it attached to the whole document body
	// made it fire on every message, hover and typing keystroke in the client.
	startMessageContextWatch () {
		if (typeof MutationObserver !== "function" || !document.body) return;
		if (!this.messageContextObserver) this.messageContextObserver = new MutationObserver(() => this.injectFallbackMessageRangeMenu());
		else this.messageContextObserver.disconnect();
		this.messageContextObserver.observe(document.body, {childList: true, subtree: true});
		clearTimeout(this.messageContextWatchTimer);
		this.messageContextWatchTimer = setTimeout(() => this.stopMessageContextWatch(), 2500);
	}

	stopMessageContextWatch () {
		clearTimeout(this.messageContextWatchTimer);
		this.messageContextWatchTimer = null;
		if (this.messageContextObserver) this.messageContextObserver.disconnect();
	}

	getRangeMenuEntries (target) {
		const selection = this.rangeSelection;
		const sameChannel = !!(selection && String(selection.channelId) === String(target.channelId));
		const isStart = !!(sameChannel && selection.start && String(selection.start.id) === String(target.message.id));
		const isEnd = !!(sameChannel && selection.end && String(selection.end.id) === String(target.message.id));
		const entries = [
			{label: `${isStart ? "✓ " : ""}이 메시지를 시작점으로`, action: () => this.setRangeStart(target)},
			{label: `${isEnd ? "✓ " : ""}이 메시지를 끝점으로`, action: () => this.setRangeEnd(target)}
		];
		if (selection && selection.start && selection.end) entries.push({separator: true}, {label: "선택한 범위 열기", action: () => this.openRangeModal()});
		if (selection) entries.push({separator: true}, {label: "범위 선택 초기화", danger: true, action: () => this.clearRangeSelection()});
		return entries;
	}

	removeFallbackRangeSubmenu () {
		clearTimeout(this.fallbackRangeSubmenuCloseTimer);
		this.fallbackRangeSubmenuCloseTimer = null;
		if (this.fallbackRangeSubmenu) this.fallbackRangeSubmenu.remove();
		this.fallbackRangeSubmenu = null;
		for (const row of document.querySelectorAll('[data-chatlogexporter-range-fallback="true"]')) {
			row.classList.remove("is-active");
			row.setAttribute("aria-expanded", "false");
		}
	}

	// Our injected row is a plain DOM node inside Discord's React-rendered menu.
	// Discord highlights menu entries from a delegated pointer handler, so a hover
	// on a node it does not know about leaves its own rows stuck in the focused
	// state. Strip that state ourselves whenever the pointer is on our row.
	clearNativeMenuHighlight (row) {
		const menu = row && row.closest('[role="menu"]');
		if (!menu) return;
		for (const item of menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')) {
			if (item === row || item.closest('.cle-context-submenu')) continue;
			for (const token of Array.from(item.classList)) if (/^(focused|highlighted)/i.test(token)) item.classList.remove(token);
		}
		menu.removeAttribute("aria-activedescendant");
	}

	scheduleFallbackRangeSubmenuClose () {
		clearTimeout(this.fallbackRangeSubmenuCloseTimer);
		this.fallbackRangeSubmenuCloseTimer = setTimeout(() => this.removeFallbackRangeSubmenu(), 180);
	}

	makeFallbackSubmenuItem (entry) {
		if (entry.separator) {
			const separator = document.createElement("div");
			separator.className = "cle-context-separator";
			return separator;
		}
		const row = document.createElement("div");
		row.className = `cle-context-subitem${entry.danger ? " danger" : ""}`;
		row.setAttribute("role", "menuitem");
		row.setAttribute("tabindex", "-1");
		row.textContent = entry.label;
		const invoke = event => {
			event.preventDefault(); event.stopPropagation();
			this.removeFallbackRangeSubmenu();
			try {if (BdApi.ContextMenu && typeof BdApi.ContextMenu.close === "function") BdApi.ContextMenu.close();} catch (_) {}
			setTimeout(() => {try {entry.action();} catch (error) {this.reportError("메시지 범위 선택", error);}}, 0);
		};
		row.addEventListener("click", invoke, true);
		row.addEventListener("keydown", event => {if (event.key === "Enter" || event.key === " ") invoke(event);}, true);
		return row;
	}

	openFallbackRangeSubmenu (anchor, target) {
		clearTimeout(this.fallbackRangeSubmenuCloseTimer);
		this.removeFallbackRangeSubmenu();
		const submenu = document.createElement("div");
		submenu.className = "cle-context-submenu";
		submenu.setAttribute("role", "menu");
		for (const entry of this.getRangeMenuEntries(target)) submenu.appendChild(this.makeFallbackSubmenuItem(entry));
		document.body.appendChild(submenu);
		const anchorRect = anchor.getBoundingClientRect();
		const menuRect = submenu.getBoundingClientRect();
		const gap = 4;
		let left = anchorRect.right + gap;
		if (left + menuRect.width > window.innerWidth - 8) left = anchorRect.left - menuRect.width - gap;
		let top = anchorRect.top - 4;
		if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - menuRect.height - 8);
		submenu.style.left = `${Math.max(8, Math.round(left))}px`;
		submenu.style.top = `${Math.max(8, Math.round(top))}px`;
		submenu.addEventListener("mouseenter", () => clearTimeout(this.fallbackRangeSubmenuCloseTimer));
		submenu.addEventListener("mouseleave", () => this.scheduleFallbackRangeSubmenuClose());
		this.fallbackRangeSubmenu = submenu;
		if (anchor && anchor.classList) {
			anchor.classList.add("is-active");
			anchor.setAttribute("aria-expanded", "true");
			this.clearNativeMenuHighlight(anchor);
		}
	}

	makeFallbackRangeSubmenuRow (target) {
		const row = document.createElement("div");
		// Deliberately not cloning Discord's own item classes: they drag in the
		// client's hover/focus state rules and make the whole menu light up.
		row.className = "cle-context-parent-item";
		row.setAttribute("role", "menuitem");
		row.setAttribute("tabindex", "-1");
		row.setAttribute("aria-haspopup", "menu");
		row.setAttribute("aria-expanded", "false");
		row.dataset.chatlogexporterRangeFallback = "true";
		const label = document.createElement("span");
		label.className = "cle-context-parent-label";
		label.textContent = "ChatLogExporter 범위 선택";
		const arrow = document.createElement("span");
		arrow.className = "cle-context-parent-arrow";
		arrow.textContent = "›";
		row.replaceChildren(label, arrow);
		// Keep every bubbling pointer event inside our row so Discord's delegated
		// menu handler never sees a target it cannot resolve.
		for (const type of ["mouseover", "mouseout", "mousemove", "pointerover", "pointerout", "pointermove"]) {
			row.addEventListener(type, event => event.stopPropagation(), true);
		}
		const open = event => {
			if (event) {event.preventDefault(); event.stopPropagation();}
			this.clearNativeMenuHighlight(row);
			this.openFallbackRangeSubmenu(row, target);
		};
		row.addEventListener("mouseenter", open);
		row.addEventListener("mouseleave", () => this.scheduleFallbackRangeSubmenuClose());
		row.addEventListener("click", open, true);
		row.addEventListener("keydown", event => {if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") open(event);}, true);
		return row;
	}

	findFallbackInsertionPoint (menu) {
		const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(item => !item.closest('.cle-context-submenu') && item.offsetParent !== null);
		if (!items.length) return {container: menu, before: null, reference: null};
		const normalize = item => String(item.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
		const copy = items.find(item => /copy text|텍스트 복사|메시지 텍스트 복사/.test(normalize(item)));
		if (copy && copy.parentElement) return {container: copy.parentElement, before: copy.nextSibling, reference: copy};
		const next = items.find(item => /pin message|메시지 고정|apps|앱|mark unread|읽지 않음/.test(normalize(item)));
		if (next && next.parentElement) return {container: next.parentElement, before: next, reference: next};
		const reference = items[Math.min(3, items.length - 1)];
		return {container: reference.parentElement || menu, before: reference.nextSibling, reference};
	}

	injectFallbackMessageRangeMenu () {
		const pending = this.pendingMessageContext;
		if (!pending || pending.injected || Date.now() - pending.time > 2500) {this.stopMessageContextWatch(); return;}
		const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(menu => {
			if (menu.classList.contains("cle-context-submenu")) return false;
			const rect = menu.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		});
		if (!menus.length) return;
		const distance = menu => {
			const rect = menu.getBoundingClientRect();
			const dx = pending.x < rect.left ? rect.left - pending.x : pending.x > rect.right ? pending.x - rect.right : 0;
			const dy = pending.y < rect.top ? rect.top - pending.y : pending.y > rect.bottom ? pending.y - rect.bottom : 0;
			return dx * dx + dy * dy;
		};
		menus.sort((a, b) => distance(a) - distance(b));
		const menu = menus[0];
		if (!menu) return;
		if (String(menu.textContent || "").includes("ChatLogExporter 범위 선택") || document.querySelector('[data-chatlogexporter-range-fallback="true"]')) {
			pending.injected = true;
			this.stopMessageContextWatch();
			return;
		}
		const point = this.findFallbackInsertionPoint(menu);
		const row = this.makeFallbackRangeSubmenuRow(pending.target);
		point.container.insertBefore(row, point.before || null);
		pending.injected = true;
		this.stopMessageContextWatch();
	}

	buildMessageRangeContextItem (target) {
		if (!target || !BdApi.ContextMenu || typeof BdApi.ContextMenu.buildItem !== "function") return null;
		// Each item needs a UNIQUE id. Discord's menu tracks the hovered/focused
		// row by id, so items that share an id (or all lack one) light up together
		// — that is the "두 버튼이 같이 하이라이트" bug. Index-based ids fix it.
		const items = this.getRangeMenuEntries(target).map((entry, i) => entry.separator
			? {type: "separator", id: `chatlogexporter-range-sep-${i}`}
			: {id: `chatlogexporter-range-item-${i}`, label: entry.label, danger: !!entry.danger, action: entry.action});
		return BdApi.ContextMenu.buildItem({
			type: "submenu",
			label: "ChatLogExporter 범위 선택",
			id: `chatlogexporter-message-range-${target.channelId}-${target.message.id}`,
			items
		});
	}

	snapshotRangeMessage (target) {
		const manifest = this.readManifest(target.scope.cacheId, target.scope.name, target.scope);
		const rawChannel = target.channel && typeof target.channel.toJS === "function" ? target.channel.toJS() : target.channel;
		const rawMessage = target.message && typeof target.message.toJS === "function" ? target.message.toJS() : target.message;
		return this.normalizeMessage(rawMessage, manifest, rawChannel);
	}

	makeRangeSelectionBase (target) {
		return {
			scope: Object.assign({}, target.scope),
			channelId: String(target.channelId),
			channel: target.channel && typeof target.channel.toJS === "function" ? target.channel.toJS() : target.channel,
			start: null, end: null, messages: null, loading: false, error: ""
		};
	}

	finishRangeEndpointSelection () {
		const selection = this.rangeSelection;
		this.removeRangeModal();
		if (selection && selection.start && selection.end) {
			this.openRangeModal();
			this.safeAction("선택 범위 불러오기", () => this.loadRangeSelection());
		}
	}

	setRangeStart (target) {
		try {
			const snapshot = this.snapshotRangeMessage(target);
			const sameChannel = !!(this.rangeSelection && String(this.rangeSelection.channelId) === String(target.channelId));
			if (!sameChannel) this.rangeSelection = this.makeRangeSelectionBase(target);
			this.rangeSelection.scope = Object.assign({}, target.scope);
			this.rangeSelection.channel = target.channel && typeof target.channel.toJS === "function" ? target.channel.toJS() : target.channel;
			this.rangeSelection.start = {id: String(target.message.id), snapshot};
			this.rangeSelection.messages = null;
			this.rangeSelection.error = "";
			BdApi.UI.showToast(this.rangeSelection.end ? "시작점을 지정했어. 선택 범위를 불러올게." : "시작점을 지정했어. 끝 메시지도 같은 메뉴에서 선택해줘.", {type: "success"});
			this.finishRangeEndpointSelection();
		}
		catch (error) {this.reportError("범위 시작점 선택", error);}
	}

	setRangeEnd (target) {
		try {
			const snapshot = this.snapshotRangeMessage(target);
			const sameChannel = !!(this.rangeSelection && String(this.rangeSelection.channelId) === String(target.channelId));
			if (!sameChannel) this.rangeSelection = this.makeRangeSelectionBase(target);
			this.rangeSelection.scope = Object.assign({}, target.scope);
			this.rangeSelection.channel = target.channel && typeof target.channel.toJS === "function" ? target.channel.toJS() : target.channel;
			this.rangeSelection.end = {id: String(target.message.id), snapshot};
			this.rangeSelection.messages = null;
			this.rangeSelection.error = "";
			BdApi.UI.showToast(this.rangeSelection.start ? "끝점을 지정했어. 선택 범위를 불러올게." : "끝점을 지정했어. 시작 메시지도 같은 메뉴에서 선택해줘.", {type: "success"});
			this.finishRangeEndpointSelection();
		}
		catch (error) {this.reportError("범위 끝점 선택", error);}
	}

	clearRangeSelection () {
		this.rangeSelection = null;
		this.removeRangeModal();
		BdApi.UI.showToast("메시지 범위 선택을 초기화했어.", {type: "info"});
	}

	removeRangeModal () {
		if (this.rangeModal) this.rangeModal.remove();
		this.rangeModal = null;
		if (this.rangeEscHandler) document.removeEventListener("keydown", this.rangeEscHandler, true);
		this.rangeEscHandler = null;
	}

	openRangeModal () {
		const selection = this.rangeSelection;
		if (!selection || !selection.start || !selection.end) return;
		this.removeRangeModal();
		const overlay = document.createElement("div"); overlay.id = "chatlogexporter-range-overlay";
		const modal = document.createElement("div"); modal.className = "cle-range-modal";
		const head = document.createElement("div"); head.className = "cle-range-head";
		const title = document.createElement("strong"); title.textContent = "메시지 범위 내보내기";
		const close = document.createElement("button"); close.type = "button"; close.className = "cle-range-close"; close.textContent = "×"; close.title = "닫기 (Esc)"; close.setAttribute("aria-label", "범위 내보내기 창 닫기"); close.addEventListener("click", () => this.removeRangeModal());
		head.append(title, close);
		const summary = document.createElement("div"); summary.className = "cle-range-summary";
		const channelName = this.getChannelName(selection.channel) || selection.channelId;
		summary.textContent = `${selection.scope.name} · ${channelName}\n시작 ${this.formatDate(selection.start.snapshot.timestamp)}  →  끝 ${this.formatDate(selection.end.snapshot.timestamp)}`;
		const status = document.createElement("div"); status.className = "cle-range-status"; status.textContent = selection.loading ? "선택 구간을 불러오는 중..." : selection.messages ? `${selection.messages.length.toLocaleString()}개 메시지 선택됨` : "선택 구간을 불러올 준비 중...";
		const preview = document.createElement("pre"); preview.className = "cle-range-preview"; preview.textContent = selection.messages ? this.formatRangeClipboard(selection.messages).slice(0, 5000) : "";
		const row = document.createElement("div"); row.className = "cle-range-actions";
		const copy = this.makeButton("클립보드에 복사", "");
		const format = document.createElement("select"); format.className = "cle-select";
		for (const [value, label] of [["ai_zip", "AI 범위 ZIP"], ["txt", "TXT"], ["markdown", "Markdown"], ["jsonl", "JSONL"], ["csv", "CSV"]]) {const option = document.createElement("option"); option.value = value; option.textContent = label; format.appendChild(option);}
		const save = this.makeButton("파일로 내보내기", "secondary");
		const reset = this.makeButton("선택 초기화", "danger");
		const ready = !!(selection.messages && selection.messages.length && !selection.loading);
		copy.disabled = !ready; save.disabled = !ready;
		copy.addEventListener("click", () => this.safeAction("선택 범위 복사", () => this.copySelectedRange()));
		save.addEventListener("click", () => this.safeAction("선택 범위 내보내기", () => this.exportSelectedRange(format.value)));
		reset.addEventListener("click", () => this.clearRangeSelection());
		row.append(copy, format, save, reset);
		const shotRow = document.createElement("div"); shotRow.className = "cle-range-actions";
		const shot = this.makeButton("📷 스크린샷 만들기", "");
		shot.disabled = !ready;
		shot.title = "선택한 범위를 디스코드 채팅 화면 그대로 긴 이미지로 만들어서 복사하거나 저장해";
		shot.addEventListener("click", () => this.safeAction("스크린샷 만들기", () => this.captureSelectedRange()));
		const shotNote = document.createElement("div"); shotNote.className = "cle-range-summary"; shotNote.style.margin = "2px 0 0"; shotNote.textContent = "눌러야 이미지가 만들어져. 완성되면 미리보기에서 복사·저장할 수 있어.";
		shotRow.append(shot);
		modal.append(head, summary, status, preview, row, shotRow, shotNote); overlay.appendChild(modal);
		overlay.addEventListener("mousedown", event => {if (event.target === overlay) this.removeRangeModal();});
		document.body.appendChild(overlay);
		this.rangeModal = overlay;
		this.rangeEscHandler = event => {
			if (event.key !== "Escape" || !this.rangeModal) return;
			event.preventDefault(); event.stopPropagation();
			this.removeRangeModal();
		};
		document.addEventListener("keydown", this.rangeEscHandler, true);
	}

	async readChannelRangeMessages (cacheId, channelId, olderId, newerId, onProgress = null) {
		const file = this.getChannelDataPath(cacheId, channelId);
		if (!this.fs.existsSync(file)) return [];
		let fileSize = 0; try {fileSize = Number(this.fs.statSync(file).size) || 0;} catch (_) {}
		const map = new Map();
		const acceptLine = rawLine => {
			const line = String(rawLine || "").replace(/\r$/, "");
			if (!line.trim()) return;
			try {
				const message = JSON.parse(line);
				if (!message || !message.id) return;
				if (this.compareSnowflakes(message.id, olderId) < 0 || this.compareSnowflakes(message.id, newerId) > 0) return;
				map.set(String(message.id), message);
			}
			catch (_) {}
		};
		if (this.fs && typeof this.fs.createReadStream === "function") {
			await new Promise((resolve, reject) => {
				let remainder = "", bytesRead = 0, lastAt = 0;
				const input = this.fs.createReadStream(file, {encoding: "utf8"});
				input.on("data", chunk => {
					const chunkText = String(chunk); bytesRead += Buffer.byteLength(chunkText, "utf8"); remainder += chunkText;
					let newline = remainder.indexOf("\n");
					while (newline >= 0) {acceptLine(remainder.slice(0, newline)); remainder = remainder.slice(newline + 1); newline = remainder.indexOf("\n");}
					const now = Date.now(); if (typeof onProgress === "function" && now - lastAt >= 200) {lastAt = now; onProgress(fileSize ? bytesRead / fileSize : 0);}
				});
				input.once("error", reject); input.once("end", () => {acceptLine(remainder); if (typeof onProgress === "function") onProgress(1); resolve();});
			});
		}
		else {for (const line of String(this.fs.readFileSync(file, "utf8")).split(/\n/)) acceptLine(line); if (typeof onProgress === "function") onProgress(1);}
		return Array.from(map.values());
	}

	async fetchRangeMessages (selection, olderId, newerId, manifest, channel) {
		const bundle = this.getHttpBundle();
		if (!bundle) throw new Error("Discord 메시지 요청 모듈을 찾지 못했어.");
		const map = new Map();
		const pageSize = Math.max(1, Math.min(100, Number(this.settings.pageSize) || 100));
		let before = String(newerId);
		let pages = 0;
		const usedCursors = new Set();
		while (pages < 100000) {
			if (usedCursors.has(before)) break;
			usedCursors.add(before);

			// v2.4.2 accidentally called a non-existent helper here. The thrown
			// TypeError was swallowed by loadRangeSelection(), leaving only the two
			// endpoint snapshots in the result. Use the same proven fetch path as
			// full log collection instead.
			const batch = await this.fetchMessages(bundle, selection.channelId, pageSize, before);
			if (!Array.isArray(batch) || !batch.length) break;

			let oldestBatchId = null;
			for (const raw of batch) {
				if (!raw || !raw.id) continue;
				const message = this.normalizeMessage(raw, manifest, channel);
				if (!oldestBatchId || this.compareSnowflakes(message.id, oldestBatchId) < 0) oldestBatchId = message.id;
				if (this.compareSnowflakes(message.id, olderId) >= 0 && this.compareSnowflakes(message.id, newerId) <= 0) {
					map.set(String(message.id), message);
				}
			}

			pages++;
			if (this.rangeSelection) {
				this.rangeSelection.loadingText = `Discord에서 선택 범위 불러오는 중 · ${map.size.toLocaleString()}개 · ${pages.toLocaleString()}페이지`;
				this.openRangeModal();
			}

			if (!oldestBatchId || this.compareSnowflakes(oldestBatchId, olderId) <= 0 || batch.length < pageSize) break;
			before = String(oldestBatchId);
			await this.sleep(this.settings.fetchDelayMs);
		}
		return Array.from(map.values());
	}

	async loadRangeSelection () {
		const selection = this.rangeSelection;
		if (!selection || !selection.start || !selection.end || selection.loading) return;
		selection.loading = true; selection.error = ""; this.openRangeModal();
		try {
			const olderId = this.compareSnowflakes(selection.start.id, selection.end.id) <= 0 ? selection.start.id : selection.end.id;
			const newerId = olderId === selection.start.id ? selection.end.id : selection.start.id;
			const manifest = this.readManifest(selection.scope.cacheId, selection.scope.name, selection.scope);
			const channelState = manifest.channels && manifest.channels[String(selection.channelId)] || {id: selection.channelId, name: this.getChannelName(selection.channel), type: Number(selection.channel && selection.channel.type || 0), typeLabel: this.channelTypeLabel(selection.channel)};
			const map = new Map();
			for (const endpoint of [selection.start.snapshot, selection.end.snapshot]) if (endpoint && endpoint.id) map.set(String(endpoint.id), endpoint);
			const cached = await this.readChannelRangeMessages(selection.scope.cacheId, selection.channelId, olderId, newerId, ratio => {selection.loadingText = `로컬 캐시 검색 중 · ${Math.round(ratio * 100)}%`; if (Math.round(ratio * 100) % 5 === 0) this.openRangeModal();});
			for (const message of cached) map.set(String(message.id), message);
			const hasOlder = map.has(String(olderId)), hasNewer = map.has(String(newerId));
			let rangeFetchError = null;
			if ((!hasOlder || !hasNewer || cached.length <= 2) && olderId !== newerId) {
				try {
					const fetched = await this.fetchRangeMessages(selection, olderId, newerId, manifest, channelState);
					for (const message of fetched) map.set(String(message.id), message);
				}
				catch (error) {
					rangeFetchError = error;
					console.warn("[ChatLogExporter] Range API fallback failed", error);
				}
			}
			selection.messages = Array.from(map.values()).filter(message => this.compareSnowflakes(message.id, olderId) >= 0 && this.compareSnowflakes(message.id, newerId) <= 0).sort((a, b) => this.compareSnowflakes(a.id, b.id));
			selection.rangeFetchError = rangeFetchError ? String(rangeFetchError && (rangeFetchError.stack || rangeFetchError.message) || rangeFetchError) : "";
			selection.manifest = manifest; selection.channelState = channelState;
			if (!selection.messages.length) throw new Error("선택한 두 메시지 사이의 로그를 찾지 못했어. 먼저 해당 채널의 로그를 수집해줘.");
		}
		catch (error) {selection.error = error && (error.stack || error.message) || String(error); await this.reportError("선택 범위 불러오기", error);}
		finally {selection.loading = false; selection.loadingText = ""; this.openRangeModal();}
	}

	getRangeMessageBody (message) {
		const parts = [];
		if (String(message.content || "")) parts.push(String(message.content));
		if (message.attachments && message.attachments.length) parts.push(...message.attachments.map(item => `[첨부파일: ${item.filename || "file"}${item.url ? ` · ${item.url}` : ""}]`));
		if (message.embeds && message.embeds.length) parts.push(...message.embeds.map(embed => `[임베드: ${[embed.title, embed.description, embed.url].filter(Boolean).join(" — ") || "내용 없음"}]`));
		if (message.sticker_items && message.sticker_items.length) parts.push(...message.sticker_items.map(item => `[스티커: ${item.name || item.id || "sticker"}]`));
		return parts.length ? parts.join("\n") : "(내용 없음)";
	}

	formatRangeClipboard (messages) {
		const ordered = [...(messages || [])].sort((a, b) => this.compareSnowflakes(a.id, b.id));
		const dayKey = value => {const d = new Date(value); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : "";};
		const days = new Set(ordered.map(message => dayKey(message.timestamp)));
		const showDates = days.size > 1;
		const lines = [];
		let previous = null, previousDay = "";
		for (const message of ordered) {
			const author = message.author || {};
			const authorId = String(author.id || author.username || "Unknown");
			const display = author.global_name || author.globalName || author.username || "Unknown";
			const date = new Date(message.timestamp);
			const currentDay = dayKey(message.timestamp);
			if (showDates && currentDay !== previousDay) {if (lines.length) lines.push(""); lines.push(date.toLocaleDateString("en-US", {year: "numeric", month: "long", day: "numeric"})); previous = null;}
			const grouped = previous && previous.authorId === authorId && previous.day === currentDay && Math.abs(date.getTime() - previous.time) <= 7 * 60 * 1000;
			if (!grouped) lines.push(`${display} — ${date.toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", hour12: true})}`);
			lines.push(this.getRangeMessageBody(message));
			previous = {authorId, day: currentDay, time: date.getTime()}; previousDay = currentDay;
		}
		return lines.join("\n").trim();
	}

	formatRangeMarkdown (selection) {
		const messages = selection.messages || [];
		const channelName = this.getChannelName(selection.channel) || selection.channelId;
		const lines = [`# Discord message range`, "", `- Conversation: ${selection.scope.name}`, `- Channel: ${channelName}`, `- Messages: ${messages.length}`, `- Start: ${messages[0] ? messages[0].timestamp : ""}`, `- End: ${messages.length ? messages[messages.length - 1].timestamp : ""}`, "", "---", ""];
		for (const message of messages) {
			const author = message.author || {}; const display = author.global_name || author.username || "Unknown";
			lines.push(`### ${this.escapeMarkdown(display)} — ${this.formatDate(message.timestamp)}`, "", this.getRangeMessageBody(message), "");
		}
		return lines.join("\n");
	}

	async copySelectedRange () {
		const selection = this.rangeSelection;
		if (!selection || !selection.messages || !selection.messages.length) return;
		const copied = await this.copyText(this.formatRangeClipboard(selection.messages));
		BdApi.UI.showToast(copied ? `${selection.messages.length.toLocaleString()}개 메시지를 클립보드에 복사했어.` : "클립보드 복사에 실패했어.", {type: copied ? "success" : "error"});
	}

	buildRangeUsers (messages) {
		const users = {};
		for (const message of messages || []) {const a = message.author || {}; const id = String(a.id || a.username || "unknown"); if (!users[id]) users[id] = {id, username: a.username || "", display_names: [], bot: !!a.bot, message_count: 0}; const display = a.global_name || a.username || "Unknown"; if (!users[id].display_names.includes(display)) users[id].display_names.push(display); users[id].message_count++;}
		return users;
	}

	async exportSelectedRange (format = "ai_zip") {
		const selection = this.rangeSelection;
		if (!selection || !selection.messages || !selection.messages.length) return;
		this.fs.mkdirSync(this.getOutputFolder(), {recursive: true});
		const messages = selection.messages;
		const manifest = selection.manifest || this.readManifest(selection.scope.cacheId, selection.scope.name, selection.scope);
		const channel = selection.channelState || {id: selection.channelId, name: this.getChannelName(selection.channel), type: Number(selection.channel && selection.channel.type || 0), typeLabel: this.channelTypeLabel(selection.channel)};
		const base = `${this.sanitizeFileName(selection.scope.name)}_${this.sanitizeFileName(channel.name || selection.channelId)}_Range_${this.formatFileTimestamp(new Date())}`;
		let output = "";
		if (format === "txt") {output = this.path.join(this.getOutputFolder(), `${base}.txt`); this.fs.writeFileSync(output, this.formatRangeClipboard(messages), "utf8");}
		else if (format === "markdown") {output = this.path.join(this.getOutputFolder(), `${base}.md`); this.fs.writeFileSync(output, this.formatRangeMarkdown(selection), "utf8");}
		else if (format === "jsonl") {output = this.path.join(this.getOutputFolder(), `${base}.jsonl`); this.fs.writeFileSync(output, messages.map(message => JSON.stringify(this.buildAiMessageRecord(message, manifest, channel))).join("\n") + "\n", "utf8");}
		else if (format === "csv") {
			output = this.path.join(this.getOutputFolder(), `${base}.csv`); const rows = [["timestamp", "display_name", "username", "user_id", "message_id", "content", "reply_to", "attachments"]];
			for (const message of messages) {const a = message.author || {}; const ref = message.referenced_message || message.message_reference || {}; rows.push([message.timestamp, a.global_name || a.username || "Unknown", a.username || "", a.id || "", message.id, message.content || "", ref.id || ref.message_id || "", (message.attachments || []).map(item => item.url || item.filename || "").join(" ; ")]);}
			this.fs.writeFileSync(output, "\uFEFF" + rows.map(row => row.map(value => this.csvEscape(value)).join(",")).join("\n"), "utf8");
		}
		else {
			const temp = this.path.join(this.getCacheRoot(), `.range-export-${Date.now()}-${Math.random().toString(16).slice(2)}`); this.fs.mkdirSync(temp, {recursive: true});
			const records = messages.map(message => this.buildAiMessageRecord(message, manifest, channel));
			const rangeManifest = {format: "ChatLogExporter AI Range Archive", version: "1.0", exported_at: new Date().toISOString(), scope: {type: selection.scope.type, id: selection.scope.sourceId, name: selection.scope.name}, channel: this.buildAiChannelRecord(channel, manifest), selection: {inclusive: true, first_message_id: messages[0].id, last_message_id: messages[messages.length - 1].id, message_count: messages.length, start_timestamp: messages[0].timestamp, end_timestamp: messages[messages.length - 1].timestamp}, files: {"messages.jsonl": "One structured message per line", "conversation.md": "Chronological readable transcript", "users.json": "Stable user identity map"}};
			this.fs.writeFileSync(this.path.join(temp, "manifest.json"), JSON.stringify(rangeManifest, null, 2), "utf8");
			this.fs.writeFileSync(this.path.join(temp, "users.json"), JSON.stringify(this.buildRangeUsers(messages), null, 2), "utf8");
			this.fs.writeFileSync(this.path.join(temp, "messages.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
			this.fs.writeFileSync(this.path.join(temp, "conversation.md"), this.formatRangeMarkdown(selection), "utf8");
			output = this.path.join(this.getOutputFolder(), `${base}_AI.zip`); await this.createStoredZip(temp, output); try {this.fs.rmSync(temp, {recursive: true, force: true});} catch (_) {}
		}
		this.showPersistentNotice("선택 범위 내보내기 완료", this.path.basename(output), this.path.dirname(output));
		BdApi.UI.showToast(`${messages.length.toLocaleString()}개 메시지를 내보냈어.`, {type: "success"});
	}

	// ---------------------------------------------------------------------------
	// Screenshot export (real on-screen capture).
	// Captures the ACTUAL rendered Discord message rows — cloned with their real
	// computed styles and the real (re-embedded) fonts, rasterized through an SVG
	// <foreignObject> → canvas. So the user's theme, Nitro fonts, avatars, badges,
	// markdown, replies, embeds, emoji and stickers appear as shown. html2canvas
	// was dropped: in the Discord desktop app its internal iframe never finished
	// loading, hanging forever. Because Discord virtualizes the list, it
	// auto-scrolls from the first selected message to the last, capturing ONE strip
	// per screenful (fast even for huge ranges), then stitches them into one long
	// image (split into several files when very tall). Images are pre-fetched to
	// data URLs so the output canvas is never cross-origin tainted, and every
	// rasterize has a hard timeout so it can never hang. Channel must be open.
	// ---------------------------------------------------------------------------

	async captureSelectedRange () {
		const selection = this.rangeSelection;
		if (!selection || !selection.messages || !selection.messages.length) {
			BdApi.UI.showToast("먼저 선택 범위를 불러와줘.", {type: "info"});
			return;
		}
		if (this.shotBusy) {BdApi.UI.showToast("이미 스크린샷을 만드는 중이야.", {type: "info"}); return;}
		const channelId = String(selection.channelId || "");
		if (channelId && !String(location.pathname || "").includes(channelId)) {
			BdApi.UI.showToast("먼저 그 채널을 화면에 열어줘. 캡처할 대화가 보여야 해.", {type: "error"});
			return;
		}
		const olderId = this.compareSnowflakes(selection.start.id, selection.end.id) <= 0 ? selection.start.id : selection.end.id;
		const newerId = String(olderId) === String(selection.start.id) ? selection.end.id : selection.start.id;

		this.shotBusy = true;
		this.shotImgCache = this.shotImgCache || new Map();
		this.removeRangeModal();
		const progress = this.showShotProgress("스크린샷 만드는 중...");
		let savedScroller = null, savedScrollTop = null;
		try {
			const located = this.findMessageScroller(channelId, olderId, newerId);
			if (!located) throw new Error("화면에서 메시지 목록을 찾지 못했어. 그 채널이 열려 있는지 확인해줘.");
			savedScroller = located.scroller; savedScrollTop = located.scroller.scrollTop;
			this.updateShotProgress(progress, "폰트·스타일 준비 중...");
			const fontCss = await this.buildFontEmbedCss(located.list);
			const bg = this.resolveListBg(located.list);
			const messages = [...selection.messages].sort((a, b) => this.compareSnowflakes(a.id, b.id));
			const result = await this.captureRangeStrips({scroller: located.scroller, list: located.list, channelId, olderId, newerId, fontCss, bg, messages, onProgress: t => this.updateShotProgress(progress, t)});
			if (result.cancelled) {BdApi.UI.showToast("스크린샷을 취소했어.", {type: "info"}); return;}
			if (!result.strips.length) throw new Error("캡처할 메시지를 찾지 못했어. 선택한 채널이 맞는지 확인해줘.");
			this.updateShotProgress(progress, "이미지 이어붙이는 중...");
			const dataUrls = this.stitchStrips(result.strips, bg);
			if (!dataUrls.length) throw new Error("이미지를 만들지 못했어.");
			try {this.fs.mkdirSync(this.getCacheRoot(), {recursive: true}); dataUrls.forEach((u, i) => this.fs.writeFileSync(this.path.join(this.getCacheRoot(), `last-shot-${String(i + 1).padStart(2, "0")}.png`), Buffer.from(String(u).replace(/^data:image\/png;base64,/, ""), "base64")));} catch (_) {}
			const channelName = this.getChannelName(selection.channel) || channelId;
			const base = `${this.sanitizeFileName(selection.scope.name)}_${this.sanitizeFileName(channelName)}_Screenshot_${this.formatFileTimestamp(new Date())}`;
			this.showScreenshotPreview(dataUrls, base, result.messageCount);
		}
		catch (error) {
			await this.reportError("스크린샷 만들기", error);
			BdApi.UI.showToast(`스크린샷 실패: ${error && error.message ? error.message : error}`, {type: "error"});
		}
		finally {
			if (savedScroller && savedScrollTop != null) {try {savedScroller.scrollTop = savedScrollTop;} catch (_) {}}
			this.removeShotProgress(progress);
			this.shotBusy = false;
		}
	}

	// Locate Discord's scrollable message container and its row list.
	findMessageScroller (channelId, olderId, newerId) {
		let anchor = this.getRowEl(channelId, olderId) || this.getRowEl(channelId, newerId);
		let list = anchor ? anchor.closest('ol[data-list-id^="chat-messages"], ol[class*="scrollerInner"]') : null;
		if (!list) list = document.querySelector('ol[data-list-id^="chat-messages"]') || document.querySelector('ol[class*="scrollerInner"]');
		if (!list) return null;
		const scroller = list.closest('div[class*="scroller"]') || list.parentElement;
		if (!scroller) return null;
		return {scroller, list};
	}

	getRowEl (channelId, messageId) {
		return document.getElementById(`chat-messages-${channelId}-${messageId}`) || document.getElementById(`chat-messages-${messageId}`);
	}

	parseRowMessageId (rowEl) {
		const direct = String(rowEl.id || "").match(/^chat-messages-(?:\d+-)?(\d+)$/);
		if (direct) return direct[1];
		const child = rowEl.querySelector('[id^="chat-messages-"]');
		if (child) {const m = String(child.id || "").match(/^chat-messages-(?:\d+-)?(\d+)$/); if (m) return m[1];}
		return null;
	}

	resolveListBg (el) {
		let node = el;
		while (node && node !== document.documentElement) {
			let bg = "";
			try {bg = getComputedStyle(node).backgroundColor;} catch (_) {}
			if (bg && bg !== "transparent" && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) return bg;
			node = node.parentElement;
		}
		return "#313338";
	}

	sleepShot (ms) {return new Promise(resolve => setTimeout(resolve, ms));}

	// URL that an image-bearing node points at. Discord draws avatars as SVG
	// <image> (masked), not <img>, so we must read href/xlink:href too.
	imgNodeUrl (node) {
		try {
			const tag = (node.tagName || "").toLowerCase();
			if (tag === "img") return node.currentSrc || node.src || node.getAttribute("src") || "";
			if (tag === "image") {
				if (node.href && node.href.baseVal) return node.href.baseVal;
				return node.getAttribute("href") || node.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
			}
		}
		catch (_) {}
		return "";
	}

	// Collect every http(s) image URL in the subtree — <img>, SVG <image>, and
	// url(...) background images (avatars/role-icons sometimes use these) — and
	// pre-fetch them to data URLs so the SVG render has no cross-origin request.
	async prefetchRowImages (el) {
		const urls = new Set();
		try {
			for (const node of el.querySelectorAll("img, image")) {const u = this.imgNodeUrl(node); if (/^https?:\/\//i.test(u)) urls.add(u);}
			for (const node of [el, ...el.querySelectorAll("*")]) {
				let bg = ""; try {bg = getComputedStyle(node).backgroundImage;} catch (_) {}
				if (!bg || bg.indexOf("url(") < 0) continue;
				const m = /url\(\s*(['"]?)(https?:[^'")]+)\1\s*\)/i.exec(bg);
				if (m) urls.add(m[2]);
			}
		}
		catch (_) {}
		const jobs = [];
		for (const u of urls) {
			if (this.shotImgCache.has(u)) continue;
			this.shotImgCache.set(u, null);
			jobs.push(this.fetchImageDataUrl(u, {maxBytes: 8 * 1024 * 1024, timeout: 10000})
				.then(data => {this.shotImgCache.set(u, data || null); if (this.shotImgStats) {if (data) this.shotImgStats.ok++; else this.shotImgStats.fail++;}})
				.catch(() => {this.shotImgCache.set(u, null); if (this.shotImgStats) this.shotImgStats.fail++;}));
		}
		if (jobs.length) await Promise.all(jobs);
	}

	async buildFontEmbedCss (list) {
		if (this.shotFontCss != null) return this.shotFontCss;
		const wanted = new Set();
		try {
			const fam = getComputedStyle(list || document.body).fontFamily || "";
			for (let name of fam.split(",")) {name = name.trim().replace(/^['"]|['"]$/g, "").toLowerCase(); if (name && !/^(sans-serif|serif|monospace|system-ui|ui-|-apple|blinkmac|segoe|roboto|helvetica|arial|emoji)/.test(name)) wanted.add(name);}
		}
		catch (_) {}
		const faces = [];
		try {
			for (const sheet of Array.from(document.styleSheets || [])) {
				let rules = null; try {rules = sheet.cssRules;} catch (_) {continue;}
				if (!rules) continue;
				for (const rule of Array.from(rules)) {
					if (rule && rule.type === 5 && rule.style) {
						const fam = rule.style.getPropertyValue("font-family");
						const bare = String(fam || "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
						if (wanted.size && !wanted.has(bare)) continue;
						const src = rule.style.getPropertyValue("src");
						if (fam && src) faces.push({fam, src, weight: rule.style.getPropertyValue("font-weight") || "normal", style: rule.style.getPropertyValue("font-style") || "normal", base: sheet.href || document.baseURI});
					}
				}
			}
		}
		catch (_) {}
		const pick = []; const seen = new Set();
		for (const f of faces) {
			if (f.style && f.style !== "normal") continue;
			const m = /url\(\s*(['"]?)([^'")]+\.woff2[^'")]*)\1\s*\)/i.exec(f.src) || /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(f.src);
			if (!m) continue;
			let u = m[2];
			const key = f.fam + "|" + f.weight;
			if (seen.has(key)) continue; seen.add(key);
			if (!/^data:/i.test(u)) {try {u = new URL(u, f.base).href;} catch (_) {continue;}}
			pick.push({fam: f.fam, weight: f.weight, style: f.style, url: u});
			if (pick.length >= 6) break;
		}
		const collected = [];
		const tasks = pick.map(async f => {
			let data = f.url;
			if (!/^data:/i.test(data)) {data = await this.fetchImageDataUrl(f.url, {maxBytes: 2 * 1024 * 1024, timeout: 3000}).catch(() => null);}
			if (data) collected.push(`@font-face{font-family:${f.fam};font-style:${f.style};font-weight:${f.weight};src:url(${data});}`);
		});
		await Promise.race([Promise.allSettled(tasks), this.sleepShot(3000)]);
		this.shotFontCss = collected.join("\n");
		return this.shotFontCss;
	}

	// Deep-clone a live element, baking every computed style into inline style.
	// getComputedStyle(el).cssText returns "" in Chromium, so we build it by
	// iterating properties. Skips display:none subtrees and external url() in
	// backgrounds/masks/custom-vars; swaps <img>/<image> to pre-fetched data URLs.
	cloneWithInlineStyles (srcEl) {
		const BLANK = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
		const SKIP_TAGS = {SCRIPT: 1, NOSCRIPT: 1, TEMPLATE: 1, LINK: 1, META: 1};
		const SKIP_PROP = /^(animation|transition|cursor|pointer-events|user-select|-webkit-user-|-webkit-tap|-webkit-font-smoothing|-webkit-locale|-webkit-text-size-adjust|caret-color|accent-color|scroll-|overscroll|touch-action|will-change|contain|content-visibility|speak|resize|appearance|-webkit-appearance|tab-size|-webkit-box-reflect|view-transition|anchor-|field-sizing|-webkit-rtl-ordering|-webkit-highlight)/;
		const swapImageUrl = (clone, src) => {
			const key = this.imgNodeUrl(src);
			if (!key || /^data:/i.test(key)) return;
			const data = this.shotImgCache.get(key) || BLANK;
			if ((src.tagName || "").toLowerCase() === "image") {
				clone.setAttribute("href", data);
				try {clone.setAttributeNS("http://www.w3.org/1999/xlink", "href", data);} catch (_) {}
			}
			else {clone.setAttribute("src", data); clone.removeAttribute("srcset"); try {clone.srcset = "";} catch (_) {}}
		};
		const build = src => {
			if (src.nodeType === 3) return document.createTextNode(src.nodeValue);
			if (src.nodeType !== 1) return null;
			if (SKIP_TAGS[src.tagName]) return null;
			let cs = null; try {cs = getComputedStyle(src);} catch (_) {}
			if (cs && cs.display === "none") return null;
			const clone = src.cloneNode(false);
			if (cs) {
				try {
					let txt = "";
					for (let i = 0; i < cs.length; i++) {
						const p = cs[i];
						if (SKIP_PROP.test(p)) continue;
						const v = cs.getPropertyValue(p);
						if (p.charCodeAt(0) === 45 && p.charCodeAt(1) === 45 && v.indexOf("url(") >= 0) continue;
						txt += p + ":" + v + ";";
					}
					clone.style.cssText = txt;
					const bi = clone.style.backgroundImage;
					if (bi && bi.indexOf("url(") >= 0) {
						const m = /url\(\s*(['"]?)(https?:[^'")]+)\1\s*\)/i.exec(bi);
						const data = m && this.shotImgCache.get(m[2]);
						clone.style.backgroundImage = data ? `url(${data})` : "none";
					}
					const mi = clone.style.getPropertyValue("mask-image"); if (mi && mi.indexOf("url(") >= 0) clone.style.setProperty("mask-image", "none");
					const wm = clone.style.getPropertyValue("-webkit-mask-image"); if (wm && wm.indexOf("url(") >= 0) clone.style.setProperty("-webkit-mask-image", "none");
				}
				catch (_) {}
			}
			const tag = (clone.tagName || "").toLowerCase();
			if (tag === "img" || tag === "image") {
				try {swapImageUrl(clone, src);} catch (_) {}
			}
			else if (clone.tagName === "CANVAS" || clone.tagName === "VIDEO") {
				try {
					const w = src.clientWidth || 0, h = src.clientHeight || 0;
					const img = document.createElement("img");
					img.setAttribute("style", clone.style.cssText);
					try {if (src.tagName === "CANVAS") img.setAttribute("src", src.toDataURL("image/png"));} catch (_) {}
					if (!img.getAttribute("src")) img.setAttribute("src", BLANK);
					if (w) img.width = w; if (h) img.height = h;
					return img;
				}
				catch (_) {}
			}
			for (const child of Array.from(src.childNodes)) {
				const cc = build(child);
				if (cc) clone.appendChild(cc);
			}
			return clone;
		};
		return build(srcEl) || srcEl.cloneNode(false);
	}

	// Rasterize the TEXT/STYLE layer via SVG <foreignObject>, then draw the images
	// on top with canvas drawImage (Chromium does not render nested <img> inside a
	// rasterized foreignObject — that is why avatars were blank).
	async rasterizeStripHost (host, width, height, bg, fontCss) {
		const imgJobs = [];
		try {
			const hostRect = host.getBoundingClientRect();
			for (const im of host.querySelectorAll("img, image")) {
				const src = im.getAttribute("src") || im.getAttribute("href") || "";
				if (!/^data:/i.test(src)) continue;
				const r = im.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) continue;
				let radius = 0; try {radius = parseFloat(getComputedStyle(im).borderTopLeftRadius) || 0;} catch (_) {}
				imgJobs.push({src, x: r.left - hostRect.left, y: r.top - hostRect.top, w: r.width, h: r.height, radius});
			}
		}
		catch (_) {}
		// Render with a bottom buffer so the last message is never clipped when the
		// SVG's (embedded-font) metrics differ slightly from the page's, then trim
		// the blank buffer away so strips stay contiguous. This fixes "메시지가 잘려".
		const buffer = Math.round(height * 0.22) + 64;
		const canvas = await this.rasterizeSvgLayer(host, width, height + buffer, bg, fontCss);
		if (!canvas) return null;
		if (imgJobs.length) {
			const scale = canvas.width / width;
			const ctx = canvas.getContext("2d");
			await Promise.all(imgJobs.map(j => new Promise(res => {
				const im = new Image();
				let done = false; const fin = () => {if (!done) {done = true; clearTimeout(tm); res();}}; const tm = setTimeout(fin, 8000);
				im.onload = () => {
					try {
						const x = j.x * scale, y = j.y * scale, w = j.w * scale, h = j.h * scale;
						ctx.save();
						if (j.radius >= Math.min(j.w, j.h) / 2 - 1.5) {ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2); ctx.clip();}
						else if (j.radius > 1) {const rr = j.radius * scale; ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.clip();}
						ctx.drawImage(im, x, y, w, h);
						ctx.restore();
					}
					catch (_) {}
					fin();
				};
				im.onerror = fin;
				im.src = j.src;
			})));
		}
		return this.removeBlankBands(canvas, bg);
	}

	// Remove large blank horizontal bands anywhere in the strip (the render buffer
	// and any gap from host/SVG height mismatch), while keeping normal message
	// spacing. Fixes the blank gaps regardless of what caused them.
	removeBlankBands (canvas, bg, maxGap = 28) {
		try {
			const w = canvas.width, h = canvas.height;
			const ctx = canvas.getContext("2d");
			const data = ctx.getImageData(0, 0, w, h).data;
			// Sample the ACTUAL background from the rendered canvas (a top corner is
			// almost always the margin). Trusting the passed bg string failed when it
			// didn't match the rendered color, so nothing got trimmed → blank gaps.
			let br, bgb, bb;
			{const px = (2 * w + (w - 3)) * 4; br = data[px]; bgb = data[px + 1]; bb = data[px + 2];
			if (br === undefined) [br, bgb, bb] = this.parseRgb(bg);}
			const isBlank = y => {
				const base = y * w * 4;
				let c = 0;
				for (let x = 0; x < w; x += 2) {
					const i = base + x * 4;
					if (Math.abs(data[i] - br) > 10 || Math.abs(data[i + 1] - bgb) > 10 || Math.abs(data[i + 2] - bb) > 10) {if (++c >= 4) return false;}
				}
				return true;
			};
			const keep = []; // [start,end) row ranges to copy
			let y = 0;
			while (y < h) {
				if (!isBlank(y)) {const s = y; while (y < h && !isBlank(y)) y++; keep.push([s, y]);}
				else {const s = y; while (y < h && isBlank(y)) y++; const cap = Math.min(y - s, maxGap); if (cap > 0) keep.push([s, s + cap]);}
			}
			let totalH = keep.reduce((n, r) => n + (r[1] - r[0]), 0);
			// trim a trailing kept-blank band entirely (no blank at the very bottom)
			if (keep.length && isBlank(keep[keep.length - 1][0])) {totalH -= (keep[keep.length - 1][1] - keep[keep.length - 1][0]); keep.pop();}
			if (totalH <= 0 || totalH >= h) return canvas;
			const out = document.createElement("canvas");
			out.width = w; out.height = totalH;
			const octx = out.getContext("2d");
			let dy = 0;
			for (const [s, e] of keep) {octx.drawImage(canvas, 0, s, w, e - s, 0, dy, w, e - s); dy += (e - s);}
			return out;
		}
		catch (_) {return canvas;}
	}

	parseRgb (color) {
		const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(String(color || ""));
		return m ? [+m[1], +m[2], +m[3]] : [49, 51, 56];
	}

	rasterizeSvgLayer (host, width, height, bg, fontCss) {
		return new Promise(resolve => {
			let inner = "";
			try {const xs = new XMLSerializer(); for (const child of Array.from(host.children)) inner += xs.serializeToString(child);}
			catch (_) {return resolve(null);}
			const fontStyle = fontCss ? `<style>${fontCss}</style>` : "";
			const wrap = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px; background:${bg || "#313338"};">${fontStyle}${inner}</div>`;
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${wrap}</foreignObject></svg>`;
			const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
			const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
			const img = new Image();
			let done = false;
			const finish = v => {if (done) return; done = true; clearTimeout(timer); resolve(v);};
			const timer = setTimeout(() => finish(null), 15000);
			img.onload = () => {
				try {
					const canvas = document.createElement("canvas");
					canvas.width = Math.max(1, Math.round(width * scale));
					canvas.height = Math.max(1, Math.round(height * scale));
					const ctx = canvas.getContext("2d");
					ctx.scale(scale, scale);
					ctx.fillStyle = bg || "#313338";
					ctx.fillRect(0, 0, width, height);
					ctx.drawImage(img, 0, 0);
					finish(canvas);
				}
				catch (_) {finish(null);}
			};
			img.onerror = () => finish(null);
			img.src = url;
		});
	}

	// A real date / "new messages" divider row. Discord puts role="separator" and
	// a divider_* class ON THE ROW ITSELF (not a descendant), e.g.
	// <div role="separator" class="divider_… hasContent_…" aria-label="November 19, 2026">.
	isRealDivider (row) {
		try {
			if (!String(row.textContent || "").trim()) return false;
			if (row.getAttribute && row.getAttribute("role") === "separator") return true;
			if (/divider/i.test(row.className || "")) return true;
			return !!(row.querySelector && row.querySelector('[role="separator"], [class*="divider"]'));
		}
		catch (_) {return false;}
	}

	// A loading skeleton row = an unloaded block of messages Discord draws as a
	// fixed-height wrapper (e.g. <div class="wrapper_…" style="height:1469px">) with
	// aria-hidden skeleton content and no chat-messages id. We must scroll into
	// these and WAIT for them to load, never capture or skip them.
	isSkeletonRow (row) {
		try {
			if (this.parseRowMessageId(row)) return false;
			if (this.isRealDivider(row)) return false;
			if (/placeholder|skeleton/i.test(row.className || "")) return true;
			const h = parseFloat((row.style && row.style.height) || "") || 0;
			if (h > 40) return true; // fixed-height unloaded block
			if (h === 0 && !String(row.textContent || "").trim() && row.querySelector && row.querySelector('[aria-hidden="true"][class*="avatar"], [class*="placeholder"]')) return true;
			return false;
		}
		catch (_) {return false;}
	}

	// Use Discord's own "jump to message" to navigate to an arbitrary message: it
	// loads that message WITH context and lets us scroll away from it normally —
	// the reliable way to reach the end of a long range (scrolling down toward it
	// doesn't load newer messages when we're parked up in history).
	jumpMod () {
		if (!this._jumpMod) {try {this._jumpMod = BdApi.Webpack.getModule(m => m && (typeof m.jumpToMessage === "function" || typeof m.jumpToPresent === "function"));} catch (_) {}}
		return this._jumpMod;
	}
	jumpToMessage (channelId, messageId) {
		try {const m = this.jumpMod(); if (m && m.jumpToMessage) {m.jumpToMessage({channelId: String(channelId), messageId: String(messageId), flash: false}); return true;}}
		catch (_) {}
		return false;
	}
	// Return to the live/present view. Only from here does scrolling up reliably
	// load older history indefinitely; after a mid-history jump it stops.
	jumpToPresent (channelId) {
		try {const m = this.jumpMod(); if (m && m.jumpToPresent) {m.jumpToPresent(String(channelId)); return true;}}
		catch (_) {}
		return false;
	}

	// Capture the range by JUMPING across it. Programmatic scrolling only makes
	// Discord load ~1-2 batches of history before it stops, so long ranges can't be
	// walked by scrolling. But we already have every message id in the range, and
	// Discord's jumpToMessage reliably loads ANY message with its surrounding
	// window. So we jump to successive points across the range, capture the loaded
	// window at each (scrolling only WITHIN what the jump loaded), and advance past
	// everything captured — covering the whole range regardless of length. Each
	// jump recreates the list DOM, so we re-find the scroller/list every time.
	async captureRangeStrips ({scroller: initScroller, list: initList, channelId, olderId, newerId, fontCss, bg, messages, onProgress}) {
		const strips = [];
		this._stripDbg = [];
		const capturedIds = new Set();
		const capturedDiv = new Set();
		// Store a STYLED CLONE of every captured row keyed by id. We render nothing
		// during the jump-scan (jumps capture messages out of order and interleaved);
		// afterwards we sort all clones by id and render contiguous strips, so the
		// output is in order with no gaps.
		const clones = new Map();     // id → cloned element (message)
		const divClones = new Map();  // "beforeId" → cloned divider element
		const defaultWidth = (initList && initList.clientWidth) || (initScroller && initScroller.clientWidth) || 700;
		const sorted = [...(messages || [])].sort((a, b) => this.compareSnowflakes(a.id, b.id));
		if (!sorted.length) return {strips, messageCount: 0, reachedStart: false, reachedEnd: false, iters: 0};

		const locate = () => {
			let l = null;
			try {l = document.querySelector('ol[data-list-id^="chat-messages"], ol[class*="scrollerInner"]');} catch (_) {}
			if ((!l || !document.body.contains(l)) && initList && document.body.contains(initList)) l = initList;
			if (!l) return null;
			const s = l.closest('div[class*="scroller"]') || l.parentElement;
			return s ? {scroller: s, list: l} : null;
		};
		const hasSkeletonIn = list => {try {for (const r of list.children) if (this.isSkeletonRow(r)) return true;} catch (_) {} return false;};
		const settle = async (list, maxMs = 2200) => {
			const t0 = Date.now();
			while (Date.now() - t0 < maxMs) {if (this.shotCancel) return; if (!hasSkeletonIn(list)) return; await this.sleepShot(110);}
		};
		const captureVisible = async list => {
			const rows = Array.from(list.children);
			let pendingDiv = [], added = 0;
			for (const row of rows) {
				const mid = this.parseRowMessageId(row);
				if (mid) {
					const inRange = this.compareSnowflakes(mid, olderId) >= 0 && this.compareSnowflakes(mid, newerId) <= 0;
					if (inRange) {
						for (const d of pendingDiv) {const dk = `${mid}:${d.text}`; if (!capturedDiv.has(dk)) {capturedDiv.add(dk); try {divClones.set(mid + "\u0000" + d.text, this.cloneWithInlineStyles(d.el));} catch (_) {}}}
						pendingDiv = [];
						if (!capturedIds.has(mid)) {
							capturedIds.add(mid);
							await this.prefetchRowImages(row).catch(() => {});
							try {clones.set(mid, this.cloneWithInlineStyles(row)); added++;} catch (_) {}
						}
					}
					else pendingDiv = [];
				}
				else if (this.isRealDivider(row)) {
					const text = String(row.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
					pendingDiv.push({el: row, text});
				}
			}
			return added;
		};

		// --- Capture phase: jump across the range, store clones. ---
		const total = sorted.length;
		let i = 0, jumps = 0;
		while (i < total) {
			if (this.shotCancel) return {strips, messageCount: capturedIds.size, cancelled: true, reachedStart: capturedIds.has(String(olderId)), reachedEnd: capturedIds.has(String(newerId)), iters: jumps};
			const prevI = i;
			const targetId = String(sorted[i].id);
			if (!this.getRowEl(channelId, targetId)) {
				this.jumpToMessage(channelId, targetId);
				jumps++;
				for (let w = 0; w < 60 && !this.getRowEl(channelId, targetId); w++) {if (this.shotCancel) break; await this.sleepShot(140);}
			}
			let loc = locate();
			if (loc) {
				const el = this.getRowEl(channelId, targetId);
				if (el) {try {el.scrollIntoView({block: "start"});} catch (_) {} await this.sleepShot(160);}
				for (let k = 0; k < 16; k++) {
					if (this.shotCancel) break;
					loc = locate() || loc;
					await settle(loc.list, 1600);
					await captureVisible(loc.list);
					if (onProgress) onProgress(`캡처 중 · ${capturedIds.size.toLocaleString()} / ${total.toLocaleString()}개`);
					const s = loc.scroller, before = s.scrollTop;
					s.scrollTop = Math.min(s.scrollHeight, s.scrollTop + Math.round((s.clientHeight || 600) * 0.82));
					await this.sleepShot(120);
					if (s.scrollTop - before < 2) break;
					if (hasSkeletonIn(loc.list)) break;
				}
			}
			while (i < total && capturedIds.has(String(sorted[i].id))) i++;
			if (i === prevI) i++;
		}
		const messageCount = capturedIds.size;

		// --- Render phase: sort clones by id, render contiguous strips. ---
		if (onProgress) onProgress("이미지 만드는 중...");
		const ordered = [];
		for (const id of [...clones.keys()].sort((a, b) => this.compareSnowflakes(a, b))) {
			// a date divider that precedes this message
			for (const [dk, dv] of divClones) {if (dk.split("\u0000")[0] === id) {ordered.push({clone: dv, orderId: id}); divClones.delete(dk);}}
			ordered.push({clone: clones.get(id), orderId: id});
		}
		const TARGET = Math.max(800, Math.min(4000, Math.round((Number(this.settings.shotMaxHeight) || 15000) / 4)));
		const host = document.createElement("div");
		host.setAttribute("style", `position:fixed; left:-99999px; top:0; width:${defaultWidth}px; background:${bg || "#313338"}; z-index:-2147483647; pointer-events:none;`);
		document.body.appendChild(host);
		let curOrderId = null, curCount = 0;
		const flush = async () => {
			if (!host.firstChild) return;
			const w = Math.max(1, Math.round(host.offsetWidth || defaultWidth));
			const h = Math.max(1, Math.round(host.offsetHeight || 1));
			let canvas = null;
			try {canvas = await this.rasterizeStripHost(host, w, h, bg, fontCss);} catch (_) {}
			if (canvas) {strips.push({canvas, orderId: curOrderId}); this._stripDbg.push(`#${strips.length} rows=${curCount} measuredH=${h} finalH=${canvas.height}`);}
			while (host.firstChild) host.removeChild(host.firstChild);
			curOrderId = null; curCount = 0;
		};
		for (const item of ordered) {
			if (this.shotCancel) break;
			if (!item.clone) continue;
			if (curOrderId === null) curOrderId = item.orderId;
			host.appendChild(item.clone);
			curCount++;
			if (host.offsetHeight >= TARGET) await flush();
		}
		await flush();
		try {host.remove();} catch (_) {}

		return {strips, messageCount, reachedStart: capturedIds.has(String(olderId)), reachedEnd: capturedIds.has(String(newerId)), iters: jumps};
	}

	stitchStrips (strips, bg) {
		const items = [...strips].sort((a, b) => this.compareSnowflakes(a.orderId, b.orderId));
		if (!items.length) return [];
		const width = items.reduce((max, s) => Math.max(max, s.canvas.width), 0) || 1;
		const maxHeight = Math.max(1500, Math.min(30000, Number(this.settings.shotMaxHeight) || 15000));
		const groups = []; let current = [], currentHeight = 0;
		for (const s of items) {const h = s.canvas.height; if (current.length && currentHeight + h > maxHeight) {groups.push(current); current = []; currentHeight = 0;} current.push(s); currentHeight += h;}
		if (current.length) groups.push(current);
		const out = [];
		for (const group of groups) {
			const total = group.reduce((n, s) => n + s.canvas.height, 0) || 1;
			const canvas = document.createElement("canvas");
			canvas.width = width; canvas.height = total;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = bg || "#313338"; ctx.fillRect(0, 0, width, total);
			let y = 0; for (const s of group) {ctx.drawImage(s.canvas, 0, y); y += s.canvas.height;}
			// Final safeguard: collapse any residual blank (between strips or trailing)
			// on the fully-stitched image, so the output never ends on an empty band.
			const trimmed = this.removeBlankBands(canvas, bg);
			// Give the bottom the same small breathing room Discord shows under the last
			// message (otherwise the image ends flush against the last line of text).
			const pad = 16;
			const padded = document.createElement("canvas");
			padded.width = trimmed.width; padded.height = trimmed.height + pad;
			const pctx = padded.getContext("2d");
			let fill = bg || "#313338";
			try {const d = trimmed.getContext("2d").getImageData(trimmed.width - 3, 2, 1, 1).data; fill = `rgb(${d[0]},${d[1]},${d[2]})`;} catch (_) {}
			pctx.fillStyle = fill; pctx.fillRect(0, 0, padded.width, padded.height);
			pctx.drawImage(trimmed, 0, 0);
			out.push(padded.toDataURL("image/png"));
		}
		return out;
	}

	// Full-screen overlay that BOTH shows progress AND blocks the user from
	// scrolling/clicking Discord mid-capture (our programmatic scrollTop still
	// works — it's a property set, not an event). Esc or the button cancels.
	showShotProgress (text) {
		this.removeShotProgress(this.shotProgress);
		this.shotCancel = false;
		const overlay = this.shotEl("div", "position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.35); cursor:progress; font-family:var(--font-primary,sans-serif);");
		overlay.id = "chatlogexporter-shot-progress";
		const card = this.shotEl("div", "display:flex; flex-direction:column; align-items:center; gap:12px; padding:22px 28px; border-radius:12px; background:#111214; color:#f2f3f5; border:1px solid rgba(255,255,255,.14); box-shadow:0 12px 36px rgba(0,0,0,.55);");
		const rowTop = this.shotEl("div", "display:flex; align-items:center; gap:10px; font:600 14px/1.4 var(--font-primary,sans-serif);");
		const spinner = this.shotEl("div", "width:16px; height:16px; border-radius:50%; border:2px solid rgba(255,255,255,.25); border-top-color:#5865f2; animation:cle-spin .7s linear infinite;");
		const label = this.shotEl("span", "", text || "");
		rowTop.append(spinner, label);
		const hint = this.shotEl("div", "font-size:12px; color:#949ba4;", "캡처가 끝날 때까지 기다려줘. (Esc = 취소)");
		const cancelBtn = this.shotEl("button", "margin-top:2px; border:0; border-radius:6px; padding:7px 14px; background:#35373c; color:#f2f3f5; font-weight:600; cursor:pointer;", "취소");
		cancelBtn.addEventListener("click", () => {this.shotCancel = true;});
		card.append(rowTop, hint, cancelBtn);
		overlay.appendChild(card);
		// Swallow every wheel / pointer / touch interaction on the overlay.
		const swallow = event => {event.preventDefault(); event.stopPropagation();};
		for (const type of ["wheel", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "touchstart", "touchmove", "touchend"]) overlay.addEventListener(type, swallow, {passive: false});
		// Block keyboard too (except Esc to cancel), captured before Discord sees it.
		const keyBlock = event => {
			if (event.key === "Escape") {this.shotCancel = true; event.preventDefault(); event.stopPropagation(); return;}
			event.preventDefault(); event.stopPropagation();
		};
		document.addEventListener("keydown", keyBlock, true);
		overlay._keyBlock = keyBlock;
		overlay._label = label;
		document.body.appendChild(overlay);
		this.shotProgress = overlay;
		return overlay;
	}
	updateShotProgress (box, text) {if (box && box._label) box._label.textContent = text || "";}
	removeShotProgress (box) {
		const target = box || this.shotProgress;
		if (target) {try {if (target._keyBlock) document.removeEventListener("keydown", target._keyBlock, true);} catch (_) {} try {target.remove();} catch (_) {}}
		if (target === this.shotProgress) this.shotProgress = null;
	}

	shotEl (tag, style, text) {
		const node = document.createElement(tag);
		if (style) node.setAttribute("style", style);
		if (text != null) node.textContent = String(text);
		return node;
	}

	arrayBufferToBase64 (buf) {
		let bin = ""; const bytes = new Uint8Array(buf); const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		return btoa(bin);
	}

	async fetchImageDataUrl (url, {timeout = 12000, maxBytes = 8 * 1024 * 1024} = {}) {
		// 1) BetterDiscord's network API. Uses Chromium's net stack (has the system
		// CA certs and bypasses CORS/CSP), so it works inside the Discord renderer
		// where raw node https fails TLS — that was why avatars didn't download.
		try {
			if (BdApi.Net && typeof BdApi.Net.fetch === "function") {
				const res = await BdApi.Net.fetch(url, {headers: {"User-Agent": "Mozilla/5.0", "Accept": "image/*,*/*"}, timeout});
				if (res && res.ok && typeof res.arrayBuffer === "function") {
					const buf = await res.arrayBuffer();
					if (buf && buf.byteLength && buf.byteLength <= maxBytes) {
						let type = "image/png"; try {type = (res.headers.get("content-type") || type).split(";")[0].trim() || "image/png";} catch (_) {}
						return `data:${type};base64,${this.arrayBufferToBase64(buf)}`;
					}
				}
			}
		}
		catch (_) {}
		// 2) node https (works in a plain node process; may fail TLS in the renderer).
		const viaNode = await this.fetchImageViaNode(url, timeout, maxBytes);
		if (viaNode) return viaNode;
		// 3) plain fetch (last resort; may be CORS-blocked).
		try {
			const res = await fetch(url);
			if (res.ok) {
				const buf = await res.arrayBuffer();
				if (buf.byteLength <= maxBytes) {
					let type = "image/png"; try {type = (res.headers.get("content-type") || type).split(";")[0].trim() || "image/png";} catch (_) {}
					return `data:${type};base64,${this.arrayBufferToBase64(buf)}`;
				}
			}
		}
		catch (_) {}
		return null;
	}

	fetchImageViaNode (url, timeout, maxBytes) {
		return new Promise(resolve => {
			let settled = false;
			const done = value => {if (!settled) {settled = true; resolve(value);}};
			const tryGet = (target, depth) => {
				if (depth > 4) return done(null);
				let parsed;
				try {parsed = new URL(target);}
				catch (_) {return done(null);}
				let mod;
				try {mod = parsed.protocol === "http:" ? require("http") : require("https");}
				catch (_) {return done(null);}
				let req;
				try {
					req = mod.get(target, {headers: {"User-Agent": "Mozilla/5.0", "Accept": "image/*,*/*"}}, res => {
						const status = res.statusCode || 0;
						if (status >= 300 && status < 400 && res.headers.location) {res.resume(); let next; try {next = new URL(res.headers.location, target).href;} catch (_) {return done(null);} return tryGet(next, depth + 1);}
						if (status !== 200) {res.resume(); return done(null);}
						const type = String(res.headers["content-type"] || "image/png").split(";")[0].trim() || "image/png";
						const chunks = []; let size = 0;
						res.on("data", chunk => {size += chunk.length; if (size > maxBytes) {done(null); try {res.destroy();} catch (_) {} return;} chunks.push(chunk);});
						res.on("end", () => {if (settled) return; try {done(`data:${type};base64,${Buffer.concat(chunks).toString("base64")}`);} catch (_) {done(null);}});
						res.on("error", () => done(null));
					});
				}
				catch (_) {return done(null);}
				req.on("error", () => done(null));
				try {req.setTimeout(timeout, () => {try {req.destroy();} catch (_) {} done(null);});}
				catch (_) {}
			};
			tryGet(url, 0);
		});
	}

	async copyImageDataUrl (dataUrl) {
		// Preferred: Electron native clipboard (most reliable in the desktop app).
		try {
			const {clipboard, nativeImage} = require("electron");
			if (clipboard && nativeImage) {
				const image = nativeImage.createFromDataURL(dataUrl);
				if (image && !image.isEmpty()) {clipboard.writeImage(image); return true;}
			}
		}
		catch (error) {console.warn("[ChatLogExporter] electron clipboard failed", error);}
		// Fallback: async Clipboard API with a PNG blob.
		try {
			if (navigator.clipboard && typeof navigator.clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
				const res = await fetch(dataUrl);
				const blob = await res.blob();
				await navigator.clipboard.write([new ClipboardItem({[blob.type || "image/png"]: blob})]);
				return true;
			}
		}
		catch (error) {console.warn("[ChatLogExporter] async clipboard failed", error);}
		return false;
	}

	saveScreenshotImages (dataUrls, base) {
		this.fs.mkdirSync(this.getOutputFolder(), {recursive: true});
		const paths = [];
		for (let i = 0; i < dataUrls.length; i++) {
			const suffix = dataUrls.length > 1 ? `_${String(i + 1).padStart(2, "0")}` : "";
			const output = this.path.join(this.getOutputFolder(), `${base}${suffix}.png`);
			const b64 = String(dataUrls[i]).replace(/^data:image\/png;base64,/, "");
			this.fs.writeFileSync(output, Buffer.from(b64, "base64"));
			paths.push(output);
		}
		return paths;
	}

	showScreenshotPreview (dataUrls, base, messageCount) {
		if (this.shotOverlay) {try {this.shotOverlay.remove();} catch (_) {}}
		const overlay = this.shotEl("div", "position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box; background:rgba(0,0,0,.72); font-family:var(--font-primary,sans-serif);");
		overlay.id = "chatlogexporter-shot-overlay";
		const modal = this.shotEl("div", "width:min(820px,calc(100vw - 48px)); max-height:calc(100vh - 48px); display:flex; flex-direction:column; box-sizing:border-box; border:1px solid rgba(255,255,255,.12); border-radius:10px; background:#18181c; color:#dbdee1; box-shadow:0 12px 36px rgba(0,0,0,.55);");

		const head = this.shotEl("div", "display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px 10px; color:#f2f3f5; font-size:16px; font-weight:700;");
		head.appendChild(this.shotEl("span", "", `스크린샷 미리보기 · ${Number(messageCount || 0).toLocaleString()}개 메시지${dataUrls.length > 1 ? ` · ${dataUrls.length}장` : ""}`));
		const close = this.shotEl("button", "width:30px; height:30px; border:0; border-radius:50%; background:transparent; color:#949ba4; font-size:24px; line-height:1; cursor:pointer;", "×");
		const removeOverlay = () => {try {overlay.remove();} catch (_) {} this.shotOverlay = null; if (this.shotEscHandler) document.removeEventListener("keydown", this.shotEscHandler, true); this.shotEscHandler = null;};
		close.addEventListener("click", removeOverlay);
		head.appendChild(close);

		const scroller = this.shotEl("div", "flex:1 1 auto; overflow:auto; margin:0 16px; padding:8px; background:#111114; border:1px solid rgba(255,255,255,.08); border-radius:7px;");
		for (const dataUrl of dataUrls) {
			scroller.appendChild(this.shotEl("img", "display:block; width:100%; height:auto; border-radius:4px; margin-bottom:8px;")).setAttribute("src", dataUrl);
		}

		const row = this.shotEl("div", "display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 16px 16px;");
		const copyBtn = this.makeButton(dataUrls.length > 1 ? "클립보드 복사(첫 장)" : "클립보드 복사", "");
		const saveBtn = this.makeButton("파일로 저장", "secondary");
		const openBtn = this.makeButton("폴더 열기", "secondary");
		copyBtn.addEventListener("click", async () => {
			const ok = await this.copyImageDataUrl(dataUrls[0]);
			if (ok && dataUrls.length > 1) BdApi.UI.showToast(`${dataUrls.length}장 중 첫 장을 복사했어. 전체는 '파일로 저장'을 눌러줘.`, {type: "success"});
			else BdApi.UI.showToast(ok ? "이미지를 클립보드에 복사했어." : "클립보드 복사에 실패했어. '파일로 저장'을 이용해줘.", {type: ok ? "success" : "error"});
		});
		saveBtn.addEventListener("click", () => this.safeAction("스크린샷 저장", () => {
			const paths = this.saveScreenshotImages(dataUrls, base);
			this.showPersistentNotice("스크린샷 저장 완료", `${paths.length}개 파일`, this.getOutputFolder());
			BdApi.UI.showToast(`${paths.length.toLocaleString()}개 이미지를 저장했어.`, {type: "success"});
		}));
		openBtn.addEventListener("click", () => this.openPath(this.getOutputFolder()));
		row.append(copyBtn, saveBtn, openBtn);

		modal.append(head, scroller, row);
		overlay.appendChild(modal);
		overlay.addEventListener("mousedown", event => {if (event.target === overlay) removeOverlay();});
		document.body.appendChild(overlay);
		this.shotOverlay = overlay;
		this.shotEscHandler = event => {if (event.key === "Escape" && this.shotOverlay) {event.preventDefault(); event.stopPropagation(); removeOverlay();}};
		document.addEventListener("keydown", this.shotEscHandler, true);
	}

	openForScope (scope) {
		this.targetScope = scope || this.getCurrentScopeInfo();
		if (this.panel) this.removePanel(false);
		this.showPanel(this.targetScope);
	}

	getCurrentGuildInfo () {
		const stores = this.getStores();
		let channelId = stores.SelectedChannelStore && stores.SelectedChannelStore.getChannelId && stores.SelectedChannelStore.getChannelId();
		let pathGuildId = "", pathChannelId = "";
		try {
			const match = String(location.pathname || "").match(/^\/channels\/([^/]+)(?:\/([^/?#]+))?/);
			if (match) {pathGuildId = match[1] || ""; pathChannelId = match[2] || "";}
		}
		catch (_) {}
		if (!channelId && pathChannelId) channelId = pathChannelId;
		const channel = stores.ChannelStore && channelId ? stores.ChannelStore.getChannel(channelId) : null;
		const channelGuildId = channel && (channel.guild_id || channel.guildId);
		const selectedGuildId = stores.SelectedGuildStore && stores.SelectedGuildStore.getGuildId && stores.SelectedGuildStore.getGuildId();
		const isDM = pathGuildId === "@me" || channel && !channelGuildId || [1, 3].includes(Number(channel && channel.type));
		let guildId = "";
		if (!isDM) guildId = String(channelGuildId || (pathGuildId && pathGuildId !== "@me" ? pathGuildId : selectedGuildId || ""));
		const guild = stores.GuildStore && guildId ? stores.GuildStore.getGuild(guildId) : null;
		return {guildId, guildName: guild && guild.name || "현재 서버", channelId: channelId ? String(channelId) : "", channel, isDM, stores};
	}

	getGuildName (guildId) {
		try {
			const stores = this.getStores();
			const guild = stores.GuildStore && stores.GuildStore.getGuild(String(guildId));
			return guild && guild.name || String(guildId);
		}
		catch (_) {return String(guildId);}
	}

	isThreadChannel (channel) {return [10, 11, 12].includes(Number(channel && channel.type)) || !!(channel && (channel.thread_metadata || channel.threadMetadata));}
	isForumChannel (channel) {return [15, 16].includes(Number(channel && channel.type)) || !!(channel && (Array.isArray(channel.available_tags) || Array.isArray(channel.availableTags)));}
	isMessageChannel (channel) {
		const type = Number(channel && channel.type);
		return [0, 1, 2, 3, 5, 10, 11, 12, 13].includes(type) || this.isThreadChannel(channel);
	}

	deepWalkChannels (value, add, seen = new WeakSet(), depth = 0) {
		if (!value || depth > 8) return;
		if (Array.isArray(value)) return value.forEach(item => this.deepWalkChannels(item, add, seen, depth + 1));
		if (typeof value !== "object") return;
		if (seen.has(value)) return;
		seen.add(value);
		if (value.channel) add(value.channel);
		else if (value.id && (value.guild_id || value.guildId || value.type != null)) add(value);
		for (const key of Object.keys(value)) {
			if (["channel", "id", "guild_id", "guildId", "type", "name", "constructor"].includes(key)) continue;
			const child = value[key];
			if (child && (Array.isArray(child) || typeof child === "object")) this.deepWalkChannels(child, add, seen, depth + 1);
		}
	}

	getStoreChannels (guildId) {
		const stores = this.getStores();
		const out = [];
		const seen = new Set();
		const add = channel => {
			if (!channel || !channel.id || seen.has(String(channel.id))) return;
			const chGuildId = channel.guild_id || channel.guildId;
			if (!chGuildId || String(chGuildId) !== String(guildId)) return;
			seen.add(String(channel.id));
			out.push(channel);
		};
		try {this.deepWalkChannels(stores.GuildChannelStore && stores.GuildChannelStore.getChannels && stores.GuildChannelStore.getChannels(guildId), add);} catch (_) {}
		try {this.deepWalkChannels(stores.ChannelStore, add);} catch (_) {}
		return out;
	}

	getChannelName (channel) {
		if (!channel) return "";
		if ([1, 3].includes(Number(channel.type))) return this.getDmDisplayName(channel);
		return channel.name ? `#${channel.name}` : String(channel.id || "");
	}

	channelTypeLabel (channel) {
		const type = Number(channel && channel.type);
		if (type === 0) return "텍스트 채널";
		if (type === 1) return "개인 DM";
		if (type === 3) return "그룹 DM";
		if (type === 2) return "음성 채널 채팅";
		if (type === 5) return "공지 채널";
		if (type === 10) return "공지 스레드";
		if (type === 11) return "포럼 포스트/공개 스레드";
		if (type === 12) return "비공개 스레드";
		if (type === 13) return "스테이지 채널 채팅";
		if (type === 15) return "포럼";
		if (type === 16) return "미디어 포럼";
		return `채널 타입 ${Number.isFinite(type) ? type : "?"}`;
	}

	discoverThreadChannelsFromStores (guildId, parentId = null) {
		const stores = this.getStores();
		const out = [];
		const seen = new Set();
		const add = channel => {
			if (!channel || !channel.id) return;
			const channelGuildId = channel.guild_id || channel.guildId || guildId;
			if (String(channelGuildId) !== String(guildId)) return;
			if (parentId && String(channel.parent_id || channel.parentId || "") !== String(parentId)) return;
			if (!this.isThreadChannel(channel) && !(channel.parent_id || channel.parentId)) return;
			if (seen.has(String(channel.id))) return;
			seen.add(String(channel.id));
			out.push(Object.assign({}, channel, {guild_id: channelGuildId, parent_id: channel.parent_id || channel.parentId || parentId}));
		};
		try {this.deepWalkChannels(stores.ChannelStore, add);} catch (_) {}
		try {
			const module = this.getWebpackModule(m => m && (typeof m.getThreadsForParent === "function" || typeof m.getActiveThreadsForGuild === "function" || typeof m.getThreadsForGuild === "function"));
			if (module) {
				for (const call of [
					() => module.getThreadsForParent && module.getThreadsForParent(guildId, parentId),
					() => module.getThreadsForParent && module.getThreadsForParent(parentId),
					() => module.getActiveThreadsForGuild && module.getActiveThreadsForGuild(guildId),
					() => module.getThreadsForGuild && module.getThreadsForGuild(guildId)
				]) {try {this.deepWalkChannels(call(), add);} catch (_) {}}
			}
		}
		catch (_) {}
		return out;
	}

	extractThreadChannelsFromPayload (data, guildId, parentId = null) {
		const out = [];
		const seen = new Set();
		const pushThread = value => {
			if (!value || typeof value !== "object") return;
			const candidate = value.thread || value.channel || value;
			if (!candidate || typeof candidate !== "object" || !candidate.id) return;
			const looksThread = this.isThreadChannel(candidate) || candidate.parent_id || candidate.parentId;
			if (!looksThread || seen.has(String(candidate.id))) return;
			seen.add(String(candidate.id));
			out.push(Object.assign({}, candidate, {guild_id: candidate.guild_id || candidate.guildId || guildId, parent_id: candidate.parent_id || candidate.parentId || parentId || null}));
		};
		const pushPseudoFromMessage = value => {
			if (!value || typeof value !== "object") return;
			const message = value.message || value.first_message || value.firstMessage || value;
			const channelId = message && (message.channel_id || message.channelId);
			if (!channelId || seen.has(String(channelId))) return;
			seen.add(String(channelId));
			out.push({id: String(channelId), guild_id: guildId, parent_id: parentId || null, type: 11, name: message.thread_name || message.threadName || message.title || message.content && String(message.content).slice(0, 40) || "Forum post"});
		};
		const walk = (value, depth = 0) => {
			if (!value || depth > 7) return;
			if (Array.isArray(value)) return value.forEach(item => walk(item, depth + 1));
			if (typeof value !== "object") return;
			pushThread(value);
			pushPseudoFromMessage(value);
			for (const key of ["threads", "results", "items", "channels", "body", "messages", "first_messages", "firstMessages", "posts", "forum_posts", "forumPosts"]) if (value[key]) walk(value[key], depth + 1);
		};
		walk(data);
		return out;
	}

	async getServerTargetChannels (guildId, bundle) {
		const map = new Map();
		const add = channel => {
			if (!channel || !channel.id) return;
			const normalized = Object.assign({}, channel, {guild_id: channel.guild_id || channel.guildId || guildId});
			if (!map.has(String(normalized.id))) map.set(String(normalized.id), normalized);
		};
		for (const channel of this.getStoreChannels(guildId)) add(channel);
		try {
			const apiChannels = await this.fetchRoute(bundle, `/guilds/${guildId}/channels`, {});
			if (Array.isArray(apiChannels)) apiChannels.forEach(add);
		}
		catch (error) {console.warn("[ChatLogExporter] Guild channels API failed", error);}
		try {
			const active = await this.fetchRouteApiPreferred(bundle, `/guilds/${guildId}/threads/active`, {});
			for (const thread of this.extractThreadChannelsFromPayload(active, guildId)) add(thread);
		}
		catch (error) {console.warn("[ChatLogExporter] Active threads lookup failed", error);}
		for (const thread of this.discoverThreadChannelsFromStores(guildId)) add(thread);

		const parents = Array.from(map.values());
		const forums = parents.filter(channel => this.isForumChannel(channel));
		for (const forum of forums) {
			this.setProgressStatus(`포럼 포스트 목록 수집 중...\n${this.getChannelName(forum)}`);
			for (const thread of this.discoverThreadChannelsFromStores(guildId, forum.id)) add(thread);
			try {for (const thread of await this.fetchForumSearchThreads(bundle, forum, guildId)) add(thread);} catch (error) {console.warn("[ChatLogExporter] Forum search failed", forum.id, error);}
			try {for (const thread of await this.fetchArchivedThreadsForParent(bundle, forum, guildId)) add(thread);} catch (error) {console.warn("[ChatLogExporter] Forum archive failed", forum.id, error);}
		}

		const normalThreadParents = Array.from(map.values()).filter(channel => [0, 5].includes(Number(channel.type)));
		for (const parent of normalThreadParents) {
			try {for (const thread of await this.fetchArchivedThreadsForParent(bundle, parent, guildId)) add(thread);} catch (_) {}
		}

		for (const channel of map.values()) {
			const parentId = channel && (channel.parent_id || channel.parentId);
			if (parentId && map.has(String(parentId))) channel.parent_name = this.getChannelName(map.get(String(parentId)));
		}
		return Array.from(map.values()).filter(channel => this.isMessageChannel(channel) && !this.isForumChannel(channel));
	}

	async fetchForumSearchThreads (bundle, forum, guildId) {
		const out = [];
		const seen = new Set();
		const add = thread => {
			if (!thread || !thread.id || seen.has(String(thread.id))) return;
			seen.add(String(thread.id));
			out.push(Object.assign({}, thread, {guild_id: thread.guild_id || guildId, parent_id: thread.parent_id || thread.parentId || forum.id}));
		};
		for (const sortBy of ["last_message_time", "creation_date", "latest_activity"]) {
			let offset = 0;
			for (let page = 0; page < 10000 && !this.abortCollect; page++) {
				let data;
				try {data = await this.fetchRouteApiPreferred(bundle, `/channels/${forum.id}/threads/search`, {sort_by: sortBy, sort_order: "desc", limit: 25, offset});}
				catch (_) {break;}
				const threads = this.extractThreadChannelsFromPayload(data, guildId, forum.id);
				if (!threads.length) break;
				threads.forEach(add);
				offset += Math.max(threads.length, 25);
				if (threads.length < 25 || data && data.has_more === false) break;
				await this.sleep(this.settings.fetchDelayMs);
			}
		}
		return out;
	}

	async fetchArchivedThreadsForParent (bundle, parent, guildId) {
		const out = [];
		const seen = new Set();
		for (const mode of ["public", "private"]) {
			let before = null;
			for (let page = 0; page < 10000 && !this.abortCollect; page++) {
				let data;
				try {
					const query = {limit: 100};
					if (before) query.before = before;
					data = await this.fetchRouteApiPreferred(bundle, `/channels/${parent.id}/threads/archived/${mode}`, query);
				}
				catch (error) {if (mode === "private") break; throw error;}
				const threads = data && Array.isArray(data.threads) ? data.threads : [];
				if (!threads.length) break;
				for (const thread of threads) if (thread && thread.id && !seen.has(String(thread.id))) {
					seen.add(String(thread.id));
					out.push(Object.assign({}, thread, {guild_id: thread.guild_id || guildId, parent_id: thread.parent_id || parent.id}));
				}
				const last = threads[threads.length - 1];
				before = last && last.thread_metadata && (last.thread_metadata.archive_timestamp || last.thread_metadata.create_timestamp) || last && last.threadMetadata && (last.threadMetadata.archiveTimestamp || last.threadMetadata.createTimestamp) || last && (last.archive_timestamp || last.archiveTimestamp || last.last_message_id) || null;
				if (!data || !data.has_more || !before) break;
				await this.sleep(this.settings.fetchDelayMs);
			}
		}
		return out;
	}


	beginCollectionDiagnostics (scope, mode, bundle) {
		let route = "";
		try {route = String(location && location.pathname || "");} catch (_) {}
		let cacheWritable = false, cacheWriteError = "";
		try {
			this.ensureBaseFolders();
			const testPath = this.path.join(this.getCacheRoot(), `.write-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
			this.fs.writeFileSync(testPath, "ok", "utf8");
			this.fs.unlinkSync(testPath);
			cacheWritable = true;
		}
		catch (error) {cacheWriteError = error && (error.stack || error.message) || String(error);}
		this.collectionDiagnostics = {
			plugin: this.name,
			version: this.version,
			started_at: new Date().toISOString(),
			mode,
			scope: scope ? {type: scope.type, sourceId: scope.sourceId, cacheId: scope.cacheId, name: scope.name, channelId: scope.channelId || ""} : null,
			current_route: route,
			current_context: this.safeDiagnosticContext(),
			cache_root: this.getCacheRoot(),
			cache_dir: scope && scope.cacheId ? this.getGuildDir(scope.cacheId) : "",
			manifest_path: scope && scope.cacheId ? this.getManifestPath(scope.cacheId) : "",
			cache_writable: cacheWritable,
			cache_write_error: cacheWriteError,
			page_size: Number(this.settings.pageSize || 100),
			fetch_delay_ms: Number(this.settings.fetchDelayMs || 0),
			token_available: !!(bundle && Array.isArray(bundle.transports) && bundle.transports.some(item => item && item.token)),
			transports: bundle && Array.isArray(bundle.transports) ? bundle.transports.map(item => item && item.kind || "unknown") : bundle ? [bundle.kind || "unknown"] : [],
			target_channel_count: 0,
			target_channels: [],
			fetch_attempts: [],
			channel_results: {},
			global_errors: [],
			progress: null,
			manifest_summary: null,
			finished_at: null
		};
	}

	safeDiagnosticContext () {
		try {
			const current = this.getCurrentGuildInfo();
			return {
				guildId: current.guildId || "",
				guildName: current.guildName || "",
				channelId: current.channelId || "",
				channelType: current.channel && current.channel.type,
				channelName: current.channel && current.channel.name,
				isDM: !!current.isDM
			};
		}
		catch (error) {return {error: error && (error.message || error.stack) || String(error)};}
	}

	setDiagnosticTargets (channels) {
		if (!this.collectionDiagnostics) return;
		const list = Array.isArray(channels) ? channels : [];
		this.collectionDiagnostics.target_channel_count = list.length;
		this.collectionDiagnostics.target_channels = list.map(channel => ({
			id: String(channel && channel.id || ""),
			name: this.getChannelName(channel),
			type: Number(channel && channel.type),
			typeLabel: this.channelTypeLabel(channel),
			parentId: String(channel && (channel.parent_id || channel.parentId) || "")
		}));
	}

	recordFetchDiagnostic (channelId, limit, before, transport, resultCount, error = null, source = "network") {
		if (!this.collectionDiagnostics) return;
		const attempts = this.collectionDiagnostics.fetch_attempts;
		if (!Array.isArray(attempts) || attempts.length >= 800) return;
		attempts.push({
			time: new Date().toISOString(),
			channelId: String(channelId || ""),
			limit: Number(limit || 0),
			before: before == null ? null : String(before),
			transport: String(transport || "unknown"),
			source,
			resultCount: Number(resultCount || 0),
			error: error ? String(error && (error.stack || error.message) || error) : ""
		});
	}

	recordChannelDiagnostic (channel, data = {}) {
		if (!this.collectionDiagnostics || !channel || !channel.id) return;
		const id = String(channel.id);
		const previous = this.collectionDiagnostics.channel_results[id] || {
			id,
			name: this.getChannelName(channel),
			type: Number(channel.type),
			typeLabel: this.channelTypeLabel(channel),
			parentId: String(channel.parent_id || channel.parentId || ""),
			loadedStoreCount: 0,
			received: 0,
			saved: 0,
			error: ""
		};
		this.collectionDiagnostics.channel_results[id] = Object.assign(previous, data || {});
	}

	getLoadedMessagesForFetch (channelId, limit = 100, before = null) {
		const stores = this.getStores();
		const store = stores.MessageStore;
		if (!store || !channelId || typeof store.getMessages !== "function") return [];
		let collection;
		try {collection = store.getMessages(String(channelId));} catch (_) {return [];}
		let array = [];
		if (Array.isArray(collection)) array = collection;
		else if (collection && Array.isArray(collection._array)) array = collection._array;
		else if (collection && Array.isArray(collection.array)) array = collection.array;
		else if (collection && typeof collection.toArray === "function") {try {array = collection.toArray();} catch (_) {}}
		else if (collection && typeof collection.forEach === "function") {try {collection.forEach(item => item && array.push(item));} catch (_) {}}
		const out = array.filter(item => item && item.id).map(item => item.toJS && typeof item.toJS === "function" ? item.toJS() : item);
		out.sort((a, b) => this.compareSnowflakes(b.id, a.id));
		const filtered = before ? out.filter(item => this.compareSnowflakes(item.id, before) < 0) : out;
		return filtered.slice(0, Math.max(1, Number(limit) || 100));
	}

	finalizeCollectionDiagnostics (manifest, channels, extra = {}) {
		if (!this.collectionDiagnostics) return "";
		this.setDiagnosticTargets(channels || []);
		this.collectionDiagnostics.finished_at = new Date().toISOString();
		this.collectionDiagnostics.current_context_end = this.safeDiagnosticContext();
		this.collectionDiagnostics.progress = Object.assign({}, this.progressState);
		this.collectionDiagnostics.manifest_summary = manifest ? {
			guildId: manifest.guildId,
			guildName: manifest.guildName,
			scopeType: manifest.scopeType,
			sourceId: manifest.sourceId,
			totalMessages: Number(manifest.totalMessages || 0),
			channelStates: Object.keys(manifest.channels || {}).length,
			manifestExists: this.fs.existsSync(this.getManifestPath(manifest.guildId)),
			cacheDirectoryExists: this.fs.existsSync(this.getGuildDir(manifest.guildId)),
			cacheDirectorySize: this.getDirectorySize(this.getGuildDir(manifest.guildId))
		} : null;
		Object.assign(this.collectionDiagnostics, extra || {});
		const text = JSON.stringify(this.collectionDiagnostics, null, 2);
		this.lastCollectionDiagnosticText = text;
		try {
			this.ensureBaseFolders();
			const latest = this.path.join(this.getCacheRoot(), "ChatLogExporter-last-diagnostic.json");
			this.fs.writeFileSync(latest, text, "utf8");
			if (manifest && manifest.guildId) this.fs.writeFileSync(this.path.join(this.getGuildDir(manifest.guildId), "last-diagnostic.json"), text, "utf8");
		}
		catch (error) {
			this.collectionDiagnostics.global_errors.push(`진단 파일 저장 실패: ${error && (error.stack || error.message) || String(error)}`);
			this.lastCollectionDiagnosticText = JSON.stringify(this.collectionDiagnostics, null, 2);
		}
		return this.lastCollectionDiagnosticText;
	}

	async copyLastCollectionDiagnostics (showAlert = false) {
		let text = this.lastCollectionDiagnosticText;
		if (!text) {
			try {
				const file = this.path.join(this.getCacheRoot(), "ChatLogExporter-last-diagnostic.json");
				if (this.fs.existsSync(file)) text = this.fs.readFileSync(file, "utf8");
			}
			catch (_) {}
		}
		if (!text && this.collectionDiagnostics) text = JSON.stringify(this.collectionDiagnostics, null, 2);
		if (!text) text = JSON.stringify({plugin: this.name, version: this.version, message: "아직 생성된 수집 진단 정보가 없어.", current: this.safeDiagnosticContext()}, null, 2);
		const copied = await this.copyText(text);
		if (showAlert) BdApi.UI.alert("ChatLogExporter 진단", copied ? "최근 수집 진단 정보가 클립보드에 복사됐어." : `클립보드 복사에 실패했어.\n\n진단 파일: ${this.path.join(this.getCacheRoot(), "ChatLogExporter-last-diagnostic.json")}`);
		return copied;
	}

	async reportZeroCollection (manifest, channels, scope) {
		const text = this.finalizeCollectionDiagnostics(manifest, channels, {zero_message_failure: true});
		const copied = await this.copyText(text);
		this.setProgressStatus("수집은 끝났지만 메시지를 한 개도 저장하지 못했어. 진단 정보를 복사했어.");
		BdApi.UI.alert("ChatLogExporter 수집 진단", `메시지를 한 개도 저장하지 못했어.\n\n${copied ? "상세 진단 정보가 클립보드에 복사됐어. 그대로 보내줘." : "클립보드 복사에 실패했어. 아래 진단 파일을 보내줘."}\n\n진단 파일: ${this.path.join(this.getGuildDir(scope.cacheId), "last-diagnostic.json")}`);
	}

	getHttpBundle () {
		const candidates = [];
		const push = value => {if (value && !candidates.includes(value)) candidates.push(value);};
		try {
			push(this.getWebpackModule(m => m && m.HTTP && typeof m.HTTP.get === "function"));
			push(this.getWebpackModule(m => m && m.default && m.default.HTTP && typeof m.default.HTTP.get === "function"));
			push(this.getWebpackModule(m => m && typeof m.get === "function" && typeof m.post === "function"));
			push(this.getWebpackModule(m => m && typeof m.get === "function" && typeof m.request === "function"));
		}
		catch (_) {}
		const transports = [];
		const seen = new Set();
		for (const candidate of candidates) {
			const HTTP = candidate && (candidate.HTTP || candidate.default && candidate.default.HTTP || candidate.default || candidate);
			if (HTTP && typeof HTTP.get === "function" && !seen.has(HTTP)) {seen.add(HTTP); transports.push({kind: `internal HTTP #${transports.length}`, HTTP});}
		}
		const token = this.getAuthToken();
		if (token && typeof fetch === "function") transports.push({kind: "window.fetch API", token, nativeFetch: true});
		if (token && BdApi.Net && typeof BdApi.Net.fetch === "function") transports.push({kind: "BdApi.Net.fetch API", token, bdFetch: true});
		return transports.length ? {kind: "multi", transports} : null;
	}

	getAuthToken () {
		const candidates = [];
		try {
			if (BdApi.Webpack && typeof BdApi.Webpack.getStore === "function") {
				candidates.push(BdApi.Webpack.getStore("AuthenticationStore"));
				candidates.push(BdApi.Webpack.getStore("AuthStore"));
			}
		}
		catch (_) {}
		try {candidates.push(this.getWebpackModule(m => m && typeof m.getToken === "function"));} catch (_) {}
		try {candidates.push(this.getWebpackModule(m => m && m.default && typeof m.default.getToken === "function"));} catch (_) {}
		for (const candidate of candidates.filter(Boolean)) {
			try {
				const store = candidate.default && typeof candidate.default.getToken === "function" ? candidate.default : candidate;
				const token = store && store.getToken && store.getToken();
				if (typeof token === "string" && token.length > 20) return token;
			}
			catch (_) {}
		}
		return null;
	}

	normalizeFetchPayload (payload) {
		if (payload == null) return payload;
		if (typeof payload === "string") {
			const text = payload.trim();
			if (!text) return {};
			if (text[0] === "<" || /^<!doctype\s+html/i.test(text) || /<html[\s>]/i.test(text)) throw new Error("Fetch returned Discord web HTML instead of API JSON");
			try {return JSON.parse(text);} catch (_) {throw new Error("Fetch returned non-JSON text: " + text.slice(0, 120));}
		}
		if (payload && typeof payload === "object") {
			if (typeof payload.text === "string" && !payload.body) return this.normalizeFetchPayload(payload.text);
			if (payload.body != null && payload.body !== payload) return this.normalizeFetchPayload(payload.body);
		}
		return payload;
	}

	async fetchRouteApiPreferred (bundle, path, query = {}) {
		if (!bundle || !Array.isArray(bundle.transports)) return this.fetchRoute(bundle, path, query);
		const preferred = bundle.transports.filter(transport => transport.token);
		const rest = bundle.transports.filter(transport => !transport.token);
		return this.fetchRoute({kind: "multi", transports: preferred.concat(rest)}, path, query);
	}

	async fetchRoute (bundle, route, query = {}) {
		if (!bundle) throw new Error("Discord HTTP module/token could not be found");
		if (Array.isArray(bundle.transports)) {
			const transports = [];
			if (this.preferredFetchTransport && bundle.transports.includes(this.preferredFetchTransport)) transports.push(this.preferredFetchTransport);
			for (const transport of bundle.transports) if (!transports.includes(transport)) transports.push(transport);
			const errors = [];
			for (const transport of transports) {
				try {const value = await this.fetchRoute(transport, route, query); this.preferredFetchTransport = transport; return value;}
				catch (error) {errors.push(`${transport.kind}: ${error && (error.message || error.stack) || String(error)}`);}
			}
			throw new Error(errors.join(" | ") || "All fetch transports failed");
		}
		if (bundle.HTTP) return this.fetchRouteInternal(bundle.HTTP, route, query);
		if (bundle.token) return this.fetchRouteViaApi(bundle, route, query);
		throw new Error("Unknown fetch transport");
	}

	async fetchRouteInternal (HTTP, route, query = {}) {
		const qs = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)])).toString();
		const attempts = [
			() => HTTP.get({url: route, query, retries: 1}),
			() => HTTP.get({url: route, query}),
			() => HTTP.get(route, {query}),
			() => HTTP.get(route + (qs ? `?${qs}` : ""))
		];
		let lastError;
		for (const attempt of attempts) {
			try {
				const response = await attempt();
				const body = response && (response.body || response.text || response);
				if (body != null) return this.normalizeFetchPayload(body);
			}
			catch (error) {lastError = error;}
		}
		throw lastError || new Error("Internal HTTP returned an empty response");
	}

	async fetchRouteViaApi (bundle, route, query = {}) {
		const qs = new URLSearchParams(Object.entries(query).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)])).toString();
		const url = `https://discord.com/api/v9${route}${qs ? `?${qs}` : ""}`;
		const doFetch = bundle.bdFetch && BdApi.Net && typeof BdApi.Net.fetch === "function" ? BdApi.Net.fetch : typeof fetch === "function" ? fetch : null;
		if (!doFetch) throw new Error("fetch is not available");
		const response = await doFetch(url, {method: "GET", headers: {Authorization: bundle.token, Accept: "application/json"}});
		let data = null;
		try {data = await response.json();} catch (_) {try {data = JSON.parse(await response.text());} catch (_) {}}
		if (response.status === 429 && data && data.retry_after != null) {
			await this.sleep(Math.ceil(Number(data.retry_after) * 1000) + 250);
			return this.fetchRouteViaApi(bundle, route, query);
		}
		if (!response.ok) throw new Error(`Discord API fetch failed: ${response.status}${data && data.message ? ` ${data.message}` : ""}`);
		return this.normalizeFetchPayload(data == null ? {} : data);
	}

	async fetchMessages (bundle, channelId, limit, before = null) {
		if (!bundle) throw new Error("Discord HTTP module/token could not be found");
		if (Array.isArray(bundle.transports)) {
			const transports = [];
			if (this.preferredFetchTransport && bundle.transports.includes(this.preferredFetchTransport)) transports.push(this.preferredFetchTransport);
			for (const transport of bundle.transports.filter(item => item && item.token)) if (!transports.includes(transport)) transports.push(transport);
			for (const transport of bundle.transports.filter(item => !item || !item.token)) if (!transports.includes(transport)) transports.push(transport);
			const errors = [];
			let emptySuccess = null;
			for (const transport of transports) {
				try {
					const messages = await this.fetchMessages(transport, channelId, limit, before);
					this.recordFetchDiagnostic(channelId, limit, before, transport.kind, Array.isArray(messages) ? messages.length : 0);
					if (Array.isArray(messages) && messages.length) {this.preferredFetchTransport = transport; return messages;}
					if (Array.isArray(messages) && !emptySuccess) emptySuccess = {transport, messages};
				}
				catch (error) {
					const detail = error && (error.message || error.stack) || String(error);
					errors.push(`${transport.kind || "unknown"}: ${detail}`);
					this.recordFetchDiagnostic(channelId, limit, before, transport.kind, 0, detail);
				}
			}
			const loaded = this.getLoadedMessagesForFetch(channelId, limit, before);
			this.recordFetchDiagnostic(channelId, limit, before, "Discord MessageStore", loaded.length, null, "loaded_store");
			if (loaded.length) return loaded;
			if (emptySuccess) {this.preferredFetchTransport = emptySuccess.transport; return emptySuccess.messages;}
			throw new Error(errors.join(" | ") || "All message fetch transports failed");
		}
		if (bundle.HTTP) return this.fetchMessagesInternal(bundle.HTTP, channelId, limit, before);
		if (bundle.token) return this.fetchMessagesViaApi(bundle, channelId, limit, before);
		throw new Error("Unknown fetch transport");
	}

	async fetchMessagesInternal (HTTP, channelId, limit, before = null) {
		const query = {limit};
		if (before) query.before = before;
		const route = `/channels/${channelId}/messages`;
		const attempts = [
			() => HTTP.get({url: route, query, retries: 1}),
			() => HTTP.get({url: route, query}),
			() => HTTP.get(route, {query}),
			() => HTTP.get(route + `?${new URLSearchParams(query).toString()}`)
		];
		let lastError;
		for (const attempt of attempts) {
			try {
				const response = await attempt();
				const rawBody = response && (response.body != null ? response.body : response.text != null ? response.text : response);
				const body = this.normalizeFetchPayload(rawBody);
				if (Array.isArray(body)) return body;
				if (body && Array.isArray(body.messages)) return body.messages;
				if (body && Array.isArray(body.body)) return body.body;
				lastError = new Error(`Internal HTTP returned ${body && typeof body === "object" ? `object keys: ${Object.keys(body).join(",")}` : typeof body}, not a message array`);
			}
			catch (error) {lastError = error;}
		}
		throw lastError || new Error("Internal HTTP returned no message array");
	}

	async fetchMessagesViaApi (bundle, channelId, limit, before = null) {
		const query = new URLSearchParams({limit: String(limit)});
		if (before) query.set("before", String(before));
		const doFetch = bundle.bdFetch && BdApi.Net && typeof BdApi.Net.fetch === "function" ? BdApi.Net.fetch : typeof fetch === "function" ? fetch : null;
		if (!doFetch) throw new Error("fetch is not available");
		const errors = [];
		for (const apiVersion of [10, 9]) {
			const url = `https://discord.com/api/v${apiVersion}/channels/${channelId}/messages?${query.toString()}`;
			try {
				const response = await doFetch(url, {method: "GET", headers: {Authorization: bundle.token, Accept: "application/json"}});
				let text = "", data = null;
				try {data = await response.json();}
				catch (_) {try {text = await response.text(); data = text ? JSON.parse(text) : null;} catch (_) {}}
				if (response.status === 429 && data && data.retry_after != null) {
					await this.sleep(Math.ceil(Number(data.retry_after) * 1000) + 250);
					return this.fetchMessagesViaApi(bundle, channelId, limit, before);
				}
				if (!response.ok) throw new Error(`Discord API v${apiVersion} fetch failed: ${response.status}${data && data.message ? ` ${data.message}` : text ? ` ${text.slice(0, 160)}` : ""}`);
				if (Array.isArray(data)) return data;
				if (data && Array.isArray(data.messages)) return data.messages;
				throw new Error(`Discord API v${apiVersion} returned ${data && typeof data === "object" ? `object keys: ${Object.keys(data).join(",")}` : typeof data}, not a message array`);
			}
			catch (error) {errors.push(error && (error.message || error.stack) || String(error));}
		}
		throw new Error(errors.join(" | ") || "Discord API message fetch failed");
	}

	makeManifest (cacheId, scopeName, scopeInfo = null) {
		const scopeType = scopeInfo && scopeInfo.type === "dm" ? "dm" : "guild";
		const sourceId = String(scopeInfo && scopeInfo.sourceId || cacheId);
		return {version: 2, guildId: String(cacheId), guildName: String(scopeName || cacheId), scopeType, sourceId, dmChannelId: scopeType === "dm" ? sourceId : null, createdAt: Date.now(), updatedAt: Date.now(), lastFullScanAt: 0, lastRecentScanAt: 0, totalMessages: 0, channels: {}};
	}

	readManifest (cacheId, scopeName = "", scopeInfo = null) {
		const file = this.getManifestPath(cacheId);
		try {
			if (this.fs.existsSync(file)) {
				const parsed = JSON.parse(this.fs.readFileSync(file, "utf8"));
				if (parsed && parsed.channels) {
					parsed.guildId = String(cacheId);
					parsed.guildName = scopeName || parsed.guildName || String(cacheId);
					parsed.scopeType = parsed.scopeType || (String(cacheId).startsWith("dm_") ? "dm" : "guild");
					parsed.sourceId = String(parsed.sourceId || (parsed.scopeType === "dm" ? String(cacheId).replace(/^dm_/, "") : cacheId));
					parsed.dmChannelId = parsed.scopeType === "dm" ? String(parsed.dmChannelId || parsed.sourceId) : null;
					parsed.version = Math.max(2, Number(parsed.version || 1));
					return parsed;
				}
			}
		}
		catch (error) {console.warn("[ChatLogExporter] Manifest read failed", error);}
		return this.makeManifest(cacheId, scopeName, scopeInfo);
	}

	writeManifest (manifest) {
		manifest.updatedAt = Date.now();
		this.fs.mkdirSync(this.getGuildDir(manifest.guildId), {recursive: true});
		this.fs.mkdirSync(this.getChannelsDir(manifest.guildId), {recursive: true});
		const target = this.getManifestPath(manifest.guildId);
		const temp = `${target}.tmp`;
		this.fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), "utf8");
		this.fs.renameSync(temp, target);
	}

	getManifestRouteGuildId (manifest) {return manifest && manifest.scopeType === "dm" ? "@me" : String(manifest && (manifest.sourceId || manifest.guildId) || "");}
	buildMessageUrl (manifest, channelId, messageId) {return `https://discord.com/channels/${this.getManifestRouteGuildId(manifest)}/${channelId}/${messageId}`;}

	getChannelState (manifest, channel) {
		const id = String(channel.id);
		if (!manifest.channels[id]) manifest.channels[id] = {
			id,
			name: this.getChannelName(channel),
			rawName: channel.name || this.getChannelName(channel),
			type: Number(channel.type),
			typeLabel: this.channelTypeLabel(channel),
			parentId: channel.parent_id || channel.parentId || null,
			parentName: channel.parent_name || channel.parentName || null,
			position: Number(channel.position || 0),
			messageCount: 0,
			oldestId: null,
			newestId: null,
			completeOlder: false,
			lastScanAt: 0,
			lastRecentScanAt: 0,
			errors: []
		};
		const state = manifest.channels[id];
		state.name = this.getChannelName(channel) || state.name;
		state.rawName = channel.name || state.rawName;
		state.type = Number(channel.type);
		state.typeLabel = this.channelTypeLabel(channel);
		state.parentId = channel.parent_id || channel.parentId || state.parentId || null;
		state.parentName = channel.parent_name || channel.parentName || state.parentName || null;
		return state;
	}

	compareSnowflakes (left, right) {
		try {const a = BigInt(String(left || 0)); const b = BigInt(String(right || 0)); return a === b ? 0 : a > b ? 1 : -1;} catch (_) {return String(left).localeCompare(String(right));}
	}

	normalizeMessage (message, manifest, channel) {
		const author = message.author || {};
		const attachments = Array.isArray(message.attachments) ? message.attachments.map(item => ({id: item.id || "", filename: item.filename || item.name || "", url: item.url || item.proxy_url || item.proxyUrl || "", proxy_url: item.proxy_url || item.proxyUrl || "", content_type: item.content_type || item.contentType || "", size: item.size || 0, width: item.width || null, height: item.height || null})) : [];
		const embeds = Array.isArray(message.embeds) ? message.embeds.map(embed => ({type: embed.type || "", title: embed.title || embed.rawTitle || "", description: embed.description || embed.rawDescription || "", url: embed.url || "", fields: Array.isArray(embed.fields) ? embed.fields.map(field => ({name: field.name || "", value: field.value || ""})) : []})) : [];
		const reactions = Array.isArray(message.reactions) ? message.reactions.map(reaction => ({emoji: reaction.emoji && (reaction.emoji.name || reaction.emoji.id) || reaction.emoji || "", count: reaction.count || 0, me: !!reaction.me})) : [];
		return {
			id: String(message.id || ""),
			guild_id: manifest.scopeType === "dm" ? null : String(manifest.sourceId || manifest.guildId),
			scope_type: manifest.scopeType || "guild",
			scope_id: String(manifest.sourceId || manifest.guildId),
			channel_id: String(message.channel_id || channel.id),
			type: Number(message.type || 0),
			content: String(message.content || ""),
			timestamp: message.timestamp instanceof Date ? message.timestamp.toISOString() : String(message.timestamp || new Date(this.snowflakeTimestamp(message.id)).toISOString()),
			edited_timestamp: message.edited_timestamp || message.editedTimestamp || null,
			author: {
				id: String(author.id || ""),
				username: author.username || "Unknown",
				global_name: author.global_name || author.globalName || null,
				discriminator: author.discriminator || "0",
				bot: !!author.bot,
				avatar: author.avatar || null
			},
			attachments,
			embeds,
			reactions,
			message_reference: message.message_reference || message.messageReference || null,
			referenced_message: message.referenced_message ? {id: message.referenced_message.id || "", channel_id: message.referenced_message.channel_id || "", author: message.referenced_message.author ? {id: message.referenced_message.author.id || "", username: message.referenced_message.author.username || "", global_name: message.referenced_message.author.global_name || message.referenced_message.author.globalName || null} : null, content: message.referenced_message.content || ""} : null,
			mentions: Array.isArray(message.mentions) ? message.mentions.map(user => ({id: String(user.id || ""), username: user.username || "", global_name: user.global_name || user.globalName || null, bot: !!user.bot})) : [],
			mention_roles: Array.isArray(message.mention_roles || message.mentionRoles) ? (message.mention_roles || message.mentionRoles).map(String) : [],
			mention_channels: Array.isArray(message.mention_channels || message.mentionChannels) ? (message.mention_channels || message.mentionChannels).map(item => ({id: String(item.id || ""), guild_id: String(item.guild_id || item.guildId || (manifest.scopeType === "dm" ? "" : manifest.sourceId || manifest.guildId) || ""), type: item.type, name: item.name || ""})) : [],
			sticker_items: Array.isArray(message.sticker_items || message.stickerItems) ? (message.sticker_items || message.stickerItems).map(item => ({id: String(item.id || ""), name: item.name || "", format_type: item.format_type || item.formatType || null})) : [],
			flags: Number(message.flags || 0),
			webhook_id: message.webhook_id || message.webhookId || null,
			pinned: !!message.pinned,
			tts: !!message.tts,
			mention_everyone: !!message.mention_everyone
		};
	}

	snowflakeTimestamp (id) {try {return Number((BigInt(String(id)) >> 22n) + 1420070400000n);} catch (_) {return Date.now();}}

	async appendFileCompat (file, data, encoding = "utf8") {
		const fs = this.fs;
		// Some BetterDiscord builds expose writeFileSync/mkdirSync but omit every
		// appendFile variant. writeFileSync with flag "a" uses the same OS-level
		// append semantics and is the most reliable path in that environment.
		if (fs && typeof fs.writeFileSync === "function") {
			try {
				fs.writeFileSync(file, data, {encoding, flag: "a"});
				return;
			}
			catch (writeError) {
				// Continue through the optional native append implementations before
				// surfacing a capability report.
				if (!fs.__chatLogExporterLastAppendError) {
					try {Object.defineProperty(fs, "__chatLogExporterLastAppendError", {value: String(writeError && (writeError.stack || writeError.message) || writeError), configurable: true});}
					catch (_) {}
				}
			}
		}
		if (fs && fs.promises && typeof fs.promises.appendFile === "function") {
			await fs.promises.appendFile(file, data, encoding);
			return;
		}
		if (fs && typeof fs.appendFile === "function") {
			await new Promise((resolve, reject) => {
				fs.appendFile(file, data, encoding, error => error ? reject(error) : resolve());
			});
			return;
		}
		if (fs && typeof fs.appendFileSync === "function") {
			fs.appendFileSync(file, data, encoding);
			return;
		}
		const capabilities = {
			writeFileSync: !!(fs && typeof fs.writeFileSync === "function"),
			appendFileSync: !!(fs && typeof fs.appendFileSync === "function"),
			appendFile: !!(fs && typeof fs.appendFile === "function"),
			promisesAppendFile: !!(fs && fs.promises && typeof fs.promises.appendFile === "function"),
			lastWriteError: fs && fs.__chatLogExporterLastAppendError || ""
		};
		throw new Error(`No compatible append implementation is available: ${JSON.stringify(capabilities)}`);
	}

	async appendMessages (manifest, channel, rawMessages) {
		if (!rawMessages || !rawMessages.length) return 0;
		const state = this.getChannelState(manifest, channel);
		const normalized = [];
		const seen = new Set();
		for (const raw of rawMessages) {
			if (!raw || !raw.id || seen.has(String(raw.id))) continue;
			seen.add(String(raw.id));
			normalized.push(this.normalizeMessage(raw, manifest, channel));
		}
		if (!normalized.length) return 0;
		const file = this.getChannelDataPath(manifest.guildId, channel.id);
		this.fs.mkdirSync(this.path.dirname(file), {recursive: true});
		await this.appendFileCompat(file, normalized.map(message => JSON.stringify(message)).join("\n") + "\n", "utf8");
		for (const message of normalized) {
			if (!state.oldestId || this.compareSnowflakes(message.id, state.oldestId) < 0) state.oldestId = message.id;
			if (!state.newestId || this.compareSnowflakes(message.id, state.newestId) > 0) state.newestId = message.id;
		}
		state.messageCount += normalized.length;
		state.lastScanAt = Date.now();
		manifest.totalMessages += normalized.length;
		this.progressState.saved += normalized.length;
		return normalized.length;
	}

	async collectServer (mode = "full", scopeInfo = null) {
		if (this.collecting || this.exporting) return;
		const scope = scopeInfo || this.getActiveScopeInfo();
		if (!scope || !scope.cacheId) {
			BdApi.UI.alert("ChatLogExporter", "서버 또는 DM 대화방을 우클릭해서 ChatLogExporter를 열어줘.");
			return;
		}
		if (mode === "reset") {
			const confirmed = await this.confirmReset(scope.name);
			if (!confirmed) return;
			try {this.fs.rmSync(this.getGuildDir(scope.cacheId), {recursive: true, force: true});} catch (_) {}
		}
		const bundle = this.getHttpBundle();
		if (!bundle) {await this.reportError("로그 수집 준비", new Error("Discord HTTP module/token could not be found")); return;}
		this.beginCollectionDiagnostics(scope, mode, bundle);
		this.preferredFetchTransport = null;
		this.abortCollect = false;
		this.collecting = true;
		this.progressState = Object.assign(this.makeIdleProgress(), {active: true, mode, guildId: scope.cacheId, guildName: scope.name, status: "채널 목록 준비 중...", startedAt: Date.now(), updatedAt: Date.now()});
		this.refreshUi();
		let manifest = this.readManifest(scope.cacheId, scope.name, scope);
		try {
			const channels = scope.type === "dm" ? [scope.channel || {id: scope.sourceId, type: 1, name: scope.name}] : await this.getServerTargetChannels(scope.sourceId, bundle);
			this.setDiagnosticTargets(channels);
			if (!channels.length) throw new Error(`저장 대상 채널을 찾지 못했어. scope=${JSON.stringify({type: scope.type, sourceId: scope.sourceId, cacheId: scope.cacheId, name: scope.name})}`);
			this.progressState.channelsTotal = channels.length;
			this.refreshUi();
			for (let index = 0; index < channels.length && !this.abortCollect; index++) {
				const channel = channels[index];
				const state = this.getChannelState(manifest, channel);
				const loadedStoreCount = this.getLoadedMessagesForFetch(channel.id, 100000, null).length;
				const receivedBefore = this.progressState.received;
				const savedBefore = this.progressState.saved;
				this.recordChannelDiagnostic(channel, {loadedStoreCount});
				this.progressState.channelsDone = index;
				this.progressState.currentChannel = this.getDisplayChannelPath(channel, manifest);
				this.progressState.progress = channels.length ? index / channels.length * 100 : 0;
				this.setProgressStatus(`${mode === "recent" ? "최근 로그 추가 중" : "전체 로그 수집 중"}...\n${index + 1}/${channels.length} ${this.progressState.currentChannel}`);
				try {
					if (mode === "recent") await this.collectRecentForChannel(bundle, manifest, channel, state);
					else {
						await this.collectRecentForChannel(bundle, manifest, channel, state);
						if (!state.completeOlder) await this.collectOlderForChannel(bundle, manifest, channel, state);
					}
					state.errors = [];
					this.recordChannelDiagnostic(channel, {received: this.progressState.received - receivedBefore, saved: this.progressState.saved - savedBefore, error: ""});
				}
				catch (error) {
					this.progressState.failed++;
					const detail = error && (error.message || error.stack) || String(error);
					state.errors = [detail];
					this.recordChannelDiagnostic(channel, {received: this.progressState.received - receivedBefore, saved: this.progressState.saved - savedBefore, error: detail});
					console.warn("[ChatLogExporter] Channel collection failed", channel.id, error);
				}
				state.lastScanAt = Date.now();
				if (mode === "recent") state.lastRecentScanAt = Date.now();
				this.writeManifest(manifest);
				await this.sleep(this.settings.fetchDelayMs);
			}
			if (!this.abortCollect) {
				if (mode === "recent") manifest.lastRecentScanAt = Date.now();
				else manifest.lastFullScanAt = Date.now();
				this.progressState.channelsDone = channels.length;
				this.progressState.progress = 100;
				this.setProgressStatus(`수집 완료 · ${this.progressState.saved.toLocaleString()}개 새 메시지 저장`);
				this.writeManifest(manifest);
				if (Number(manifest.totalMessages || 0) === 0) {
					await this.reportZeroCollection(manifest, channels, scope);
					return;
				}
				this.finalizeCollectionDiagnostics(manifest, channels, {zero_message_failure: false});
				this.showPersistentNotice(`${scope.name} 로그 수집 완료`, `${this.progressState.saved.toLocaleString()}개 새 메시지를 저장했어.`, this.getGuildDir(scope.cacheId));
			}
			else this.setProgressStatus("수집을 중지했어. 지금까지 저장한 내용은 유지돼.");
		}
		catch (error) {
			try {this.finalizeCollectionDiagnostics(manifest, [], {fatal_error: error && (error.stack || error.message) || String(error)});} catch (_) {}
			await this.reportError(`${scope.type === "dm" ? "DM" : "서버"} 로그 수집`, error);
		}
		finally {
			this.collecting = false;
			this.progressState.active = false;
			this.progressState.updatedAt = Date.now();
			this.refreshUi();
			setTimeout(() => {if (!this.collecting && this.currentUi && this.currentUi.progressWrap) this.currentUi.progressWrap.style.display = "none";}, 1000);
		}
	}

	async collectRecentForChannel (bundle, manifest, channel, state) {
		const existingNewest = state.newestId;
		if (!existingNewest && state.messageCount > 0) return;
		let before = null;
		let foundExisting = false;
		for (let page = 0; page < 100000 && !this.abortCollect; page++) {
			this.progressState.requests++;
			const batch = await this.fetchMessages(bundle, channel.id, this.settings.pageSize, before);
			this.progressState.received += batch.length;
			if (!batch.length) break;
			let fresh = batch;
			if (existingNewest) {
				const boundary = batch.findIndex(message => this.compareSnowflakes(message.id, existingNewest) <= 0);
				if (boundary >= 0) {fresh = batch.slice(0, boundary); foundExisting = true;}
			}
			if (fresh.length) await this.appendMessages(manifest, channel, fresh);
			this.refreshUi();
			if (foundExisting || batch.length < this.settings.pageSize) break;
			before = batch[batch.length - 1].id;
			await this.sleep(this.settings.fetchDelayMs);
		}
		state.lastRecentScanAt = Date.now();
	}

	async collectOlderForChannel (bundle, manifest, channel, state) {
		let before = state.oldestId || null;
		for (let page = 0; page < 1000000 && !this.abortCollect; page++) {
			this.progressState.requests++;
			const batch = await this.fetchMessages(bundle, channel.id, this.settings.pageSize, before);
			this.progressState.received += batch.length;
			if (!batch.length) {state.completeOlder = true; break;}
			await this.appendMessages(manifest, channel, batch);
			before = batch[batch.length - 1].id;
			this.writeManifest(manifest);
			this.refreshUi();
			if (batch.length < this.settings.pageSize) {state.completeOlder = true; break;}
			await this.sleep(this.settings.fetchDelayMs);
		}
	}

	confirmReset (scopeName) {
		return new Promise(resolve => BdApi.UI.showConfirmationModal("ChatLogExporter", `“${scopeName}”의 ChatLogExporter 로컬 캐시를 전부 삭제하고 처음부터 다시 수집할까?\n\nDiscord 원본 메시지는 삭제되지 않아.`, {confirmText: "초기화 후 수집", cancelText: "취소", danger: true, onConfirm: () => resolve(true), onCancel: () => resolve(false)}));
	}

	stopCollecting () {this.abortCollect = true; this.setProgressStatus("중지 요청 중...");}

	getDisplayChannelPath (channel, manifest) {
		const state = manifest && manifest.channels && manifest.channels[String(channel.id)];
		const parentId = channel.parent_id || channel.parentId || state && state.parentId;
		let parentName = "";
		if (parentId && manifest && manifest.channels && manifest.channels[String(parentId)]) parentName = manifest.channels[String(parentId)].name;
		if (!parentName && parentId) {
			try {const parent = this.getStores().ChannelStore.getChannel(parentId); parentName = this.getChannelName(parent);} catch (_) {}
		}
		return parentName ? `${parentName} › ${this.getChannelName(channel)}` : this.getChannelName(channel);
	}

	setProgressStatus (text) {
		this.progressState.status = String(text || "");
		this.progressState.updatedAt = Date.now();
		this.refreshUi();
	}

	async exportCurrentServer (scopeInfo = null) {
		if (this.exporting || this.collecting) return;
		const scope = scopeInfo || this.getActiveScopeInfo();
		if (!scope || !scope.cacheId) {BdApi.UI.alert("ChatLogExporter", "서버 또는 DM 대화방을 우클릭해서 ChatLogExporter를 열어줘."); return;}
		const manifest = this.readManifest(scope.cacheId, scope.name, scope);
		if (!manifest.totalMessages) {BdApi.UI.alert("ChatLogExporter", "저장된 로그가 없어. 먼저 전체 수집이나 최근 업데이트를 실행해줘."); return;}
		this.exporting = true;
		this.progressState = Object.assign(this.makeIdleProgress(), {active: true, mode: "export", guildId: scope.cacheId, guildName: scope.name, status: "내보내기 준비 중...", startedAt: Date.now(), updatedAt: Date.now(), channelsTotal: Object.keys(manifest.channels).length});
		this.refreshUi();
		try {
			this.fs.mkdirSync(this.getOutputFolder(), {recursive: true});
			const stamp = this.formatFileTimestamp(new Date());
			const baseName = `${this.sanitizeFileName(scope.name)}_ChatLogs_${stamp}`;
			const format = String(this.settings.exportFormat || "ai_archive").toLowerCase();
			let outputPath;
			if (format === "ai_archive") outputPath = await this.exportAiPackage(manifest, baseName, "archive");
			else if (format === "compact_jsonl") outputPath = await this.exportAiPackage(manifest, baseName, "jsonl");
			else if (format === "markdown_zip") outputPath = await this.exportAiPackage(manifest, baseName, "markdown");
			else if (format === "csv") outputPath = await this.exportCsv(manifest, baseName);
			else if (format === "docx") outputPath = await this.exportDocx(manifest, baseName);
			else outputPath = await this.exportTxt(manifest, baseName);
			this.progressState.progress = 100;
			this.setProgressStatus(`내보내기 완료\n${outputPath}`);
			this.showPersistentNotice(`${scope.name} 내보내기 완료`, this.path.basename(outputPath), this.path.dirname(outputPath));
		}
		catch (error) {await this.reportError("로그 파일 내보내기", error);}
		finally {
			this.exporting = false;
			this.progressState.active = false;
			this.refreshUi();
			setTimeout(() => {if (!this.exporting && this.currentUi && this.currentUi.progressWrap) this.currentUi.progressWrap.style.display = "none";}, 1000);
		}
	}

	getOrderedChannelStates (manifest) {
		return Object.values(manifest.channels || {}).filter(state => state && state.messageCount > 0).sort((left, right) => {
			const parentCompare = String(left.parentId || "").localeCompare(String(right.parentId || ""));
			if (parentCompare) return parentCompare;
			const positionCompare = Number(left.position || 0) - Number(right.position || 0);
			if (positionCompare) return positionCompare;
			return String(left.name || left.id).localeCompare(String(right.name || right.id), "ko");
		});
	}

	async readChannelMessages (guildId, channelId, onProgress = null) {
		const file = this.getChannelDataPath(guildId, channelId);
		if (!this.fs.existsSync(file)) return [];
		let fileSize = 0;
		try {fileSize = Number(this.fs.statSync(file).size) || 0;} catch (_) {}
		const map = new Map();
		const acceptLine = rawLine => {
			const line = String(rawLine || "").replace(/\r$/, "");
			if (!line.trim()) return;
			try {
				const message = JSON.parse(line);
				if (message && message.id) map.set(String(message.id), message);
			}
			catch (_) {}
		};

		// BetterDiscord may resolve Node's built-in `readline` as a path inside
		// Discord's installation folder. Parse JSONL directly from the fs stream
		// instead, keeping only an unfinished line in memory.
		if (this.fs && typeof this.fs.createReadStream === "function") {
			await new Promise((resolve, reject) => {
				let remainder = "";
				let bytesRead = 0;
				let lastProgressAt = 0;
				const input = this.fs.createReadStream(file, {encoding: "utf8"});
				input.on("data", chunk => {
					const chunkText = String(chunk);
					bytesRead += Buffer.byteLength(chunkText, "utf8");
					remainder += chunkText;
					let newline = remainder.indexOf("\n");
					while (newline >= 0) {
						acceptLine(remainder.slice(0, newline));
						remainder = remainder.slice(newline + 1);
						newline = remainder.indexOf("\n");
					}
					const now = Date.now();
					if (typeof onProgress === "function" && (now - lastProgressAt >= 200 || bytesRead >= fileSize)) {
						lastProgressAt = now;
						try {onProgress({bytesRead, totalBytes: fileSize, ratio: fileSize ? Math.min(1, bytesRead / fileSize) : 0});} catch (_) {}
					}
				});
				input.once("error", reject);
				input.once("end", () => {
					acceptLine(remainder);
					if (typeof onProgress === "function") {try {onProgress({bytesRead: fileSize || bytesRead, totalBytes: fileSize || bytesRead, ratio: 1});} catch (_) {}}
					resolve();
				});
			});
		}
		else {
			const text = this.fs.readFileSync(file, "utf8");
			for (const line of String(text).split(/\n/)) acceptLine(line);
			if (typeof onProgress === "function") {try {onProgress({bytesRead: fileSize, totalBytes: fileSize, ratio: 1});} catch (_) {}}
		}

		const messages = Array.from(map.values());
		messages.sort((a, b) => {
			const delta = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
			return this.settings.exportOrder === "newest" ? -delta : delta;
		});
		return messages;
	}


	async exportAiPackage (manifest, baseName, mode = "archive") {
		const tempRoot = this.path.join(this.getCacheRoot(), `.ai-export-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const messagesRoot = this.path.join(tempRoot, "messages");
		const readableRoot = this.path.join(tempRoot, "readable");
		this.fs.mkdirSync(tempRoot, {recursive: true});
		if (mode !== "markdown") this.fs.mkdirSync(messagesRoot, {recursive: true});
		if (mode !== "jsonl") this.fs.mkdirSync(readableRoot, {recursive: true});

		const exportedAt = new Date();
		const users = {};
		const channelMap = {};
		const fileEntries = [];
		let actualMessageCount = 0;
		let earliest = null;
		let latest = null;
		const channels = this.getOrderedChannelStates(manifest);
		const splitMessages = Math.max(1000, Number(this.settings.aiSplitMessages) || 25000);
		const splitBytes = Math.max(1, Number(this.settings.aiSplitSizeMB) || 10) * 1024 * 1024;
		const estimatedTotalMessages = channels.reduce((sum, channel) => sum + Math.max(1, Number(channel.messageCount) || 1), 0);
		let completedWeight = 0;
		let processedMessages = 0;
		this.progressState.totalItems = estimatedTotalMessages;
		this.progressState.processedItems = 0;

		for (const channel of Object.values(manifest.channels || {})) {
			if (!channel || !channel.id) continue;
			channelMap[String(channel.id)] = this.buildAiChannelRecord(channel, manifest);
		}

		for (let index = 0; index < channels.length; index++) {
			const channel = channels[index];
			const channelName = this.channelDisplayName(channel, manifest);
			const channelWeight = Math.max(1, Number(channel.messageCount) || 1);
			const updateChannelProgress = (phase, phaseRatio = 0, done = 0, total = 0) => {
				const ratio = Math.max(0, Math.min(1, Number(phaseRatio) || 0));
				const weightedRatio = phase === "read" ? ratio * 0.12 : 0.12 + ratio * 0.88;
				const overall = estimatedTotalMessages ? (completedWeight + channelWeight * weightedRatio) / estimatedTotalMessages * 90 : 0;
				this.updateExportProgress(index, channels.length, channelName, {overall, phase, done, total, processed: processedMessages + done, grandTotal: estimatedTotalMessages});
			};
			updateChannelProgress("read", 0, 0, Number(channel.messageCount) || 0);
			const messages = await this.readChannelMessages(manifest.guildId, channel.id, info => updateChannelProgress("read", info && info.ratio || 0, 0, Number(channel.messageCount) || 0));
			if (!messages.length) {
				completedWeight += channelWeight;
				continue;
			}
			let processedInChannel = 0;
			const channelSlug = `${String(channel.id)}_${this.slugPathPart(channel.rawName || channel.name || "channel")}`;
			const grouped = new Map();
			for (const message of messages) {
				const date = new Date(message.timestamp);
				const month = Number.isFinite(date.getTime()) ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}` : "unknown-date";
				if (!grouped.has(month)) grouped.set(month, []);
				grouped.get(month).push(message);
			}

			for (const [month, monthMessages] of grouped) {
				let part = 1;
				let partCount = 0;
				let partBytes = 0;
				let jsonStream = null;
				let mdStream = null;
				let jsonRel = "";
				let mdRel = "";
				let jsonBuffer = [];
				let mdBuffer = [];
				let bufferedBytes = 0;
				let bufferedMessages = 0;
				const flushBuffers = async () => {
					if (jsonStream && jsonBuffer.length) await this.writeStream(jsonStream, jsonBuffer.join(""));
					if (mdStream && mdBuffer.length) await this.writeStream(mdStream, mdBuffer.join(""));
					jsonBuffer = [];
					mdBuffer = [];
					bufferedBytes = 0;
					bufferedMessages = 0;
				};
				const openPart = async () => {
					await flushBuffers();
					if (jsonStream) await this.finishStream(jsonStream);
					if (mdStream) await this.finishStream(mdStream);
					partCount = 0;
					partBytes = 0;
					const suffix = `.part${String(part).padStart(3, "0")}`;
					if (mode !== "markdown") {
						jsonRel = this.path.posix.join("messages", channelSlug, `${month}${suffix}.jsonl`);
						const jsonFile = this.path.join(tempRoot, ...jsonRel.split("/"));
						this.fs.mkdirSync(this.path.dirname(jsonFile), {recursive: true});
						jsonStream = this.fs.createWriteStream(jsonFile, {encoding: "utf8"});
						fileEntries.push({path: jsonRel, kind: "messages_jsonl", channel_id: String(channel.id), month, part});
					}
					if (mode !== "jsonl") {
						mdRel = this.path.posix.join("readable", channelSlug, `${month}${suffix}.md`);
						const mdFile = this.path.join(tempRoot, ...mdRel.split("/"));
						this.fs.mkdirSync(this.path.dirname(mdFile), {recursive: true});
						mdStream = this.fs.createWriteStream(mdFile, {encoding: "utf8"});
						await this.writeStream(mdStream, this.buildMarkdownHeader(manifest, channel, month, part));
						fileEntries.push({path: mdRel, kind: "readable_markdown", channel_id: String(channel.id), month, part});
					}
					part++;
				};
				await openPart();

				for (const message of monthMessages) {
					const record = this.buildAiMessageRecord(message, manifest, channel);
					const line = JSON.stringify(record) + "\n";
					const estimatedBytes = Buffer.byteLength(line, "utf8");
					if (partCount > 0 && (partCount >= splitMessages || partBytes + estimatedBytes > splitBytes)) await openPart();
					if (jsonStream) jsonBuffer.push(line);
					if (mdStream) mdBuffer.push(this.buildMarkdownMessage(record));
					bufferedBytes += estimatedBytes;
					bufferedMessages++;
					partCount++;
					partBytes += estimatedBytes;
					actualMessageCount++;
					processedInChannel++;
					if (bufferedMessages >= 500 || bufferedBytes >= 1024 * 1024) await flushBuffers();
					if (processedInChannel % 250 === 0 || processedInChannel === messages.length) {
						updateChannelProgress("write", processedInChannel / messages.length, processedInChannel, messages.length);
					}
					const timestamp = new Date(record.timestamp).getTime();
					if (Number.isFinite(timestamp)) {
						if (earliest == null || timestamp < earliest) earliest = timestamp;
						if (latest == null || timestamp > latest) latest = timestamp;
					}
					this.registerAiUser(users, record.author, record.timestamp, true);
					for (const mention of record.mentions || []) this.registerAiUser(users, mention, record.timestamp, false);
					if (record.reply && record.reply.author) this.registerAiUser(users, record.reply.author, record.timestamp, false);
				}
				await flushBuffers();
				if (jsonStream) await this.finishStream(jsonStream);
				if (mdStream) await this.finishStream(mdStream);
			}
			processedMessages += messages.length;
			completedWeight += channelWeight;
			this.progressState.processedItems = processedMessages;
			this.updateExportProgress(index + 1, channels.length, channelName, {overall: estimatedTotalMessages ? completedWeight / estimatedTotalMessages * 90 : 90, phase: "write", done: messages.length, total: messages.length, processed: processedMessages, grandTotal: estimatedTotalMessages, completed: true});
		}

		const archiveType = mode === "archive" ? "AI Archive" : mode === "jsonl" ? "Compact JSONL Archive" : "Readable Markdown Archive";
		const archiveManifest = {
			format: "ChatLogExporter AI Archive",
			format_version: "2.0",
			archive_type: archiveType,
			generator: {name: this.name, version: this.version},
			scope: {type: manifest.scopeType || "guild", id: String(manifest.sourceId || manifest.guildId), name: manifest.guildName},
			server: manifest.scopeType === "dm" ? null : {id: String(manifest.sourceId || manifest.guildId), name: manifest.guildName},
			direct_message: manifest.scopeType === "dm" ? {channel_id: String(manifest.sourceId || manifest.dmChannelId || ""), name: manifest.guildName} : null,
			exported_at: exportedAt.toISOString(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
			message_order: this.settings.exportOrder === "newest" ? "newest_first" : "oldest_first",
			counts: {messages: actualMessageCount, channels: Object.keys(channelMap).length, channels_with_messages: channels.length, users: Object.keys(users).length},
			time_range: {earliest: earliest == null ? null : new Date(earliest).toISOString(), latest: latest == null ? null : new Date(latest).toISOString()},
			cache_snapshot: {created_at: manifest.createdAt ? new Date(manifest.createdAt).toISOString() : null, updated_at: manifest.updatedAt ? new Date(manifest.updatedAt).toISOString() : null, last_full_scan_at: manifest.lastFullScanAt ? new Date(manifest.lastFullScanAt).toISOString() : null, last_recent_scan_at: manifest.lastRecentScanAt ? new Date(manifest.lastRecentScanAt).toISOString() : null},
			identity_notes: [
				"author.id is the stable identity key; usernames and display names may change over time.",
				"channel.parent_id links forum posts and threads to their parent channel.",
				"reply.message_id links a message to the message it replies to when Discord provided that relationship.",
				"Timestamps are ISO-8601 strings and should be treated as authoritative ordering metadata."
			],
			file_structure: {
				"manifest.json": "Archive summary and interpretation notes.",
				"users.json": "Stable user identity map aggregated from exported messages.",
				"channels.json": "Channel, forum, thread, and parent-child hierarchy map.",
				"messages/**/*.jsonl": "One structured message object per line, split by channel, UTC month, message count, and approximate file size.",
				"readable/**/*.md": "Chronological human/LLM-readable transcripts mirroring the structured data.",
				"README_FOR_AI.md": "Concise instructions for an LLM analyzing this archive.",
				"message.schema.json": "Field-level schema for JSONL records."
			},
			files: fileEntries,
			export_options: {include_attachments: !!this.settings.includeAttachments, include_embeds: !!this.settings.includeEmbeds, include_reactions: !!this.settings.includeReactions, include_reply_info: !!this.settings.includeReplyInfo, include_message_links: !!this.settings.includeMessageLinks, include_ids: !!this.settings.includeIds, include_edited_at: !!this.settings.includeEditedAt, split_messages: splitMessages, split_size_mb: Number(this.settings.aiSplitSizeMB) || 10}
		};

		this.fs.writeFileSync(this.path.join(tempRoot, "manifest.json"), JSON.stringify(archiveManifest, null, 2), "utf8");
		this.fs.writeFileSync(this.path.join(tempRoot, "users.json"), JSON.stringify(users, null, 2), "utf8");
		this.fs.writeFileSync(this.path.join(tempRoot, "channels.json"), JSON.stringify(channelMap, null, 2), "utf8");
		this.fs.writeFileSync(this.path.join(tempRoot, "message.schema.json"), JSON.stringify(this.getAiMessageSchema(), null, 2), "utf8");
		this.fs.writeFileSync(this.path.join(tempRoot, "README_FOR_AI.md"), this.buildAiReadme(archiveManifest), "utf8");

		const suffix = mode === "archive" ? "AI_Archive" : mode === "jsonl" ? "Compact_JSONL" : "Readable_Markdown";
		const output = this.path.join(this.getOutputFolder(), `${baseName.replace(/_ChatLogs_/, `_${suffix}_`)}.zip`);
		this.progressState.phase = "zip";
		this.progressState.currentChannel = "AI Archive ZIP";
		this.progressState.status = "ZIP 묶는 중...";
		this.progressState.progress = Math.max(90, Number(this.progressState.progress) || 0);
		this.refreshUi();
		await this.createStoredZip(tempRoot, output, info => {
			const ratio = info && Number(info.ratio) || 0;
			this.progressState.progress = 90 + Math.max(0, Math.min(1, ratio)) * 10;
			this.progressState.currentChannel = info && info.name ? `ZIP · ${info.name}` : "AI Archive ZIP";
			this.progressState.status = `ZIP 묶는 중...\n${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
			this.refreshUi();
		});
		try {this.fs.rmSync(tempRoot, {recursive: true, force: true});} catch (_) {}
		return output;
	}

	buildAiChannelRecord (channel, manifest) {
		const parent = channel.parentId && manifest.channels && manifest.channels[String(channel.parentId)] || null;
		return {
			id: String(channel.id),
			server_id: manifest.scopeType === "dm" ? null : String(manifest.sourceId || manifest.guildId),
			scope_type: manifest.scopeType || "guild",
			scope_id: String(manifest.sourceId || manifest.guildId),
			name: channel.rawName || String(channel.name || "").replace(/^#/, "") || String(channel.id),
			display_name: this.channelDisplayName(channel, manifest),
			type: channel.type,
			type_label: channel.typeLabel || "",
			parent_id: channel.parentId ? String(channel.parentId) : null,
			parent_name: parent ? parent.rawName || String(parent.name || "").replace(/^#/, "") : channel.parentName || null,
			is_thread_or_forum_post: [10, 11, 12].includes(Number(channel.type)),
			is_forum_post: Number(channel.type) === 11 && !!channel.parentId,
			message_count: Number(channel.messageCount || 0),
			oldest_message_id: channel.oldestId || null,
			newest_message_id: channel.newestId || null,
			collection_complete_to_oldest: !!channel.completeOlder
		};
	}

	buildAiMessageRecord (message, manifest, channel) {
		const author = message.author || {};
		const reference = message.referenced_message || message.message_reference || null;
		const channelRecord = this.buildAiChannelRecord(channel, manifest);
		const replyAuthor = reference && reference.author || null;
		return {
			schema_version: "2.0",
			message_id: String(message.id || ""),
			server_id: manifest.scopeType === "dm" ? null : String(manifest.sourceId || manifest.guildId),
			server_name: manifest.scopeType === "dm" ? null : manifest.guildName,
			scope_type: manifest.scopeType || "guild",
			scope_id: String(manifest.sourceId || manifest.guildId),
			conversation_name: manifest.guildName,
			channel: {
				id: String(channel.id),
				name: channelRecord.name,
				display_name: channelRecord.display_name,
				type: channelRecord.type,
				type_label: channelRecord.type_label,
				parent_id: channelRecord.parent_id,
				parent_name: channelRecord.parent_name
			},
			author: {id: String(author.id || ""), username: author.username || "Unknown", display_name: author.global_name || author.username || "Unknown", discriminator: author.discriminator || "0", is_bot: !!author.bot},
			timestamp: String(message.timestamp || ""),
			edited_timestamp: this.settings.includeEditedAt ? message.edited_timestamp || null : null,
			content: String(message.content || ""),
			message_type: Number(message.type || 0),
			reply: this.settings.includeReplyInfo && reference ? {message_id: String(reference.id || reference.message_id || ""), channel_id: String(reference.channel_id || reference.channelId || message.channel_id || channel.id || ""), author: replyAuthor ? {id: String(replyAuthor.id || ""), username: replyAuthor.username || "", display_name: replyAuthor.global_name || replyAuthor.globalName || replyAuthor.username || ""} : null, content_preview: reference.content ? String(reference.content).slice(0, 500) : null} : null,
			mentions: Array.isArray(message.mentions) ? message.mentions.map(user => ({id: String(user.id || ""), username: user.username || "", display_name: user.global_name || user.globalName || user.username || "", is_bot: !!user.bot})) : [],
			mention_role_ids: Array.isArray(message.mention_roles) ? message.mention_roles.map(String) : [],
			mention_everyone: !!message.mention_everyone,
			attachments: this.settings.includeAttachments ? (message.attachments || []).map(item => ({id: String(item.id || ""), filename: item.filename || "", url: item.url || "", content_type: item.content_type || "", size_bytes: Number(item.size || 0), width: item.width || null, height: item.height || null})) : [],
			embeds: this.settings.includeEmbeds ? (message.embeds || []).map(embed => ({type: embed.type || "", title: embed.title || "", description: embed.description || "", url: embed.url || "", fields: embed.fields || []})) : [],
			reactions: this.settings.includeReactions ? (message.reactions || []).map(item => ({emoji: item.emoji || "", count: Number(item.count || 0), reacted_by_current_user: !!item.me})) : [],
			stickers: Array.isArray(message.sticker_items) ? message.sticker_items : [],
			pinned: !!message.pinned,
			tts: !!message.tts,
			flags: Number(message.flags || 0),
			message_url: this.settings.includeMessageLinks ? this.buildMessageUrl(manifest, message.channel_id || channel.id, message.id) : null
		};
	}

	registerAiUser (users, author, timestamp = null, countMessage = false) {
		if (!author || !author.id) return;
		const id = String(author.id);
		if (!users[id]) users[id] = {id, usernames: [], display_names: [], is_bot: !!author.is_bot, message_count: 0, first_seen_in_export: null, last_seen_in_export: null};
		const user = users[id];
		for (const value of [author.username]) if (value && !user.usernames.includes(value)) user.usernames.push(value);
		for (const value of [author.display_name]) if (value && !user.display_names.includes(value)) user.display_names.push(value);
		user.is_bot = user.is_bot || !!author.is_bot;
		if (countMessage) user.message_count++;
		const time = timestamp ? new Date(timestamp).getTime() : NaN;
		if (Number.isFinite(time)) {
			if (!user.first_seen_in_export || time < new Date(user.first_seen_in_export).getTime()) user.first_seen_in_export = new Date(time).toISOString();
			if (!user.last_seen_in_export || time > new Date(user.last_seen_in_export).getTime()) user.last_seen_in_export = new Date(time).toISOString();
		}
	}

	buildMarkdownHeader (manifest, channel, month, part) {
		const parent = this.parentChannelName(channel, manifest);
		return `# ${this.escapeMarkdown(manifest.guildName)}\n\n## ${this.escapeMarkdown(this.channelDisplayName(channel, manifest))}\n\n- Scope: ${manifest.scopeType === "dm" ? "Direct message" : "Server"}\n- Scope ID: \`${manifest.sourceId || manifest.guildId}\`\n- Channel ID: \`${channel.id}\`\n- Channel type: ${this.escapeMarkdown(channel.typeLabel || "")}\n${parent ? `- Parent channel/forum: ${this.escapeMarkdown(parent)}\n` : ""}- UTC month: ${month}\n- Part: ${part}\n\n---\n\n`;
	}

	buildMarkdownMessage (record) {
		const author = record.author || {};
		const username = author.username && author.username !== author.display_name ? ` (@${author.username})` : "";
		let text = `### ${record.timestamp} — ${this.escapeMarkdown(author.display_name || author.username || "Unknown")}${this.escapeMarkdown(username)}${author.is_bot ? " [BOT]" : ""}\n\n`;
		if (record.reply) {
			const replyName = record.reply.author && (record.reply.author.display_name || record.reply.author.username) || "unknown";
			text += `> ↩ Reply to ${this.escapeMarkdown(replyName)} · message \`${record.reply.message_id || "?"}\``;
			if (record.reply.content_preview) text += `\n> ${this.escapeMarkdown(String(record.reply.content_preview).replace(/\n/g, "\n> "))}`;
			text += "\n\n";
		}
		text += `${record.content ? String(record.content) : "*(no text content)*"}\n\n`;
		if (record.edited_timestamp) text += `- Edited: ${record.edited_timestamp}\n`;
		if (record.attachments && record.attachments.length) {
			text += `- Attachments:\n`;
			for (const item of record.attachments) text += `  - ${this.escapeMarkdown(item.filename || "file")}${item.url ? ` — ${item.url}` : ""}${item.content_type ? ` (${item.content_type})` : ""}\n`;
		}
		if (record.embeds && record.embeds.length) {
			text += `- Embeds:\n`;
			for (const embed of record.embeds) text += `  - ${this.escapeMarkdown([embed.title, embed.description, embed.url].filter(Boolean).join(" — "))}\n`;
		}
		if (record.reactions && record.reactions.length) text += `- Reactions: ${record.reactions.map(item => `${this.escapeMarkdown(item.emoji)} ×${item.count}`).join(", ")}\n`;
		if (record.mentions && record.mentions.length) text += `- Mentions: ${record.mentions.map(user => `${this.escapeMarkdown(user.display_name || user.username || user.id)} (\`${user.id}\`)`).join(", ")}\n`;
		if (record.message_url) text += `- Source: ${record.message_url}\n`;
		text += `- Message ID: \`${record.message_id}\`\n\n---\n\n`;
		return text;
	}

	buildAiReadme (archiveManifest) {
		return `# README FOR AI\n\nThis archive contains Discord conversation logs prepared for language-model analysis.\n\n## Recommended interpretation order\n\n1. Read \`manifest.json\` for scope, counts, time range, and archive structure.\n2. Read \`channels.json\` to understand channel, forum, post, and thread hierarchy.\n3. Read \`users.json\` to map stable user IDs to usernames and display names.\n4. Analyze \`messages/**/*.jsonl\` for exact structured data. Each line is one independent JSON message object.\n5. Use \`readable/**/*.md\` for natural chronological reading and dialogue-style analysis.\n\n## Identity and context rules\n\n- Treat \`author.id\` as the stable identity key. Names can change.\n- Use \`channel.parent_id\` and \`channel.parent_name\` to associate forum posts or threads with their parent channel.\n- Use \`reply.message_id\` to reconstruct explicit reply relationships.\n- Preserve message chronology using the ISO-8601 \`timestamp\`.\n- Empty message text may still carry attachments, embeds, stickers, or system meaning.\n- Do not assume that every conversational reply used Discord's reply feature; nearby chronological messages may still belong to the same exchange.\n\n## Archive summary\n\n- Scope: ${(archiveManifest.scope && archiveManifest.scope.name || "Unknown")} (\`${(archiveManifest.scope && archiveManifest.scope.id || "")}\`)\n- Messages: ${archiveManifest.counts.messages}\n- Users: ${archiveManifest.counts.users}\n- Channels/posts/threads: ${archiveManifest.counts.channels}\n- Earliest message: ${archiveManifest.time_range.earliest || "unknown"}\n- Latest message: ${archiveManifest.time_range.latest || "unknown"}\n- Exported at: ${archiveManifest.exported_at}\n`;
	}

	getAiMessageSchema () {
		return {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			title: "ChatLogExporter AI message record",
			type: "object",
			required: ["schema_version", "message_id", "scope_type", "scope_id", "channel", "author", "timestamp", "content"],
			properties: {
				schema_version: {type: "string"}, message_id: {type: "string"}, scope_type: {type: "string", enum: ["guild", "dm"]}, scope_id: {type: "string"}, conversation_name: {type: "string"}, server_id: {type: ["string", "null"]}, server_name: {type: ["string", "null"]},
				channel: {type: "object", description: "Channel or forum-post/thread context, including parent hierarchy."},
				author: {type: "object", description: "Stable author ID plus username and display name at export time."},
				timestamp: {type: "string", format: "date-time"}, edited_timestamp: {type: ["string", "null"]}, content: {type: "string"},
				reply: {type: ["object", "null"]}, mentions: {type: "array"}, attachments: {type: "array"}, embeds: {type: "array"}, reactions: {type: "array"}, message_url: {type: ["string", "null"]}
			}
		};
	}

	escapeMarkdown (value) {return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/([`*_{}\[\]()#+.!|>-])/g, "\\$1");}
	slugPathPart (value) {return this.sanitizeFileName(String(value || "channel").replace(/^#/, "")).replace(/\s+/g, "_").slice(0, 80) || "channel";}
	finishStream (stream) {return new Promise((resolve, reject) => {stream.once("error", reject); stream.end(resolve);});}

	async exportTxt (manifest, baseName) {
		const output = this.path.join(this.getOutputFolder(), `${baseName}.txt`);
		const stream = this.fs.createWriteStream(output, {encoding: "utf8"});
		await this.writeStream(stream, `${manifest.scopeType === "dm" ? "DM" : "서버"}: ${manifest.guildName}\n대상 ID: ${manifest.sourceId || manifest.guildId}\n내보낸 시각: ${this.formatDate(new Date())}\n저장 메시지 수: ${manifest.totalMessages.toLocaleString()}\n\n`);
		const channels = this.getOrderedChannelStates(manifest);
		for (let index = 0; index < channels.length; index++) {
			const channel = channels[index];
			this.updateExportProgress(index, channels.length, channel.name);
			await this.writeStream(stream, `${"=".repeat(80)}\n채널: ${this.channelDisplayName(channel, manifest)}\n채널 ID: ${channel.id}\n종류: ${channel.typeLabel || ""}\n${"=".repeat(80)}\n\n`);
			for (const message of await this.readChannelMessages(manifest.guildId, channel.id)) await this.writeStream(stream, this.formatTxtMessage(message, manifest, channel));
			await this.writeStream(stream, "\n");
		}
		await new Promise((resolve, reject) => {stream.on("error", reject); stream.end(resolve);});
		return output;
	}

	formatTxtMessage (message, manifest) {
		const author = message.author || {};
		const display = author.global_name || author.username || "Unknown";
		const username = author.username && author.username !== display ? ` (@${author.username})` : "";
		const ids = this.settings.includeIds ? ` [user:${author.id || "?"} message:${message.id}]` : "";
		let text = `[${this.formatDate(message.timestamp)}] ${display}${username}${author.bot ? " [BOT]" : ""}${ids}\n${message.content || "(내용 없음)"}\n`;
		if (this.settings.includeEditedAt && message.edited_timestamp) text += `수정됨: ${this.formatDate(message.edited_timestamp)}\n`;
		if (this.settings.includeReplyInfo) {
			const reference = message.referenced_message || message.message_reference;
			if (reference) text += `답장 대상: ${reference.id || reference.message_id || "?"}${reference.author ? ` / ${reference.author.global_name || reference.author.username || ""}` : ""}${reference.content ? ` / ${reference.content.replace(/\s+/g, " ").slice(0, 160)}` : ""}\n`;
		}
		if (this.settings.includeAttachments && message.attachments && message.attachments.length) text += `첨부: ${message.attachments.map(item => `${item.filename || "file"} ${item.url || ""}`.trim()).join(" | ")}\n`;
		if (this.settings.includeEmbeds && message.embeds && message.embeds.length) text += `임베드: ${message.embeds.map(embed => [embed.title, embed.description, embed.url].filter(Boolean).join(" — ")).filter(Boolean).join(" | ")}\n`;
		if (this.settings.includeReactions && message.reactions && message.reactions.length) text += `반응: ${message.reactions.map(item => `${item.emoji} ×${item.count}`).join(", ")}\n`;
		if (this.settings.includeMessageLinks) text += `링크: ${this.buildMessageUrl(manifest, message.channel_id, message.id)}\n`;
		return text + "\n";
	}

	async exportCsv (manifest, baseName) {
		const output = this.path.join(this.getOutputFolder(), `${baseName}.csv`);
		const stream = this.fs.createWriteStream(output, {encoding: "utf8"});
		const columns = ["server_name", "server_id", "channel_name", "channel_id", "parent_channel", "channel_type", "message_id", "date", "edited_date", "display_name", "username", "user_id", "is_bot", "message_type", "content", "attachments", "embeds", "reactions", "reply_to_message_id", "message_url"];
		await this.writeStream(stream, "\uFEFF" + columns.join(",") + "\n");
		const channels = this.getOrderedChannelStates(manifest);
		for (let index = 0; index < channels.length; index++) {
			const channel = channels[index];
			this.updateExportProgress(index, channels.length, channel.name);
			for (const message of await this.readChannelMessages(manifest.guildId, channel.id)) {
				const author = message.author || {};
				const reference = message.referenced_message || message.message_reference || {};
				const row = [
					manifest.scopeType === "dm" ? manifest.guildName : manifest.guildName, manifest.scopeType === "dm" ? "" : (manifest.sourceId || manifest.guildId), this.channelDisplayName(channel, manifest), channel.id, this.parentChannelName(channel, manifest), channel.typeLabel || "",
					message.id, this.formatDate(message.timestamp), message.edited_timestamp ? this.formatDate(message.edited_timestamp) : "",
					author.global_name || author.username || "Unknown", author.username || "", author.id || "", author.bot ? "true" : "false", message.type,
					message.content || "",
					this.settings.includeAttachments ? (message.attachments || []).map(item => `${item.filename || "file"}|${item.url || ""}`).join(" ; ") : "",
					this.settings.includeEmbeds ? (message.embeds || []).map(embed => [embed.title, embed.description, embed.url].filter(Boolean).join(" | ")).join(" ; ") : "",
					this.settings.includeReactions ? (message.reactions || []).map(item => `${item.emoji} x${item.count}`).join(" ; ") : "",
					this.settings.includeReplyInfo ? reference.id || reference.message_id || "" : "",
					this.settings.includeMessageLinks ? this.buildMessageUrl(manifest, message.channel_id, message.id) : ""
				];
				await this.writeStream(stream, row.map(value => this.csvEscape(value)).join(",") + "\n");
			}
		}
		await new Promise((resolve, reject) => {stream.on("error", reject); stream.end(resolve);});
		return output;
	}

	async exportDocx (manifest, baseName) {
		const tempRoot = this.path.join(this.getCacheRoot(), `.docx-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const wordDir = this.path.join(tempRoot, "word");
		const relsDir = this.path.join(tempRoot, "_rels");
		const wordRelsDir = this.path.join(wordDir, "_rels");
		const propsDir = this.path.join(tempRoot, "docProps");
		for (const dir of [tempRoot, wordDir, relsDir, wordRelsDir, propsDir]) this.fs.mkdirSync(dir, {recursive: true});
		const documentPath = this.path.join(wordDir, "document.xml");
		const stream = this.fs.createWriteStream(documentPath, {encoding: "utf8"});
		await this.writeStream(stream, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`);
		await this.writeStream(stream, this.docxParagraph(manifest.guildName, "Title"));
		await this.writeStream(stream, this.docxParagraph(`${manifest.scopeType === "dm" ? "DM 채널 ID" : "서버 ID"}: ${manifest.sourceId || manifest.guildId} · 내보낸 시각: ${this.formatDate(new Date())} · 메시지: ${manifest.totalMessages.toLocaleString()}개`, "Subtitle"));
		const channels = this.getOrderedChannelStates(manifest);
		for (let index = 0; index < channels.length; index++) {
			const channel = channels[index];
			this.updateExportProgress(index, channels.length, channel.name);
			await this.writeStream(stream, this.docxParagraph(this.channelDisplayName(channel, manifest), "Heading1"));
			await this.writeStream(stream, this.docxParagraph(`${channel.typeLabel || ""}${this.settings.includeIds ? ` · 채널 ID ${channel.id}` : ""}`, "Subtitle"));
			for (const message of await this.readChannelMessages(manifest.guildId, channel.id)) {
				const author = message.author || {};
				const name = `${author.global_name || author.username || "Unknown"}${author.username && author.global_name ? ` (@${author.username})` : ""}${author.bot ? " [BOT]" : ""}`;
				await this.writeStream(stream, this.docxMessageParagraph(message, name, manifest));
			}
		}
		await this.writeStream(stream, `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
		await new Promise((resolve, reject) => {stream.on("error", reject); stream.end(resolve);});

		this.fs.writeFileSync(this.path.join(tempRoot, "[Content_Types].xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`, "utf8");
		this.fs.writeFileSync(this.path.join(relsDir, ".rels"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`, "utf8");
		this.fs.writeFileSync(this.path.join(wordRelsDir, "document.xml.rels"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`, "utf8");
		this.fs.writeFileSync(this.path.join(wordDir, "styles.xml"), this.docxStylesXml(), "utf8");
		const iso = new Date().toISOString();
		this.fs.writeFileSync(this.path.join(propsDir, "core.xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${this.xmlEscape(manifest.guildName)} Chat Logs</dc:title><dc:creator>ChatLogExporter</dc:creator><cp:lastModifiedBy>ChatLogExporter</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`, "utf8");
		this.fs.writeFileSync(this.path.join(propsDir, "app.xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>ChatLogExporter</Application></Properties>`, "utf8");

		const output = this.path.join(this.getOutputFolder(), `${baseName}.docx`);
		await this.createStoredZip(tempRoot, output);
		try {this.fs.rmSync(tempRoot, {recursive: true, force: true});} catch (_) {}
		return output;
	}

	docxStylesXml () {
		return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Malgun Gothic"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="38"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="666666"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style></w:styles>`;
	}

	docxParagraph (text, style = "Normal") {return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${this.xmlEscape(text)}</w:t></w:r></w:p>`;}

	docxMessageParagraph (message, authorName, manifest) {
		const lines = [];
		lines.push(message.content || "(내용 없음)");
		if (this.settings.includeEditedAt && message.edited_timestamp) lines.push(`수정됨: ${this.formatDate(message.edited_timestamp)}`);
		if (this.settings.includeReplyInfo) {
			const reference = message.referenced_message || message.message_reference;
			if (reference) lines.push(`답장 대상: ${reference.id || reference.message_id || "?"}${reference.content ? ` / ${reference.content.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
		}
		if (this.settings.includeAttachments && message.attachments && message.attachments.length) lines.push(`첨부: ${message.attachments.map(item => `${item.filename || "file"} ${item.url || ""}`.trim()).join(" | ")}`);
		if (this.settings.includeEmbeds && message.embeds && message.embeds.length) lines.push(`임베드: ${message.embeds.map(embed => [embed.title, embed.description, embed.url].filter(Boolean).join(" — ")).filter(Boolean).join(" | ")}`);
		if (this.settings.includeReactions && message.reactions && message.reactions.length) lines.push(`반응: ${message.reactions.map(item => `${item.emoji} ×${item.count}`).join(", ")}`);
		if (this.settings.includeMessageLinks) lines.push(`링크: ${this.buildMessageUrl(manifest, message.channel_id, message.id)}`);
		const runs = [`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${this.xmlEscape(`[${this.formatDate(message.timestamp)}] ${authorName}${this.settings.includeIds ? ` [${message.id}]` : ""}`)}</w:t></w:r>`];
		for (const line of lines) runs.push(`<w:r><w:br/><w:t xml:space="preserve">${this.xmlEscape(line)}</w:t></w:r>`);
		return `<w:p><w:pPr><w:spacing w:after="140"/></w:pPr>${runs.join("")}</w:p>`;
	}

	waitForStreamEvent (stream, eventName) {
		return new Promise((resolve, reject) => {
			const onEvent = (...args) => {cleanup(); resolve(args);};
			const onError = error => {cleanup(); reject(error);};
			const cleanup = () => {
				try {stream.removeListener(eventName, onEvent);} catch (_) {}
				try {stream.removeListener("error", onError);} catch (_) {}
			};
			stream.once(eventName, onEvent);
			stream.once("error", onError);
		});
	}

	async createStoredZip (rootDir, outputPath, onProgress = null) {
		const files = [];
		const walk = dir => {
			for (const name of this.fs.readdirSync(dir)) {
				const full = this.path.join(dir, name);
				const stat = this.fs.statSync(full);
				if (stat.isDirectory()) walk(full);
				else files.push({full, name: this.path.relative(rootDir, full).replace(/\\/g, "/"), size: Number(stat.size) || 0, mtime: stat.mtime});
			}
		};
		walk(rootDir);
		const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
		let processedBytes = 0;
		let lastProgressAt = 0;
		const report = (entryName, force = false) => {
			if (typeof onProgress !== "function") return;
			const now = Date.now();
			if (!force && now - lastProgressAt < 150) return;
			lastProgressAt = now;
			try {onProgress({processedBytes, totalBytes, ratio: totalBytes ? Math.min(1, processedBytes / totalBytes) : 1, name: entryName || ""});} catch (_) {}
		};
		const out = this.fs.createWriteStream(outputPath);
		let offset = 0;
		const central = [];
		const table = this.getCrcTable();
		const write = async buffer => {if (!out.write(buffer)) await this.waitForStreamEvent(out, "drain"); offset += buffer.length;};
		for (const entry of files) {
			const name = Buffer.from(entry.name, "utf8");
			const {time, date} = this.dosDateTime(entry.mtime);
			const localOffset = offset;
			const header = Buffer.alloc(30);
			header.writeUInt32LE(0x04034b50, 0);
			header.writeUInt16LE(20, 4);
			header.writeUInt16LE(0x0008, 6);
			header.writeUInt16LE(0, 8);
			header.writeUInt16LE(time, 10);
			header.writeUInt16LE(date, 12);
			header.writeUInt32LE(0, 14);
			header.writeUInt32LE(0, 18);
			header.writeUInt32LE(0, 22);
			header.writeUInt16LE(name.length, 26);
			header.writeUInt16LE(0, 28);
			await write(header);
			await write(name);
			let crc = 0xffffffff;
			let size = 0;
			await this.readFileInChunks(entry.full, async chunk => {
				for (const byte of chunk) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
				size += chunk.length;
				processedBytes += chunk.length;
				await write(chunk);
				report(entry.name, false);
			});
			crc = (crc ^ 0xffffffff) >>> 0;
			const descriptor = Buffer.alloc(16);
			descriptor.writeUInt32LE(0x08074b50, 0);
			descriptor.writeUInt32LE(crc, 4);
			descriptor.writeUInt32LE(size >>> 0, 8);
			descriptor.writeUInt32LE(size >>> 0, 12);
			await write(descriptor);
			central.push({name, crc, size, time, date, localOffset});
			report(entry.name, true);
		}
		const centralOffset = offset;
		for (const entry of central) {
			const header = Buffer.alloc(46);
			header.writeUInt32LE(0x02014b50, 0);
			header.writeUInt16LE(20, 4);
			header.writeUInt16LE(20, 6);
			header.writeUInt16LE(0x0008, 8);
			header.writeUInt16LE(0, 10);
			header.writeUInt16LE(entry.time, 12);
			header.writeUInt16LE(entry.date, 14);
			header.writeUInt32LE(entry.crc >>> 0, 16);
			header.writeUInt32LE(entry.size >>> 0, 20);
			header.writeUInt32LE(entry.size >>> 0, 24);
			header.writeUInt16LE(entry.name.length, 28);
			header.writeUInt16LE(0, 30);
			header.writeUInt16LE(0, 32);
			header.writeUInt16LE(0, 34);
			header.writeUInt16LE(0, 36);
			header.writeUInt32LE(0, 38);
			header.writeUInt32LE(entry.localOffset >>> 0, 42);
			await write(header);
			await write(entry.name);
		}
		const centralSize = offset - centralOffset;
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(0, 4);
		end.writeUInt16LE(0, 6);
		end.writeUInt16LE(central.length, 8);
		end.writeUInt16LE(central.length, 10);
		end.writeUInt32LE(centralSize >>> 0, 12);
		end.writeUInt32LE(centralOffset >>> 0, 16);
		end.writeUInt16LE(0, 20);
		await write(end);
		const finished = this.waitForStreamEvent(out, "finish");
		out.end();
		await finished;
		processedBytes = totalBytes;
		report("완료", true);
	}

	async normalizeBinaryData (value) {
		if (value == null) return Buffer.alloc(0);
		if (Buffer.isBuffer(value)) return value;
		if (typeof value === "string") return Buffer.from(value, "utf8");
		if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
		if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
			return Buffer.from(value.buffer, Number(value.byteOffset || 0), Number(value.byteLength || value.length || 0));
		}
		if (Array.isArray(value)) return Buffer.from(value);
		if (value && value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
		if (value && Array.isArray(value.data)) return Buffer.from(value.data);
		if (value && typeof value.arrayBuffer === "function") {
			const arrayBuffer = await value.arrayBuffer();
			return Buffer.from(new Uint8Array(arrayBuffer));
		}
		try {return Buffer.from(value);} catch (_) {}
		throw new TypeError(`Unsupported binary data returned by fs.readFileSync: ${Object.prototype.toString.call(value)}`);
	}

	async readFileInChunks (file, onChunk, chunkSize = 1024 * 1024) {
		const fs = this.fs;
		const size = Math.max(64 * 1024, Number(chunkSize) || 1024 * 1024);
		if (fs && typeof fs.openSync === "function" && typeof fs.readSync === "function" && typeof fs.closeSync === "function") {
			let descriptor = null;
			try {
				descriptor = fs.openSync(file, "r");
				const buffer = Buffer.allocUnsafe(size);
				while (true) {
					const readResult = fs.readSync(descriptor, buffer, 0, buffer.length, null);
					const bytesRead = typeof readResult === "number" ? readResult : Number(readResult && readResult.bytesRead || 0);
					if (!bytesRead) break;
					const source = readResult && readResult.buffer ? await this.normalizeBinaryData(readResult.buffer) : buffer;
					await onChunk(Buffer.from(source.slice(0, bytesRead)));
				}
				return;
			}
			catch (error) {
				console.warn("[ChatLogExporter] Direct chunk reading failed; falling back to readFileSync.", error);
			}
			finally {
				if (descriptor !== null) {try {fs.closeSync(descriptor);} catch (_) {}}
			}
		}

		// Restricted BetterDiscord wrappers may return ArrayBuffer, Uint8Array,
		// strings, or serialized Buffer objects instead of a Node Buffer.
		const data = await this.normalizeBinaryData(fs.readFileSync(file));
		for (let offset = 0; offset < data.length; offset += size) {
			await onChunk(Buffer.from(data.slice(offset, Math.min(data.length, offset + size))));
		}
	}

	async crc32File (file) {
		let crc = 0xffffffff;
		const table = this.getCrcTable();
		await this.readFileInChunks(file, async chunk => {
			for (const byte of chunk) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
		});
		return (crc ^ 0xffffffff) >>> 0;
	}

	getCrcTable () {
		if (this._crcTable) return this._crcTable;
		this._crcTable = Array.from({length: 256}, (_, index) => {
			let value = index;
			for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			return value >>> 0;
		});
		return this._crcTable;
	}

	dosDateTime (value) {
		const dateValue = new Date(value);
		const year = Math.max(1980, dateValue.getFullYear());
		const date = ((year - 1980) << 9) | ((dateValue.getMonth() + 1) << 5) | dateValue.getDate();
		const time = (dateValue.getHours() << 11) | (dateValue.getMinutes() << 5) | Math.floor(dateValue.getSeconds() / 2);
		return {date, time};
	}

	channelDisplayName (channel, manifest) {
		const parent = this.parentChannelName(channel, manifest);
		return parent ? `${parent} › ${channel.name || channel.rawName || channel.id}` : channel.name || channel.rawName || channel.id;
	}
	parentChannelName (channel, manifest) {const parent = channel.parentId && manifest.channels && manifest.channels[String(channel.parentId)]; return parent ? parent.name || parent.rawName || parent.id : channel.parentName || "";}

	updateExportProgress (index, total, channelName, details = null) {
		const info = details || {};
		this.progressState.channelsDone = Math.max(0, Math.min(total, Number(index) || 0));
		this.progressState.channelsTotal = total;
		this.progressState.currentChannel = channelName;
		this.progressState.progress = Number.isFinite(Number(info.overall)) ? Number(info.overall) : total ? index / total * 100 : 0;
		this.progressState.phase = info.phase || "write";
		if (Number.isFinite(Number(info.processed))) this.progressState.processedItems = Number(info.processed);
		if (Number.isFinite(Number(info.grandTotal))) this.progressState.totalItems = Number(info.grandTotal);
		const channelNumber = info.completed ? Math.min(total, Math.max(1, Number(index) || 1)) : Math.min(total, Math.max(1, (Number(index) || 0) + 1));
		const phaseText = info.phase === "read" ? "캐시 읽는 중" : "파일 작성 중";
		const itemText = Number(info.total) > 0 ? ` · ${Number(info.done || 0).toLocaleString()}/${Number(info.total).toLocaleString()}개` : "";
		this.progressState.status = `${phaseText}...\n${channelNumber}/${total} ${channelName}${itemText}`;
		this.refreshUi();
	}

	csvEscape (value) {const text = String(value == null ? "" : value); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;}
	xmlEscape (value) {return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");}
	sanitizeFileName (value) {return String(value || "Discord").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/g, "").slice(0, 120) || "Discord";}
	formatFileTimestamp (date) {const pad = value => String(value).padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;}
	formatDate (value) {const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("ko-KR", {year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false}) : String(value || "");}
	formatBytes (bytes) {let value = Number(bytes) || 0; const units = ["B", "KB", "MB", "GB", "TB"]; let index = 0; while (value >= 1024 && index < units.length - 1) {value /= 1024; index++;} return `${value.toFixed(index ? 2 : 0)} ${units[index]}`;}
	sleep (ms) {return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));}

	writeStream (stream, text) {
		return new Promise((resolve, reject) => {
			const onError = error => {cleanup(); reject(error);};
			const onDrain = () => {cleanup(); resolve();};
			const cleanup = () => {stream.removeListener("error", onError); stream.removeListener("drain", onDrain);};
			stream.once("error", onError);
			if (stream.write(String(text), "utf8")) {cleanup(); resolve();}
			else stream.once("drain", onDrain);
		});
	}

	bindShortcut () {
		this.shortcutHandler = event => {
			if (!this.settings.shortcutEnabled) return;
			if (event.ctrlKey && event.shiftKey && (event.key || "").toLowerCase() === "e") {
				event.preventDefault(); event.stopPropagation(); this.togglePanel();
			}
		};
		document.addEventListener("keydown", this.shortcutHandler, true);
	}

	injectCss () {
		BdApi.DOM.removeStyle("ChatLogExporterCSS");
		BdApi.DOM.addStyle("ChatLogExporterCSS", `
			@keyframes cle-panel-in {from {transform:translateX(14px); opacity:0;} to {transform:none; opacity:1;}}
			@keyframes cle-fade-in {from {opacity:0;} to {opacity:1;}}
			@keyframes cle-spin {to {transform:rotate(360deg);}}
			#chatlogexporter-panel {position:fixed; z-index:2147482999; top:40px; right:0; bottom:0; width:408px; box-sizing:border-box; background:#121214; color:var(--text-normal,#dbdee1); border-left:1px solid var(--background-modifier-accent,rgba(255,255,255,.08)); box-shadow:var(--elevation-high,0 8px 24px rgba(0,0,0,.35)); display:flex; flex-direction:column; font-family:var(--font-primary,sans-serif); animation:cle-panel-in .14s ease-out;}
			.cle-head {height:48px; flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; padding:0 14px; border-bottom:1px solid var(--background-modifier-accent,rgba(255,255,255,.08)); font-weight:800;}
			.cle-close {display:flex; align-items:center; justify-content:center; width:28px; height:28px; border:0; border-radius:50%; background:transparent; color:var(--text-muted,#949ba4); font-size:22px; line-height:1; cursor:pointer; transition:background .12s ease, color .12s ease;}
			.cle-close:hover {background:var(--background-modifier-hover,rgba(255,255,255,.08)); color:var(--interactive-hover,#dbdee1);}
			.cle-close:active {background:var(--background-modifier-active,rgba(255,255,255,.12));}
			.cle-body {padding:14px; overflow:auto; flex:1 1 auto; scrollbar-width:thin; scrollbar-color:var(--scrollbar-thin-thumb,#1a1b1e) transparent;}
			.cle-body::-webkit-scrollbar {width:8px;}
			.cle-body::-webkit-scrollbar-thumb {border-radius:4px; background:var(--scrollbar-thin-thumb,rgba(255,255,255,.14));}
			.cle-body::-webkit-scrollbar-track {background:transparent;}
			.cle-card {background:#1a1a1e; border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08)); border-radius:8px; padding:12px; margin-bottom:10px;}
			.cle-title {font-size:15px; font-weight:800; margin-bottom:6px; color:var(--header-primary,#f2f3f5);}
			.cle-note {font-size:12px; color:var(--text-muted,#949ba4); line-height:1.45; white-space:pre-wrap;}
			.cle-row {display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-top:10px;}
			.cle-button {border:0; border-radius:5px; padding:8px 10px; font-size:13px; font-weight:700; line-height:1.2; cursor:pointer; color:#fff; background:var(--brand-experiment,#5865f2); transition:background-color .12s ease, opacity .12s ease;}
			.cle-button.secondary {background:var(--background-modifier-selected,#35373c); color:var(--text-normal,#dbdee1);}
			.cle-button.danger {background:var(--status-danger,#da373c);}
			.cle-button:not(:disabled):hover {background:var(--brand-experiment-560,#4752c4);}
			.cle-button.secondary:not(:disabled):hover {background:var(--background-modifier-hover,#3f4147);}
			.cle-button.danger:not(:disabled):hover {background:var(--status-danger-background,#a12d2f);}
			.cle-button:not(:disabled):active {transform:translateY(1px);}
			.cle-button:focus-visible {outline:2px solid var(--focus-primary,#00a8fc); outline-offset:2px;}
			.cle-button:disabled {opacity:.45; cursor:not-allowed;}
			.cle-select,.cle-input {box-sizing:border-box; min-height:36px; border:1px solid var(--background-modifier-accent,rgba(255,255,255,.1)); border-radius:5px; padding:7px 8px; background:var(--input-background,#1e1f22); color:var(--text-normal,#dbdee1); transition:border-color .12s ease;}
			.cle-select:not(:disabled):hover,.cle-input:not(:disabled):hover {border-color:var(--background-modifier-accent,rgba(255,255,255,.22));}
			.cle-select:focus,.cle-input:focus {outline:none; border-color:var(--brand-experiment,#5865f2);}
			.cle-select:disabled,.cle-input:disabled {opacity:.5; cursor:not-allowed;}
			.cle-select {min-width:110px; cursor:pointer;}
			.cle-progress-wrap {margin-top:10px;}
			.cle-progress {height:7px; border-radius:999px; overflow:hidden; background:var(--background-modifier-selected,#35373c);}
			.cle-progress > div {height:100%; width:0; background:var(--brand-experiment,#5865f2); transition:width .15s linear;}
			.cle-stats {font-size:11px; color:var(--text-muted,#949ba4); margin-top:6px; line-height:1.45; white-space:pre-wrap;}
			.cle-current {font-size:11px; color:var(--text-muted,#949ba4); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
			#chatlogexporter-floating-progress {position:fixed; right:18px; bottom:18px; z-index:2147483645; width:290px; box-sizing:border-box; border:1px solid var(--background-modifier-accent,rgba(255,255,255,.12)); border-radius:9px; padding:10px 11px; background:#121214; color:var(--text-normal,#dbdee1); box-shadow:var(--elevation-high,0 8px 24px rgba(0,0,0,.4)); cursor:pointer; text-align:left; font-family:var(--font-primary,sans-serif);}
			#chatlogexporter-floating-progress:hover {background:#17171a;}
			.cle-float-top {display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px;}
			.cle-float-top strong {font-size:12px; color:var(--header-primary,#f2f3f5);}
			.cle-float-bar {height:5px; margin-top:7px; border-radius:999px; overflow:hidden; background:var(--background-modifier-selected,#35373c);}
			.cle-float-bar > div {height:100%; width:0; background:var(--brand-experiment,#5865f2); transition:width .15s linear;}
			.cle-float-current {margin-top:6px; font-size:11px; color:var(--text-normal,#dbdee1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
			.cle-float-stats {margin-top:3px; font-size:10px; color:var(--text-muted,#949ba4);}
			#chatlogexporter-range-overlay {position:fixed; inset:0; z-index:2147483647; display:flex; align-items:center; justify-content:center; padding:24px; box-sizing:border-box; background:rgba(0,0,0,.62); font-family:var(--font-primary,sans-serif);}
			.cle-range-modal {width:min(680px,calc(100vw - 48px)); max-height:calc(100vh - 48px); overflow:auto; box-sizing:border-box; border:1px solid var(--background-modifier-accent,rgba(255,255,255,.12)); border-radius:10px; padding:16px; background:#18181c; color:var(--text-normal,#dbdee1); box-shadow:var(--elevation-high,0 12px 36px rgba(0,0,0,.55));}
			.cle-range-head {display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--header-primary,#f2f3f5); font-size:17px;}
			.cle-range-close {display:flex; align-items:center; justify-content:center; width:30px; height:30px; border:0; border-radius:50%; background:transparent; color:var(--text-muted,#949ba4); font-size:24px; line-height:1; cursor:pointer; transition:background .12s ease, color .12s ease;}
			.cle-range-close:hover {background:var(--background-modifier-hover,rgba(255,255,255,.08)); color:var(--interactive-hover,#dbdee1);}
			.cle-range-summary,.cle-range-status {margin-top:10px; white-space:pre-wrap; color:var(--text-muted,#949ba4); font-size:12px; line-height:1.5;}
			.cle-range-status {color:var(--text-normal,#dbdee1); font-weight:700;}
			.cle-range-preview {max-height:360px; overflow:auto; margin:12px 0 0; padding:12px; border-radius:7px; background:#111114; border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08)); color:var(--text-normal,#dbdee1); white-space:pre-wrap; word-break:break-word; font:12px/1.5 var(--font-primary,sans-serif); scrollbar-width:thin; scrollbar-color:var(--scrollbar-thin-thumb,rgba(255,255,255,.14)) transparent;}
			.cle-range-preview:empty {display:none;}
			.cle-range-preview::-webkit-scrollbar {width:8px;}
			.cle-range-preview::-webkit-scrollbar-thumb {border-radius:4px; background:var(--scrollbar-thin-thumb,rgba(255,255,255,.14));}
			.cle-range-preview::-webkit-scrollbar-track {background:transparent;}
			.cle-range-actions {display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:12px;}
			.cle-context-parent-item {display:flex!important; align-items:center!important; justify-content:space-between!important; gap:12px!important; width:auto!important; min-width:0!important; min-height:32px!important; box-sizing:border-box!important; padding:6px 8px!important; margin:2px 6px!important; border-radius:4px!important; cursor:pointer!important; color:var(--interactive-normal,#b5bac1)!important; background:transparent!important; font-size:14px!important; font-weight:500!important; overflow:visible!important; isolation:isolate;}
			.cle-context-parent-item:hover,.cle-context-parent-item.is-active {background:var(--brand-experiment,#5865f2)!important; color:#fff!important;}
			.cle-context-parent-label {min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
			.cle-context-parent-arrow {flex:0 0 auto; margin-left:auto; font-size:20px; line-height:14px; transform:translateY(-1px);}
			.cle-context-submenu {position:fixed; z-index:2147483647; min-width:230px; max-width:320px; box-sizing:border-box; padding:6px; border-radius:8px; background:var(--background-floating,#111214); color:var(--interactive-normal,#b5bac1); border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08)); box-shadow:var(--elevation-high,0 8px 24px rgba(0,0,0,.45)); font-family:var(--font-primary,sans-serif); animation:cle-fade-in .08s ease-out;}
			.cle-context-subitem {min-height:32px; display:flex; align-items:center; box-sizing:border-box; padding:6px 8px; border-radius:4px; cursor:pointer; font-size:14px; font-weight:500; white-space:nowrap; background:transparent; color:inherit;}
			.cle-context-subitem:hover {background:var(--brand-experiment,#5865f2); color:#fff; outline:none;}
			.cle-context-subitem.danger {color:var(--text-danger,#f23f42);}
			.cle-context-subitem.danger:hover {background:var(--background-danger,#da373c); color:#fff;}
			.cle-context-separator {height:1px; margin:4px; background:var(--background-modifier-accent,rgba(255,255,255,.08));}
			.cle-notice {position:fixed; top:44px; right:18px; z-index:2147483646; max-width:360px; padding:11px 36px 11px 12px; border-radius:8px; background:#121214; color:var(--text-normal,#dbdee1); border:1px solid var(--background-modifier-accent,rgba(255,255,255,.1)); box-shadow:var(--elevation-high,0 8px 24px rgba(0,0,0,.35)); font-size:12px; line-height:1.4; animation:cle-fade-in .14s ease-out;}
			.cle-notice strong {display:block; color:var(--header-primary,#f2f3f5); margin-bottom:3px;}
			.cle-notice-close {position:absolute; top:5px; right:7px; display:flex; align-items:center; justify-content:center; width:22px; height:22px; border:0; border-radius:50%; background:transparent; color:var(--text-muted,#949ba4); cursor:pointer; font-size:17px; line-height:1; transition:background .12s ease, color .12s ease;}
			.cle-notice-close:hover {background:var(--background-modifier-hover,rgba(255,255,255,.08)); color:var(--interactive-hover,#dbdee1);}
			.cle-notice-open {margin-top:7px; border:0; border-radius:4px; padding:5px 8px; background:var(--background-modifier-selected,#35373c); color:var(--text-normal,#dbdee1); cursor:pointer; font-weight:600; transition:background .12s ease;}
			.cle-notice-open:hover {background:var(--background-modifier-hover,#3f4147);}
			.cle-settings-section {margin:18px 0 6px; font-size:12px; font-weight:800; letter-spacing:.02em; text-transform:uppercase; color:var(--header-secondary,#949ba4);}
			.cle-settings-section:first-of-type {margin-top:4px;}
			.cle-settings-divider {height:1px; margin:14px 0 0; background:var(--background-modifier-accent,rgba(255,255,255,.08));}
			.cle-setting-row {display:flex; align-items:center; justify-content:space-between; gap:12px; margin:2px 0; padding:6px 8px; border-radius:5px; cursor:pointer; transition:background .12s ease;}
			.cle-setting-row:hover {background:var(--background-modifier-hover,rgba(255,255,255,.04));}
			.cle-setting-row input[type="checkbox"] {flex:0 0 auto; width:16px; height:16px; accent-color:var(--brand-experiment,#5865f2); cursor:pointer;}
			@media (prefers-reduced-motion:reduce) {
				#chatlogexporter-panel,.cle-context-submenu,.cle-notice {animation:none;}
				.cle-button,.cle-close,.cle-range-close,.cle-notice-close,.cle-notice-open,.cle-setting-row,.cle-select,.cle-input {transition:none;}
			}
		`);
	}

	togglePanel (scope = null) {
		if (this.panel) this.removePanel();
		else {this.targetScope = scope || this.getCurrentScopeInfo(); this.showPanel(this.targetScope);}
	}
	removePanel (clearTarget = true) {
		if (this.panel) this.panel.remove();
		this.panel = null;
		this.currentUi = null;
		this.manifestCache = null;
		if (this.panelEscHandler) document.removeEventListener("keydown", this.panelEscHandler, true);
		this.panelEscHandler = null;
		clearInterval(this.panelMonitor);
		this.panelMonitor = null;
		if (clearTarget && !this.collecting && !this.exporting) this.targetScope = null;
		this.updateFloatingProgress();
	}

	showPanel (scope = null) {
		this.targetScope = scope || this.targetScope || this.getCurrentScopeInfo();
		this.removeFloatingProgress();
		this.removePanel(false);
		const panel = document.createElement("div");
		panel.id = "chatlogexporter-panel";
		panel.tabIndex = -1;
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "ChatLogExporter");
		const head = document.createElement("div");
		head.className = "cle-head";
		const title = document.createElement("span"); title.textContent = "ChatLogExporter";
		const close = document.createElement("button"); close.type = "button"; close.className = "cle-close"; close.textContent = "×"; close.title = "닫기 (Esc)"; close.setAttribute("aria-label", "ChatLogExporter 패널 닫기"); close.addEventListener("click", () => this.removePanel(false));
		head.append(title, close);
		const body = document.createElement("div"); body.className = "cle-body";

		const serverCard = document.createElement("div"); serverCard.className = "cle-card";
		const serverTitle = document.createElement("div"); serverTitle.className = "cle-title";
		const serverInfo = document.createElement("div"); serverInfo.className = "cle-note";
		serverCard.append(serverTitle, serverInfo);

		const collectCard = document.createElement("div"); collectCard.className = "cle-card";
		const collectTitle = document.createElement("div"); collectTitle.className = "cle-title"; collectTitle.textContent = "로그 수집";
		const collectDesc = document.createElement("div"); collectDesc.className = "cle-note"; collectDesc.textContent = "선택한 서버의 모든 채널·스레드·활성/보관 포럼 포스트 또는 선택한 DM 대화방을 로컬 파일 캐시에 저장해. 패널을 닫아도 작업은 계속돼.";
		const collectRow = document.createElement("div"); collectRow.className = "cle-row";
		const fullBtn = this.makeButton("전체 수집", "");
		const recentBtn = this.makeButton("최근 업데이트", "secondary");
		const resetBtn = this.makeButton("초기화 후 전체", "secondary");
		const stopBtn = this.makeButton("중지", "danger");
		fullBtn.addEventListener("click", () => this.collectServer("full", this.targetScope));
		recentBtn.addEventListener("click", () => this.collectServer("recent", this.targetScope));
		resetBtn.addEventListener("click", () => this.collectServer("reset", this.targetScope));
		stopBtn.addEventListener("click", () => this.stopCollecting());
		collectRow.append(fullBtn, recentBtn, resetBtn, stopBtn);
		collectCard.append(collectTitle, collectDesc, collectRow);

		const exportCard = document.createElement("div"); exportCard.className = "cle-card";
		const exportTitle = document.createElement("div"); exportTitle.className = "cle-title"; exportTitle.textContent = "파일 내보내기";
		const exportDesc = document.createElement("div"); exportDesc.className = "cle-note"; exportDesc.textContent = "AI Archive ZIP은 JSONL 원본, Markdown 대화문, 사용자·채널 관계도, manifest를 함께 담아 LLM 분석에 최적화해. 기존 TXT/CSV/DOCX도 호환용으로 남겨뒀어.";
		const exportRow = document.createElement("div"); exportRow.className = "cle-row";
		const formatSelect = document.createElement("select"); formatSelect.className = "cle-select";
		for (const [value, label] of [["ai_archive", "AI Archive ZIP (추천)"], ["compact_jsonl", "Compact JSONL ZIP"], ["markdown_zip", "Readable Markdown ZIP"], ["txt", "TXT (호환용)"], ["csv", "CSV (호환용)"], ["docx", "DOCX (호환용)"]]) {const option = document.createElement("option"); option.value = value; option.textContent = label; formatSelect.appendChild(option);}
		formatSelect.value = this.settings.exportFormat;
		formatSelect.addEventListener("change", () => {this.settings.exportFormat = formatSelect.value; this.saveSettings();});
		const exportBtn = this.makeButton("내보내기", ""); exportBtn.addEventListener("click", () => this.exportCurrentServer(this.targetScope));
		const openFolderBtn = this.makeButton("폴더 열기", "secondary"); openFolderBtn.addEventListener("click", () => this.openPath(this.getOutputFolder()));
		exportRow.append(formatSelect, exportBtn, openFolderBtn);
		exportCard.append(exportTitle, exportDesc, exportRow);

		const progressCard = document.createElement("div"); progressCard.className = "cle-card";
		const progressTitle = document.createElement("div"); progressTitle.className = "cle-title"; progressTitle.textContent = "진행 상태";
		const progressStatus = document.createElement("div"); progressStatus.className = "cle-note";
		const progressWrap = document.createElement("div"); progressWrap.className = "cle-progress-wrap";
		const progress = document.createElement("div"); progress.className = "cle-progress";
		const progressFill = document.createElement("div"); progress.appendChild(progressFill);
		const stats = document.createElement("div"); stats.className = "cle-stats";
		const progressCurrent = document.createElement("div"); progressCurrent.className = "cle-current";
		progressWrap.append(progress, stats, progressCurrent);
		progressCard.append(progressTitle, progressStatus, progressWrap);

		body.append(serverCard, collectCard, exportCard, progressCard);
		panel.append(head, body);
		document.body.appendChild(panel);
		this.panel = panel;
		this.currentUi = {serverTitle, serverInfo, fullBtn, recentBtn, resetBtn, stopBtn, formatSelect, exportBtn, openFolderBtn, progressStatus, progressWrap, progressFill, stats, progressCurrent};
		// Esc closes the panel only while it actually holds focus, so it never steals
		// the key from Discord's own dialogs or the message box.
		this.panelEscHandler = event => {
			if (event.key !== "Escape" || !this.panel || this.rangeModal) return;
			const active = document.activeElement;
			if (!active || !this.panel.contains(active)) return;
			event.preventDefault(); event.stopPropagation();
			this.removePanel(false);
		};
		document.addEventListener("keydown", this.panelEscHandler, true);
		try {panel.focus({preventScroll: true});} catch (_) {}
		this.refreshUi();
		this.panelMonitor = setInterval(() => this.refreshUi(), 700);
	}

	makeButton (label, kind) {const button = document.createElement("button"); button.type = "button"; button.className = `cle-button${kind ? ` ${kind}` : ""}`; button.textContent = label; return button;}

	setText (node, value) {if (node && node.textContent !== value) node.textContent = value;}

	// The panel refreshes twice a second, so the manifest is read from disk at most
	// once every 1.5s instead of on every tick.
	readManifestCached (scope) {
		const now = Date.now();
		const cache = this.manifestCache;
		if (cache && cache.cacheId === scope.cacheId && now - cache.time < 1500 && !this.collecting && !this.exporting) return cache.manifest;
		const manifest = this.readManifest(scope.cacheId, scope.name, scope);
		this.manifestCache = {cacheId: scope.cacheId, manifest, time: now};
		return manifest;
	}

	refreshUi () {
		this.updateFloatingProgress();
		if (!this.currentUi) return;
		const ui = this.currentUi;
		const scope = this.getActiveScopeInfo();
		if (!scope || !scope.cacheId) {
			this.setText(ui.serverTitle, "대상을 선택해줘");
			this.setText(ui.serverInfo, "서버 아이콘이나 DM 대화방을 우클릭한 뒤 ChatLogExporter를 열어줘.");
		}
		else {
			const manifest = this.readManifestCached(scope);
			this.setText(ui.serverTitle, `${scope.type === "dm" ? "DM · " : ""}${scope.name}`);
			this.setText(ui.serverInfo, `저장 메시지: ${Number(manifest.totalMessages || 0).toLocaleString()}개\n마지막 전체 수집: ${manifest.lastFullScanAt ? this.formatDate(manifest.lastFullScanAt) : "없음"}\n마지막 최근 업데이트: ${manifest.lastRecentScanAt ? this.formatDate(manifest.lastRecentScanAt) : "없음"}\n캐시 위치: ${this.getGuildDir(scope.cacheId)}`);
		}
		const busy = this.collecting || this.exporting;
		const disabled = busy || !scope || !scope.cacheId;
		ui.fullBtn.disabled = disabled;
		ui.recentBtn.disabled = disabled;
		ui.resetBtn.disabled = disabled;
		ui.stopBtn.disabled = !this.collecting;
		ui.stopBtn.style.display = this.collecting ? "" : "none";
		ui.exportBtn.disabled = disabled;
		ui.formatSelect.disabled = busy;
		this.setText(ui.progressStatus, this.progressState.status || "대기 중");
		ui.progressFill.style.width = `${Math.max(0, Math.min(100, Number(this.progressState.progress) || 0))}%`;
		this.setText(ui.stats, this.exporting || this.progressState.mode === "export"
			? `채널: ${this.progressState.channelsDone}/${this.progressState.channelsTotal}${this.progressState.totalItems ? ` · 메시지: ${Number(this.progressState.processedItems || 0).toLocaleString()}/${Number(this.progressState.totalItems).toLocaleString()}` : ""}`
			: `채널: ${this.progressState.channelsDone}/${this.progressState.channelsTotal} · 요청: ${this.progressState.requests.toLocaleString()} · 받은 메시지: ${this.progressState.received.toLocaleString()} · 새로 저장: ${this.progressState.saved.toLocaleString()} · 실패: ${this.progressState.failed}`);
		this.setText(ui.progressCurrent, this.progressState.currentChannel ? `현재 작업: ${this.progressState.currentChannel}` : "");
		ui.progressCurrent.style.display = this.progressState.currentChannel ? "" : "none";
		ui.progressWrap.style.display = this.progressState.active || this.collecting || this.exporting ? "" : "none";
	}

	removeFloatingProgress () {
		if (this.floatingProgress) this.floatingProgress.remove();
		this.floatingProgress = null;
	}

	ensureFloatingProgress () {
		if (this.floatingProgress && this.floatingProgress.isConnected) return this.floatingProgress;
		const root = document.createElement("button");
		root.id = "chatlogexporter-floating-progress";
		root.type = "button";
		root.title = "ChatLogExporter 진행 창 열기";
		const top = document.createElement("div"); top.className = "cle-float-top";
		const title = document.createElement("strong");
		const percent = document.createElement("span");
		top.append(title, percent);
		const bar = document.createElement("div"); bar.className = "cle-float-bar";
		const fill = document.createElement("div"); bar.appendChild(fill);
		const current = document.createElement("div"); current.className = "cle-float-current";
		const stats = document.createElement("div"); stats.className = "cle-float-stats";
		root.append(top, bar, current, stats);
		root.addEventListener("click", () => this.showPanel(this.targetScope || this.getCurrentScopeInfo()));
		document.body.appendChild(root);
		root._cle = {title, percent, fill, current, stats};
		this.floatingProgress = root;
		return root;
	}

	updateFloatingProgress () {
		const busy = !!(this.progressState.active || this.collecting || this.exporting);
		if (!busy || this.panel) {this.removeFloatingProgress(); return;}
		const root = this.ensureFloatingProgress();
		const ui = root._cle;
		const value = Math.max(0, Math.min(100, Number(this.progressState.progress) || 0));
		ui.title.textContent = this.exporting || this.progressState.mode === "export" ? "로그 내보내기" : "로그 수집";
		ui.percent.textContent = `${Math.round(value)}%`;
		ui.fill.style.width = `${value}%`;
		ui.current.textContent = this.progressState.currentChannel || String(this.progressState.status || "작업 준비 중...").split("\n").pop();
		ui.stats.textContent = this.exporting || this.progressState.mode === "export"
			? `채널 ${this.progressState.channelsDone}/${this.progressState.channelsTotal}${this.progressState.totalItems ? ` · 메시지 ${Number(this.progressState.processedItems || 0).toLocaleString()}/${Number(this.progressState.totalItems).toLocaleString()}` : ""}`
			: `받음 ${this.progressState.received.toLocaleString()} · 저장 ${this.progressState.saved.toLocaleString()} · 실패 ${this.progressState.failed}`;
	}

	showPersistentNotice (title, message, folderPath) {
		const notice = document.createElement("div"); notice.className = "cle-notice";
		const strong = document.createElement("strong"); strong.textContent = title;
		const text = document.createElement("div"); text.textContent = message;
		const close = document.createElement("button"); close.type = "button"; close.className = "cle-notice-close"; close.textContent = "×"; close.setAttribute("aria-label", "알림 닫기"); close.addEventListener("click", () => notice.remove());
		notice.append(strong, text, close);
		if (folderPath) {const open = document.createElement("button"); open.type = "button"; open.className = "cle-notice-open"; open.textContent = "폴더 열기"; open.addEventListener("click", () => this.openPath(folderPath)); notice.appendChild(open);}
		document.body.appendChild(notice);
	}

	openPath (target) {
		try {const {shell} = require("electron"); if (shell && shell.openPath) shell.openPath(target); else throw new Error("Electron shell unavailable");}
		catch (error) {this.reportError("폴더 열기", error);}
	}

	getDirectorySize (directory) {
		let total = 0;
		if (!this.fs.existsSync(directory)) return 0;
		for (const name of this.fs.readdirSync(directory)) {
			const full = this.path.join(directory, name);
			try {const stat = this.fs.statSync(full); total += stat.isDirectory() ? this.getDirectorySize(full) : stat.size;} catch (_) {}
		}
		return total;
	}

	getSettingsPanel () {
		const panel = document.createElement("div");
		panel.style.padding = "12px";
		panel.style.color = "var(--text-normal)";
		const title = document.createElement("h3"); title.textContent = "ChatLogExporter 설정"; title.style.margin = "0 0 12px"; panel.appendChild(title);
		const section = text => {const node = document.createElement("div"); node.className = "cle-settings-section"; node.textContent = text; panel.appendChild(node);};
		const divider = () => {const node = document.createElement("div"); node.className = "cle-settings-divider"; panel.appendChild(node);};

		section("일반");
		panel.appendChild(this.makeSettingCheckbox("Ctrl+Shift+E 단축키 사용", "shortcutEnabled"));
		divider();

		section("자동 업데이트");
		panel.appendChild(this.makeSettingCheckbox("새 버전이 나오면 자동으로 받기", "autoUpdate"));
		const updateInfo = document.createElement("div"); updateInfo.className = "cle-note";
		updateInfo.textContent = `현재 버전 v${this.version}` + (UPDATE_PUBLIC_KEY ? " · 서명 확인됨" : " · (서명 열쇠 없음 — 이 빌드는 자동 설치 안 함)");
		panel.appendChild(updateInfo);
		const updateRow = document.createElement("div"); updateRow.className = "cle-row";
		const checkBtn = this.makeButton("지금 업데이트 확인", "secondary");
		checkBtn.addEventListener("click", () => {BdApi.UI.showToast("업데이트 확인 중...", {type: "info"}); this.checkUpdate(true);});
		const repoBtn = this.makeButton("저장소 열기", "secondary");
		repoBtn.addEventListener("click", () => {try {require("electron").shell.openExternal(`https://github.com/${UPDATE_REPO}`);} catch (_) {}});
		updateRow.append(checkBtn, repoBtn); panel.appendChild(updateRow);
		divider();

		section("스크린샷");
		const shotNote = document.createElement("div"); shotNote.className = "cle-note"; shotNote.textContent = "긴 대화는 이 길이를 넘으면 여러 장으로 잘라서 저장돼."; panel.appendChild(shotNote);
		const shotRowS = document.createElement("div"); shotRowS.className = "cle-row";
		const shotLabel = document.createElement("span"); shotLabel.className = "cle-note"; shotLabel.textContent = "한 장 최대 세로 길이";
		const shotSel = document.createElement("select"); shotSel.className = "cle-select";
		for (const [value, label] of [["4000", "짧게 (4000px)"], ["8000", "보통 (8000px)"], ["15000", "길게 (15000px)"], ["22000", "아주 길게 (22000px)"], ["30000", "최대 (30000px)"]]) {
			const opt = document.createElement("option"); opt.value = value; opt.textContent = label; shotSel.appendChild(opt);
		}
		shotSel.value = String(Math.max(1500, Math.min(30000, Number(this.settings.shotMaxHeight) || 15000)));
		if (!Array.from(shotSel.options).some(o => o.value === shotSel.value)) shotSel.value = "15000";
		shotSel.addEventListener("change", () => {this.settings.shotMaxHeight = Number(shotSel.value) || 15000; this.saveSettings();});
		shotRowS.append(shotLabel, shotSel); panel.appendChild(shotRowS);
		divider();

		section("내보낼 항목");
		panel.appendChild(this.makeSettingCheckbox("첨부파일 URL 포함", "includeAttachments"));
		panel.appendChild(this.makeSettingCheckbox("임베드 정보 포함", "includeEmbeds"));
		panel.appendChild(this.makeSettingCheckbox("반응 수 포함", "includeReactions"));
		panel.appendChild(this.makeSettingCheckbox("답장 대상 포함", "includeReplyInfo"));
		panel.appendChild(this.makeSettingCheckbox("Discord 메시지 링크 포함", "includeMessageLinks"));
		panel.appendChild(this.makeSettingCheckbox("사용자·메시지·채널 ID 포함", "includeIds"));
		panel.appendChild(this.makeSettingCheckbox("수정 시각 포함", "includeEditedAt"));
		divider();

		section("수집 속도");
		panel.appendChild(this.makeNumberSetting("한 번에 가져올 메시지 수", "pageSize", 25, 100));
		panel.appendChild(this.makeNumberSetting("Discord 요청 간격(ms)", "fetchDelayMs", 0, 5000));
		divider();

		section("파일 분할·정렬");
		panel.appendChild(this.makeNumberSetting("AI 파일당 최대 메시지 수", "aiSplitMessages", 1000, 200000));
		panel.appendChild(this.makeNumberSetting("AI 파일당 목표 최대 용량(MB)", "aiSplitSizeMB", 1, 100));

		const orderWrap = document.createElement("label"); orderWrap.className = "cle-setting-row";
		const orderLabel = document.createElement("span"); orderLabel.textContent = "파일 내 메시지 순서";
		const order = document.createElement("select"); order.className = "cle-select";
		for (const [value, label] of [["oldest", "오래된순"], ["newest", "최신순"]]) {const option = document.createElement("option"); option.value = value; option.textContent = label; order.appendChild(option);}
		order.value = this.settings.exportOrder; order.addEventListener("change", () => {this.settings.exportOrder = order.value; this.saveSettings();});
		orderWrap.append(orderLabel, order); panel.appendChild(orderWrap);
		divider();

		section("저장 위치");
		const folderInput = document.createElement("input"); folderInput.className = "cle-input"; folderInput.style.width = "100%"; folderInput.value = this.settings.outputFolder || ""; folderInput.placeholder = this.getDefaultOutputFolder();
		folderInput.addEventListener("change", () => {this.settings.outputFolder = folderInput.value.trim(); this.saveSettings(); this.ensureBaseFolders();}); panel.appendChild(folderInput);
		const row = document.createElement("div"); row.className = "cle-row";
		const openExport = this.makeButton("내보내기 폴더 열기", "secondary"); openExport.addEventListener("click", () => this.openPath(this.getOutputFolder()));
		const openCache = this.makeButton("캐시 폴더 열기", "secondary"); openCache.addEventListener("click", () => this.openPath(this.getCacheRoot()));
		const info = this.makeButton("저장 정보 보기", "secondary"); info.addEventListener("click", () => this.safeAction("저장 정보 보기", () => this.showCacheInfo()));
		const debug = this.makeButton("최근 수집 진단 복사", "secondary"); debug.addEventListener("click", () => this.safeAction("최근 수집 진단 복사", () => this.copyLastCollectionDiagnostics(true)));
		row.append(openExport, openCache, info, debug); panel.appendChild(row);
		const note = document.createElement("div"); note.style.fontSize = "12px"; note.style.color = "var(--text-muted)"; note.style.marginTop = "12px"; note.textContent = "AI Archive ZIP은 manifest.json, users.json, channels.json, 채널·월별 분할 JSONL, 읽기용 Markdown, AI 해석 안내문을 함께 생성해. 대규모 서버에서도 한 파일이 지나치게 커지지 않도록 메시지 수와 목표 용량 기준으로 자동 분할해."; panel.appendChild(note);
		return panel;
	}

	makeSettingCheckbox (label, key, afterChange) {
		const wrap = document.createElement("label"); wrap.className = "cle-setting-row"; wrap.style.justifyContent = "flex-start"; wrap.style.gap = "10px";
		const input = document.createElement("input"); input.type = "checkbox"; input.checked = !!this.settings[key]; input.addEventListener("change", () => {this.settings[key] = input.checked; this.saveSettings(); if (afterChange) afterChange(input.checked);});
		const span = document.createElement("span"); span.textContent = label; wrap.append(input, span); return wrap;
	}

	makeNumberSetting (label, key, min, max) {
		const wrap = document.createElement("label"); wrap.className = "cle-setting-row";
		const span = document.createElement("span"); span.textContent = label;
		const input = document.createElement("input"); input.type = "number"; input.className = "cle-input"; input.style.width = "110px"; input.min = String(min); input.max = String(max); input.value = String(this.settings[key]);
		input.addEventListener("change", () => {let value = Number(input.value); if (!Number.isFinite(value)) value = this.defaultSettings[key]; value = Math.max(min, Math.min(max, Math.floor(value))); this.settings[key] = value; input.value = String(value); this.saveSettings();});
		wrap.append(span, input); return wrap;
	}

	showCacheInfo () {
		const rows = [];
		this.ensureBaseFolders();
		for (const id of this.fs.readdirSync(this.getCacheRoot())) {
			const dir = this.path.join(this.getCacheRoot(), id);
			if (!this.fs.statSync(dir).isDirectory() || id.startsWith(".docx-")) continue;
			const manifest = this.readManifest(id, "");
			rows.push(`${manifest.scopeType === "dm" ? "DM · " : ""}${manifest.guildName} (${manifest.sourceId || id})\n메시지: ${Number(manifest.totalMessages || 0).toLocaleString()}개 · 용량: ${this.formatBytes(this.getDirectorySize(dir))}\n마지막 전체 수집: ${manifest.lastFullScanAt ? this.formatDate(manifest.lastFullScanAt) : "없음"}\n위치: ${dir}`);
		}
		BdApi.UI.alert("ChatLogExporter 저장 정보", rows.length ? rows.join("\n\n") : `저장된 서버 로그가 없어.\n\n캐시 위치: ${this.getCacheRoot()}`);
	}

	serializeError (context, error) {
		const diagnostic = this.collectionDiagnostics ? `\nCollection diagnostics:\n${JSON.stringify(this.collectionDiagnostics, null, 2)}` : "";
		return `[ChatLogExporter ${this.version}] ${context}\nTime: ${new Date().toISOString()}\nScope: ${JSON.stringify((() => {const scope = this.getActiveScopeInfo(); return scope ? {type: scope.type, sourceId: scope.sourceId, cacheId: scope.cacheId, name: scope.name, channelId: scope.channelId || ""} : null;})())}\nCurrent: ${JSON.stringify(this.safeDiagnosticContext())}\n${error && (error.stack || error.message) || String(error || "Unknown error")}${diagnostic}`;
	}
	async copyText (text) {
		const value = String(text);
		try {if (navigator.clipboard && navigator.clipboard.writeText) {await navigator.clipboard.writeText(value); return true;}} catch (_) {}
		try {
			const nativeClipboard = globalThis.DiscordNative && globalThis.DiscordNative.clipboard;
			if (nativeClipboard && typeof nativeClipboard.copy === "function") {nativeClipboard.copy(value); return true;}
			if (nativeClipboard && typeof nativeClipboard.writeText === "function") {nativeClipboard.writeText(value); return true;}
		}
		catch (_) {}
		try {const electron = require("electron"); const clipboard = electron && electron.clipboard; if (clipboard && clipboard.writeText) {clipboard.writeText(value); return true;}} catch (_) {}
		try {
			const area = document.createElement("textarea");
			area.value = value;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			area.style.pointerEvents = "none";
			document.body.appendChild(area);
			area.focus();
			area.select();
			area.setSelectionRange(0, area.value.length);
			const copied = !!document.execCommand("copy");
			area.remove();
			if (copied) return true;
		}
		catch (_) {}
		return false;
	}
	async reportError (context, error) {
		const details = this.serializeError(context, error);
		console.error("[ChatLogExporter]", context, error);
		// Write diagnostics to a FILE instead of the clipboard — auto-copying here
		// used to clobber whatever the user was typing/had copied.
		let savedPath = "";
		try {
			this.fs.mkdirSync(this.getCacheRoot(), {recursive: true});
			savedPath = this.path.join(this.getCacheRoot(), "last-error.txt");
			this.fs.writeFileSync(savedPath, details, "utf8");
		}
		catch (_) {}
		BdApi.UI.alert("ChatLogExporter 오류", `${context} 중 오류가 발생했어.\n\n${savedPath ? `진단 정보를 파일에 저장했어:\n${savedPath}` : "콘솔에 기록했어."}\n\n${details}`);
	}
	safeAction (context, fn) {try {const result = fn(); if (result && typeof result.catch === "function") result.catch(error => this.reportError(context, error));} catch (error) {this.reportError(context, error);}}
};
