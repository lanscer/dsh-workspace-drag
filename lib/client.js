/**
 * dsh-workspace-drag — client half.
 *
 * 无感拖拽整理：从侧边栏把一个对话（会话行）拖到另一个工作区分组上即完成
 * 跨工作区迁移。没有浮动弹窗、没有中间面板——拖到哪个工作区（组头或该组
 * 内任意会话行）就直接归到那个工作区。
 *
 * 行为：
 *   - 拖到【另一个工作区】的组头或组内任意会话行 → 移动会话（宿主端迁移
 *     cwd + 磁盘位置 + 工作区归属账本）。
 *   - 同工作区内会话行之间的拖放 → 放行给 dsh 原生排序，本插件不干预。
 *   - 设置页（settings.section）提供开关，可随时启用/禁用；禁用后拖拽无感。
 */
window.__ModuleLoader__.load({
	id: "dsh-workspace-drag",
	factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	var React = require("react");
	var createElement = React.createElement;
	var useState = React.useState;
	var useEffect = React.useEffect;
	var useReducer = React.useReducer;

	// ---------------------------------------------------------------------
	// Locales
	// ---------------------------------------------------------------------
	var zh = {
		"settings.loading": "加载中…",
		"settings.title": "拖拽归类对话",
		"settings.subtitle": "把侧边栏的对话直接拖到任意工作区分组即可归入该工作区",
		"settings.enabled": "启用拖拽归类",
		"settings.enabledDesc": "关闭后拖拽不会触发跨工作区移动",
		"settings.moved": "已把对话移动到工作区「",
		"settings.failed": "移动失败",
		"settings.live": "该对话当前正在使用中，请先切换到其他对话再移动",
	};
	var en = {
		"settings.loading": "Loading…",
		"settings.title": "Drag to Organize",
		"settings.subtitle": "Drag a conversation onto any workspace group to move it there",
		"settings.enabled": "Enable drag-to-organize",
		"settings.enabledDesc": "When off, dragging never triggers a cross-workspace move",
		"settings.moved": "Moved conversation to workspace \"",
		"settings.failed": "Move failed",
		"settings.live": "This conversation is currently in use; switch away first",
	};

	var NS = "workspace-drag";
	var CONFIG_API = "/api/dsh-workspace-drag/config";
	var MOVE_API = "/api/dsh-workspace-drag/move";

	// ---------------------------------------------------------------------
	// Config
	// ---------------------------------------------------------------------
	var cachedConfig = { enabled: true };
	var configListeners = [];

	function refreshConfig() {
		return fetch(CONFIG_API, { cache: "no-store" })
			.then(function (res) { return res.json(); })
			.then(function (data) {
				cachedConfig.enabled = !(data && data.enabled === false);
				notifyConfig();
				return cachedConfig;
			})
			.catch(function (error) {
				console.warn("[dsh-workspace-drag] config fetch failed:", error);
				return cachedConfig;
			});
	}

	function patchConfig(patch) {
		Object.assign(cachedConfig, patch);
		return fetch(CONFIG_API, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		})
			.then(function (res) { return res.json(); })
			.then(function (data) {
				cachedConfig.enabled = !(data && data.enabled === false);
				notifyConfig();
				return cachedConfig;
			})
			.catch(function (error) {
				console.warn("[dsh-workspace-drag] config write failed:", error);
				return cachedConfig;
			});
	}

	function notifyConfig() {
		for (var i = 0; i < configListeners.length; i++) configListeners[i](cachedConfig);
	}
	function onConfig(listener) {
		configListeners.push(listener);
		return function () {
			configListeners = configListeners.filter(function (l) { return l !== listener; });
		};
	}

	// ---------------------------------------------------------------------
	// Styles
	// ---------------------------------------------------------------------
	var CSS = "" +
		".dswd-drop-zone{outline:2px solid var(--dsh-primary,#4f8cff);outline-offset:-2px;border-radius:6px}" +
		".dswd-drop-zone .dswd-group-title{color:var(--dsh-primary,#4f8cff)}" +
		".dswd-drop-banner{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;" +
		"background:rgba(20,24,33,.92);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;" +
		"box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis}" +
		".dswd-settings{padding:16px 0;border-bottom:1px solid rgba(128,128,128,.18)}" +
		".dswd-settings h3{margin:0 0 4px;font-size:15px}" +
		".dswd-settings .dswd-sub{color:var(--text-color2,#8a919b);font-size:12px;margin:0 0 12px}" +
		".dswd-settings .dswd-muted{color:var(--text-color2,#8a919b);font-size:13px}" +
		".dswd-row{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none}" +
		".dswd-row input{width:16px;height:16px;accent-color:var(--dsh-primary,#4f8cff)}" +
		".dswd-desc{color:var(--text-color2,#8a919b);font-size:12px}";

	function injectStyles() {
		try {
			if (document.getElementById("dswd-style")) return;
			var style = document.createElement("style");
			style.id = "dswd-style";
			style.textContent = CSS;
			document.head.appendChild(style);
		} catch (error) {
			console.warn("[dsh-workspace-drag] injectStyles failed:", error);
		}
	}

	// ---------------------------------------------------------------------
	// Workspace helpers
	// ---------------------------------------------------------------------
	function workspacesOf(ctx) {
		try {
			var store = ctx.workspaces && ctx.workspaces.list;
			if (store && typeof store.getSnapshot === "function") {
				var snap = store.getSnapshot();
				return (snap && Array.isArray(snap.items) ? snap.items : []).filter(Boolean);
			}
			if (store && typeof store.getState === "function") {
				var state = store.getState();
				return (state && Array.isArray(state.items) ? state.items : []).filter(Boolean);
			}
		} catch (error) {
			console.warn("[dsh-workspace-drag] workspacesOf failed:", error);
		}
		return [];
	}

	/** The workspace the user sees a workspace title of; used for messaging. */
	function workspaceTitleOf(workspace) {
		if (!workspace) return "";
		return workspace.title || workspace.name || workspace.workspaceId || "";
	}

	// ---------------------------------------------------------------------
	// Drag state
	// ---------------------------------------------------------------------
	var dragState = {
		sessionDragging: false,
		sourceWorkspace: null,
		sourceWorkspaceId: null,
		hoveredGroup: null,
	};

	function clearHover() {
		if (dragState.hoveredGroup) {
			try { dragState.hoveredGroup.classList.remove("dswd-drop-zone"); } catch (error) { /* ignore */ }
			dragState.hoveredGroup = null;
		}
	}

	// ---------------------------------------------------------------------
	// DOM helpers (CSS-module hash suffixes — robust to stable class names)
	// ---------------------------------------------------------------------
	var SESSION_ROW = "[class*='sessionRow']";
	var PROJECT_ROW = "[class*='projectRow']";
	var GROUP_SECTION = "[class*='groupSection']";

	function closestNode(node, selector) {
		try {
			var cur = node;
			while (cur && cur !== document) {
				if (cur.matches && cur.matches(selector)) return cur;
				cur = cur.parentNode;
			}
		} catch (error) { /* ignore */ }
		return null;
	}

	function isSessionRow(node) {
		return closestNode(node, SESSION_ROW) !== null;
	}

	/** The sidebar group (section) containing the node, if any. */
	function workspaceGroupOf(node) {
		return closestNode(node, GROUP_SECTION);
	}

	/** Resolve a workspace record for a group node (walk up to its project row). */
	function resolveWorkspace(ctx, group) {
		try {
			if (!group) return null;
			var projectRow = closestNode(group, PROJECT_ROW);
			if (!projectRow) {
				// Fall back: match by the group's text (title) against known workspaces.
				var title = (group.textContent || "").trim();
				if (!title) return null;
				var items = workspacesOf(ctx);
				for (var i = 0; i < items.length; i++) {
					if (items[i] && workspaceTitleOf(items[i]) && title.indexOf(workspaceTitleOf(items[i])) !== -1) {
						return items[i];
					}
				}
				return null;
			}
			var key = projectRow.getAttribute("data-key");
			if (key) {
				var byKey = findWorkspaceByKey(ctx, key);
				if (byKey) return byKey;
			}
			// Match project row text to workspace title.
			var rowTitle = (projectRow.textContent || "").trim();
			var candidates = workspacesOf(ctx);
			var best = null;
			var bestLen = -1;
			for (var j = 0; j < candidates.length; j++) {
				var w = candidates[j];
				var t = workspaceTitleOf(w);
				if (!t) continue;
				if (rowTitle.indexOf(t) !== -1 && t.length > bestLen) { best = w; bestLen = t.length; }
			}
			return best;
		} catch (error) {
			console.warn("[dsh-workspace-drag] resolveWorkspace failed:", error);
			return null;
		}
	}

	function findWorkspaceByKey(ctx, key) {
		if (!key) return null;
		var items = workspacesOf(ctx);
		for (var i = 0; i < items.length; i++) {
			var w = items[i];
			if (!w) continue;
			var wKey = w.workspaceId || w.id || w.key || "";
			if (wKey === key) return w;
		}
		return null;
	}

	// ---------------------------------------------------------------------
	// Result banner
	// ---------------------------------------------------------------------
	var bannerEl = null;
	var bannerTimer = null;

	function showBanner(text) {
		try {
			hideBanner();
			bannerEl = document.createElement("div");
			bannerEl.className = "dswd-drop-banner";
			bannerEl.textContent = text;
			document.body.appendChild(bannerEl);
		} catch (error) {
			console.warn("[dsh-workspace-drag] banner failed:", error);
		}
	}
	function hideBanner() {
		if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
		bannerEl = null;
		if (bannerTimer) clearTimeout(bannerTimer);
		bannerTimer = null;
	}
	function transientBanner(text, ms) {
		showBanner(text);
		bannerTimer = setTimeout(hideBanner, ms || 2400);
	}

	// ---------------------------------------------------------------------
	// Move
	// ---------------------------------------------------------------------
	async function performMove(ctx, sessionId, workspace) {
		if (!workspace || !workspace.workspaceId) return;
		try {
			var res = await fetch(MOVE_API, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: sessionId,
					targetWorkspaceId: workspace.workspaceId,
				}),
			});
			var data = await res.json();
			if (data && data.ok === true) {
				transientBanner("✅ " + ctx.locale.bind(NS)("settings.moved") + workspaceTitleOf(workspace) + "」", 2600);
				try {
					if (ctx.workspaces && typeof ctx.workspaces.refresh === "function") {
						await ctx.workspaces.refresh();
					}
				} catch (refreshError) {
					console.warn("[dsh-workspace-drag] refresh failed:", refreshError);
				}
			} else {
				var msg = data && data.error ? data.error : ctx.locale.bind(NS)("settings.failed");
				transientBanner("⚠️ " + msg, 3400);
			}
		} catch (error) {
			console.warn("[dsh-workspace-drag] move failed:", error);
			transientBanner("⚠️ " + ctx.locale.bind(NS)("settings.failed"), 3400);
		}
	}

	// ---------------------------------------------------------------------
	// Drag engine
	// ---------------------------------------------------------------------
	function installDragEngine(ctx) {
		var onDragStart = function (event) {
			if (!cachedConfig.enabled) return;
			if (isSessionRow(event.target)) {
				dragState.sessionDragging = true;
				var srcGroup = workspaceGroupOf(event.target);
				var srcWs = srcGroup ? resolveWorkspace(ctx, srcGroup) : null;
				dragState.sourceWorkspace = srcWs;
				dragState.sourceWorkspaceId = srcWs ? srcWs.workspaceId : null;
			} else {
				dragState.sessionDragging = false;
				dragState.sourceWorkspace = null;
				dragState.sourceWorkspaceId = null;
			}
			clearHover();
		};

		var onDragOver = function (event) {
			if (!cachedConfig.enabled || !dragState.sessionDragging) return;

			var group = workspaceGroupOf(event.target);
			if (!group) {
				clearHover();
				return;
			}
			var workspace = resolveWorkspace(ctx, group);
			if (!workspace) {
				clearHover();
				return;
			}
			// Same-workspace session-row hover → native reorder; don't hijack.
			if (isSessionRow(event.target) && dragState.sourceWorkspaceId &&
				workspace.workspaceId === dragState.sourceWorkspaceId) {
				clearHover();
				return;
			}
			if (dragState.hoveredGroup !== group) {
				clearHover();
				dragState.hoveredGroup = group;
				try { group.classList.add("dswd-drop-zone"); } catch (error) { /* ignore */ }
			}
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		};

		var onDrop = function (event) {
			if (!cachedConfig.enabled || !dragState.sessionDragging) return;

			var group = workspaceGroupOf(event.target);
			if (!group) return;
			var workspace = resolveWorkspace(ctx, group);
			if (!workspace) return;
			// Same-workspace session-row drop → let the built-in reorder handle it.
			if (isSessionRow(event.target) && dragState.sourceWorkspaceId &&
				workspace.workspaceId === dragState.sourceWorkspaceId) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			clearHover();
			dragState.sessionDragging = false;
			var sid = readSessionId(event);
			if (sid === "") return;
			performMove(ctx, sid, workspace);
		};

		var onDragEnd = function () {
			dragState.sessionDragging = false;
			dragState.sourceWorkspace = null;
			dragState.sourceWorkspaceId = null;
			clearHover();
			hideBanner();
		};

		document.addEventListener("dragstart", onDragStart, true);
		document.addEventListener("dragover", onDragOver, true);
		document.addEventListener("drop", onDrop, true);
		document.addEventListener("dragend", onDragEnd, true);
		document.addEventListener("dragleave", clearHover, true);

		return function dispose() {
			document.removeEventListener("dragstart", onDragStart, true);
			document.removeEventListener("dragover", onDragOver, true);
			document.removeEventListener("drop", onDrop, true);
			document.removeEventListener("dragend", onDragEnd, true);
			document.removeEventListener("dragleave", clearHover, true);
			dragState.sessionDragging = false;
			dragState.sourceWorkspace = null;
			dragState.sourceWorkspaceId = null;
			clearHover();
			hideBanner();
		};
	}

	/** Read the dragged session id from the drop's dataTransfer. */
	function readSessionId(event) {
		try {
			return event.dataTransfer ? (event.dataTransfer.getData("text/plain") || "") : "";
		} catch (error) {
			return "";
		}
	}

	// ---------------------------------------------------------------------
	// Settings section (React component rendered inside the "插件" settings page)
	// ---------------------------------------------------------------------
	function SettingsSection(props) {
		var t = props.t;
		var ignore = useReducer(function (x) { return x + 1; }, 0)[1];
		var loadedState = useState(false);
		var loaded = loadedState[0];
		var setLoaded = loadedState[1];

		useEffect(function () {
			var unsub = onConfig(ignore);
			refreshConfig().then(function () { setLoaded(true); });
			return unsub;
		}, []);

		if (!loaded) {
			return createElement("div", { className: "dswd-settings" },
				createElement("p", { className: "dswd-muted" }, t("settings.loading"))
			);
		}

		var cfg = cachedConfig;
		var enabled = cfg.enabled;

		var onToggle = function (event) {
			patchConfig({ enabled: event.target.checked });
		};

		return createElement("div", { className: "dswd-settings" },
			createElement("h3", null, t("settings.title")),
			createElement("p", { className: "dswd-sub" }, t("settings.subtitle")),
			createElement("label", { className: "dswd-row" },
				createElement("input", { type: "checkbox", checked: enabled, onChange: onToggle }),
				createElement("span", null, t("settings.enabled"))
			),
			createElement("span", { className: "dswd-desc" }, t("settings.enabledDesc"))
		);
	}

	// ---------------------------------------------------------------------
	// Plugin entry
	// ---------------------------------------------------------------------
	var inject = ["slots", "locale", "sessions", "workspaces"];

	/** Module-level guard: first application wins, later calls no-op. */
	var claimed = false;

	function apply(ctx) {
		if (claimed) return;
		claimed = true;

		injectStyles();

		ctx.effect(function () {
			ctx.locale.register(NS, { zh: zh, en: en });
		}, "workspace-drag: dictionaries");

		// Seed the config once at load.
		refreshConfig();

		// Drag engine: active while the toggle is on. Handlers consult
		// cachedConfig.enabled per event, so toggling takes effect instantly.
		ctx.effect(function () {
			var dispose = installDragEngine(ctx);
			return function () {
				dispose();
			};
		}, "workspace-drag: drag engine");

		// First-level settings page ("单独插件页面").
		ctx.slots.inject("settings.section", function () {
			var unregister = ctx.slots.register({
				name: "settings.section",
				id: "workspace-drag",
				order: 165,
				label: function () { return ctx.locale.bind(NS)("settings.title"); },
				locale: NS,
			}, SettingsSection);
			return function () { unregister(); };
		});
	}

	exports.apply = apply;
	exports.inject = inject;
	return module.exports;
	}
});
