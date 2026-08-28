const MODULE_NAME = 'molan_gallery';
const BUILD_VERSION = '1.11.3-statusbar-bottom';
const ROOT_ID = 'molan-gallery-root';
const LAUNCHER_ID = 'molan-gallery-launcher';
const SETTINGS_ID = 'molan-gallery-settings';
const GENERATION_ENDPOINTS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/backends/koboldhorde/generate',
    '/api/novelai/generate',
    '/api/horde/generate-text',
]);
const EMPTY_USAGE = Object.freeze({ input: 0, output: 0, total: 0, userMessages: 0, last: null });
const DEFAULT_MEMORY = Object.freeze({
    enabled: false,
    everyMessages: 20,
    instruction: '只整理已確認、會影響後續對話的長期記憶。不要推測使用者未明說的想法，也不要虛構事件。',
    format: '【人物與關係】\n- \n\n【已確認事件】\n- \n\n【承諾與待辦】\n- \n\n【重要物品與地點】\n- \n\n【偏好、界線與禁忌】\n- ',
    content: '',
    lastSummarizedCount: 0,
    updatedAt: 0,
});
const MAX_STATUSBAR_FILE_BYTES = 2 * 1024 * 1024;
const TAVERN_HELPER_STATUSBAR_SELECTOR = '#dayan-statusbar-host-v2';
const TAVERN_HELPER_STATUSBAR_SLOT_ID = 'mol-tavern-helper-statusbar-slot';
const DEFAULT_SETTINGS = Object.freeze({
    autoOpen: false,
    compactMessages: false,
    interfaceFontSize: 14,
    messageFontSize: 14,
    usageTotals: structuredClone(EMPTY_USAGE),
});

let initialized = false;
let isOpen = false;
let isBusy = false;
let activeFilter = 'all';
let searchQuery = '';
let focusMode = false;
let sidebarOpen = false;
let streamTimer = 0;
let attachmentName = '';
let activeDialogCleanup = null;
let manualGenerationPermitUntil = 0;
let blockedGenerationUntil = 0;
let groupReplyBatchActive = false;
let groupDraftOverLimit = false;
const groupReplyCounts = new Map();
const MAX_GROUP_MEMBERS = 5;
let chatEntries = [];
let chatListLoading = false;
let chatListRequest = 0;
let summaryRunning = false;
let currentGeneration = { type: '', chatId: '', startedAt: 0 };
let characterCarouselIndex = 0;
let characterCarouselFlipped = false;
let characterSwipeIgnoreUntil = 0;
let characterCarouselTransitioning = false;
let characterCarouselEnterDirection = 0;
let characterCarouselTransitionTimer = null;
let tavernHelperStatusBarObserver = null;
let tavernHelperStatusBarSyncFrame = 0;
let tavernHelperStatusBarHome = null;
let nativeFetch = null;
let fetchWrapper = null;
let worldInfoModulePromise = null;
let scriptModulePromise = null;
let groupModulePromise = null;
let personaModulePromise = null;
const subscribedEvents = [];

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

function getSettings() {
    const context = getContext();
    if (!context) return structuredClone(DEFAULT_SETTINGS);
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = structuredClone(value);
        }
    }
    context.extensionSettings[MODULE_NAME].usageTotals = normalizeUsage(context.extensionSettings[MODULE_NAME].usageTotals);
    context.extensionSettings[MODULE_NAME].interfaceFontSize = clampFontSize(context.extensionSettings[MODULE_NAME].interfaceFontSize, 11, 22, DEFAULT_SETTINGS.interfaceFontSize);
    context.extensionSettings[MODULE_NAME].messageFontSize = clampFontSize(context.extensionSettings[MODULE_NAME].messageFontSize, 12, 32, DEFAULT_SETTINGS.messageFontSize);
    return context.extensionSettings[MODULE_NAME];
}

function clampFontSize(value, min, max, fallback) {
    const size = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(size) ? Math.round(size) : fallback));
}

function applyTypographySettings() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const settings = getSettings();
    const scale = settings.interfaceFontSize / DEFAULT_SETTINGS.interfaceFontSize;
    root.style.setProperty('--mol-ui-scale', String(scale));
    root.style.setProperty('--mol-chat-font-size', settings.messageFontSize + 'px');
    root.style.setProperty('--mol-dialog-width', Math.round(460 * scale) + 'px');
    root.style.setProperty('--mol-wide-dialog-width', Math.round(860 * scale) + 'px');
    root.style.setProperty('--mol-dialog-padding', Math.round(28 * scale) + 'px');
    root.style.setProperty('--mol-dialog-mobile-padding', Math.round(22 * scale) + 'px');
    root.style.setProperty('--mol-dialog-layer-padding', Math.round(20 * scale) + 'px');
    root.style.setProperty('--mol-dialog-layer-mobile-padding', Math.round(10 * scale) + 'px');
    root.style.setProperty('--mol-dialog-shadow', Math.round(10 * scale) + 'px');
    syncDialogViewport();
}

function syncDialogViewport() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    root.style.setProperty('--mol-viewport-left', left + 'px');
    root.style.setProperty('--mol-viewport-top', top + 'px');
    root.style.setProperty('--mol-viewport-width', width + 'px');
    root.style.setProperty('--mol-viewport-height', height + 'px');
}

function installViewportSync() {
    syncDialogViewport();
    window.addEventListener('resize', syncDialogViewport, { passive: true });
    window.addEventListener('orientationchange', syncDialogViewport, { passive: true });
    window.visualViewport?.addEventListener('resize', syncDialogViewport, { passive: true });
    window.visualViewport?.addEventListener('scroll', syncDialogViewport, { passive: true });
}

function removeViewportSync() {
    window.removeEventListener('resize', syncDialogViewport);
    window.removeEventListener('orientationchange', syncDialogViewport);
    window.visualViewport?.removeEventListener('resize', syncDialogViewport);
    window.visualViewport?.removeEventListener('scroll', syncDialogViewport);
}

function getTavernHelperStatusBar() {
    return document.querySelector(TAVERN_HELPER_STATUSBAR_SELECTOR);
}

function isTavernHelperStatusBarBridged() {
    const host = getTavernHelperStatusBar();
    return Boolean(host && host.parentElement?.id === TAVERN_HELPER_STATUSBAR_SLOT_ID);
}

function updateTavernHelperStatusBarSummary() {
    const summary = document.getElementById('mol-statusbar-summary');
    if (!summary || !getTavernHelperStatusBar()) return;
    summary.textContent = isTavernHelperStatusBarBridged()
        ? '酒館助手狀態欄 · 已同步顯示'
        : '酒館助手狀態欄 · 等待同步';
}

function syncTavernHelperStatusBar() {
    tavernHelperStatusBarSyncFrame = 0;
    if (!isOpen) return false;
    const slot = document.getElementById(TAVERN_HELPER_STATUSBAR_SLOT_ID);
    const host = getTavernHelperStatusBar();
    if (!slot || !host) {
        if (slot?.dataset.statusbarSource === 'tavern-helper' && !slot.childElementCount) {
            delete slot.dataset.statusbarSource;
            renderStatusBarArea();
        }
        updateTavernHelperStatusBarSummary();
        return false;
    }
    if (host.parentElement !== slot) {
        tavernHelperStatusBarHome = {
            node: host,
            parent: host.parentNode,
            nextSibling: host.nextSibling,
            hadFallbackClass: host.classList.contains('dy-fallback'),
        };
        host.classList.remove('dy-fallback');
        host.dataset.molanGalleryBridged = 'true';
        slot.replaceChildren(host);
    }
    slot.dataset.statusbarSource = 'tavern-helper';
    slot.hidden = false;
    updateTavernHelperStatusBarSummary();
    return true;
}

function queueTavernHelperStatusBarSync() {
    if (tavernHelperStatusBarSyncFrame || !isOpen) return;
    tavernHelperStatusBarSyncFrame = requestAnimationFrame(syncTavernHelperStatusBar);
}

function startTavernHelperStatusBarBridge() {
    syncTavernHelperStatusBar();
    if (tavernHelperStatusBarObserver || !document.body) return;
    tavernHelperStatusBarObserver = new MutationObserver(queueTavernHelperStatusBarSync);
    tavernHelperStatusBarObserver.observe(document.body, { childList: true, subtree: true });
}

function restoreTavernHelperStatusBar() {
    const home = tavernHelperStatusBarHome;
    const host = home?.node || getTavernHelperStatusBar();
    if (!host || host.parentElement?.id !== TAVERN_HELPER_STATUSBAR_SLOT_ID) {
        tavernHelperStatusBarHome = null;
        return;
    }
    const fallbackAnchor = document.querySelector('#form_sheld, #send_form, [data-testid="send-form"]');
    const parent = home?.parent?.isConnected ? home.parent : fallbackAnchor?.parentNode;
    const nextSibling = home?.nextSibling?.parentNode === parent
        ? home.nextSibling
        : (parent === fallbackAnchor?.parentNode ? fallbackAnchor : null);
    host.removeAttribute('data-molan-gallery-bridged');
    if (home?.hadFallbackClass) host.classList.add('dy-fallback');
    if (parent) parent.insertBefore(host, nextSibling || null);
    const slot = document.getElementById(TAVERN_HELPER_STATUSBAR_SLOT_ID);
    if (slot) {
        delete slot.dataset.statusbarSource;
        slot.hidden = true;
    }
    tavernHelperStatusBarHome = null;
}

function stopTavernHelperStatusBarBridge({ restore = true } = {}) {
    tavernHelperStatusBarObserver?.disconnect();
    tavernHelperStatusBarObserver = null;
    if (tavernHelperStatusBarSyncFrame) cancelAnimationFrame(tavernHelperStatusBarSyncFrame);
    tavernHelperStatusBarSyncFrame = 0;
    if (restore) restoreTavernHelperStatusBar();
}

function normalizeUsage(value) {
    const source = value && typeof value === 'object' ? value : {};
    const number = (key) => Number.isFinite(Number(source[key])) ? Math.max(0, Number(source[key])) : 0;
    return {
        input: number('input'),
        output: number('output'),
        total: number('total'),
        userMessages: number('userMessages'),
        last: source.last && typeof source.last === 'object' ? { ...source.last } : null,
    };
}

function normalizeMemory(value, legacy = '') {
    const source = value && typeof value === 'object' ? value : {};
    return {
        enabled: Boolean(source.enabled),
        everyMessages: Math.max(5, Math.min(200, Number(source.everyMessages) || DEFAULT_MEMORY.everyMessages)),
        instruction: typeof source.instruction === 'string' ? source.instruction : DEFAULT_MEMORY.instruction,
        format: typeof source.format === 'string' ? source.format : DEFAULT_MEMORY.format,
        content: typeof source.content === 'string' ? source.content : (typeof legacy === 'string' ? legacy : ''),
        lastSummarizedCount: Math.max(0, Number(source.lastSummarizedCount) || 0),
        updatedAt: Math.max(0, Number(source.updatedAt) || 0),
    };
}

function statusBarColor(value, fallback) {
    return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? String(value) : fallback;
}

function findAssignedJsonObject(content) {
    const text = String(content || '');
    const assignment = /(?:const|let|var)\s+[A-Za-z_$][\w$]*CONFIG[\w$]*\s*=\s*/g.exec(text)
        || /(?:const|let|var)\s+DAYAN_CONFIG\s*=\s*/g.exec(text);
    let start = assignment ? text.indexOf('{', assignment.index + assignment[0].length) : -1;
    if (start < 0) start = text.search(/\{\s*"meta"\s*:/);
    if (start < 0) throw new Error('找不到可讀取的狀態欄 CONFIG。');
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === '{') depth += 1;
        if (character === '}') {
            depth -= 1;
            if (depth === 0) return JSON.parse(text.slice(start, index + 1));
        }
    }
    throw new Error('狀態欄 CONFIG 結構不完整。');
}

function createStatusBarState(config) {
    return {
        fields: Object.fromEntries(config.fields.map((item) => [item.id, structuredClone(item.value)])),
        affinities: Object.fromEntries(config.affinities.map((item) => [item.id, item.value])),
        resources: Object.fromEntries(config.resources.map((item) => [item.id, item.initial])),
        memo: config.dynamicMessages[0]?.value || '目前沒有待辦事項',
        mode: config.defaultMode,
        collapsed: false,
        hidden: false,
        lastAction: null,
        textLedger: {},
        recentTransactions: [],
    };
}

function normalizeStatusBar(value) {
    if (!value || typeof value !== 'object' || !value.config) return null;
    const raw = value.config;
    const fields = Array.isArray(raw.fields) ? raw.fields.slice(0, 40).map((item, index) => ({
        id: String(item?.id || ('field-' + index)).slice(0, 60),
        label: String(item?.label || item?.id || ('欄位 ' + (index + 1))).slice(0, 80),
        type: String(item?.type || 'text').slice(0, 40),
        value: Array.isArray(item?.value) ? item.value.slice(0, 20).map(String) : (typeof item?.value === 'number' ? item.value : String(item?.value ?? '—').slice(0, 1000)),
    })) : [];
    const affinities = Array.isArray(raw.affinities) ? raw.affinities.slice(0, 30).map((item, index) => ({
        id: String(item?.id || ('affinity-' + index)).slice(0, 60),
        name: String(item?.name || item?.id || ('角色 ' + (index + 1))).slice(0, 80),
        value: Math.max(0, Number(item?.value) || 0),
        max: Math.max(1, Number(item?.max) || 100),
    })) : [];
    const resources = Array.isArray(raw.resources) ? raw.resources.slice(0, 200).map((item, index) => ({
        id: String(item?.id || ('resource-' + index)).slice(0, 80),
        name: String(item?.name || item?.id || ('資源 ' + (index + 1))).slice(0, 100),
        category: String(item?.category || 'item').slice(0, 40),
        initial: Math.max(0, Math.round(Number(item?.initial ?? item?.value) || 0)),
        max: Math.max(1, Math.round(Number(item?.max) || 1)),
    })) : [];
    const modes = Array.isArray(raw.modes) ? raw.modes.slice(0, 12).map((item, index) => ({
        id: String(item?.id || ('mode-' + index)).slice(0, 40),
        name: String(item?.name || item?.id || ('模式 ' + (index + 1))).slice(0, 60),
        fields: Array.isArray(item?.fields) ? item.fields.slice(0, 40).map(String) : [],
    })) : [];
    if (!fields.length && !affinities.length && !resources.length) throw new Error('檔案中沒有可顯示的欄位、好感度或資源。');
    const defaultMode = String(raw.meta?.defaultMode || modes[0]?.id || 'status');
    const config = {
        title: String(raw.meta?.title || value.name || '互動狀態欄').slice(0, 100),
        schemaVersion: Number(raw.meta?.schemaVersion) || 1,
        defaultMode,
        theme: {
            background: statusBarColor(raw.theme?.background, '#111313'),
            panel: statusBarColor(raw.theme?.panel, '#171817'),
            panelSoft: statusBarColor(raw.theme?.panelSoft, '#1d1e1d'),
            border: statusBarColor(raw.theme?.border, '#343331'),
            text: statusBarColor(raw.theme?.text, '#e8e4dc'),
            muted: statusBarColor(raw.theme?.muted, '#9d9a94'),
            accent: statusBarColor(raw.theme?.accent, '#d6c49a'),
        },
        modes: modes.length ? modes : [{ id: 'status', name: '狀態', fields: fields.map((item) => item.id) }],
        fields,
        affinities,
        affinityBadges: Array.isArray(raw.affinityBadges) ? raw.affinityBadges.slice(0, 20).map((item) => ({ below: Number(item?.below) || 101, label: String(item?.label || '').slice(0, 50) })) : [],
        resourcePolicy: {
            aiEnabled: raw.resourcePolicy?.aiEnabled !== false,
            aiPrompt: String(raw.resourcePolicy?.aiPrompt || '任一角色在劇情中給予玩家＝增加、任一角色從玩家身上取走或消耗＝減少、玩家主動消耗＝減少').slice(0, 4000),
            amount: Math.max(1, Math.round(Number(raw.resourcePolicy?.buttonAction?.amount) || 1)),
        },
        resources,
        dynamicMessages: Array.isArray(raw.dynamicMessages) ? raw.dynamicMessages.slice(0, 20).map((item) => ({ id: String(item?.id || ''), name: String(item?.name || ''), value: String(item?.value || ''), rule: String(item?.rule || '').slice(0, 4000) })) : [],
    };
    const defaults = createStatusBarState(config);
    const sourceState = value.state && typeof value.state === 'object' ? value.state : {};
    const state = {
        ...defaults,
        fields: { ...defaults.fields, ...(sourceState.fields && typeof sourceState.fields === 'object' ? sourceState.fields : {}) },
        affinities: { ...defaults.affinities },
        resources: { ...defaults.resources },
        memo: typeof sourceState.memo === 'string' ? sourceState.memo.slice(0, 6000) : defaults.memo,
        mode: config.modes.some((item) => item.id === sourceState.mode) ? sourceState.mode : defaults.mode,
        collapsed: Boolean(sourceState.collapsed),
        hidden: Boolean(sourceState.hidden),
        lastAction: sourceState.lastAction && typeof sourceState.lastAction === 'object' ? sourceState.lastAction : null,
        textLedger: sourceState.textLedger && typeof sourceState.textLedger === 'object' ? sourceState.textLedger : {},
        recentTransactions: Array.isArray(sourceState.recentTransactions) ? sourceState.recentTransactions.slice(-30) : [],
    };
    for (const item of config.affinities) state.affinities[item.id] = Math.max(0, Math.min(item.max, Number(sourceState.affinities?.[item.id] ?? item.value) || 0));
    for (const item of config.resources) state.resources[item.id] = Math.max(0, Math.min(item.max, Math.round(Number(sourceState.resources?.[item.id] ?? item.initial) || 0)));
    return {
        enabled: value.enabled !== false,
        name: String(value.name || config.title).slice(0, 100),
        sourceId: String(value.sourceId || '').slice(0, 120),
        sourceType: String(value.sourceType || 'script').slice(0, 40),
        sourceInfo: String(value.sourceInfo || '').slice(0, 3000),
        marker: /^[A-Z][A-Z0-9_]{2,50}$/.test(String(value.marker || '')) ? String(value.marker) : 'MOLAN_STATUS',
        importedAt: Math.max(0, Number(value.importedAt) || Date.now()),
        config,
        state,
    };
}

function parseStatusBarFile(parsed, filename = '') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('檔案根層必須是 JSON 物件。');
    const config = parsed.meta && (parsed.fields || parsed.resources) ? parsed : findAssignedJsonObject(parsed.content);
    const markerMatch = String(parsed.content || '').match(/<!--\s*([A-Z][A-Z0-9_]*STATUS)\b/);
    return normalizeStatusBar({
        enabled: parsed.enabled !== false,
        name: parsed.name || config.meta?.title || filename.replace(/\.json$/i, ''),
        sourceId: parsed.id || '',
        sourceType: parsed.type || 'config',
        sourceInfo: parsed.info || '',
        marker: markerMatch?.[1] || 'MOLAN_STATUS',
        importedAt: Date.now(),
        config,
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function initials(name) {
    const text = String(name || '?').trim();
    return Array.from(text).slice(0, 2).join('').toUpperCase();
}

function truncate(text, length = 92) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > length ? value.slice(0, length - 1) + '…' : value;
}

function notify(message, tone = 'info') {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const toast = document.createElement('div');
    toast.className = 'mol-toast mol-toast-' + tone;
    toast.textContent = message;
    root.append(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 220);
    }, 2600);
}

function getEventTypes(context) {
    return context?.eventTypes || context?.event_types || {};
}

function currentEntity(context = getContext()) {
    if (!context) return null;
    if (context.groupId) {
        const group = context.groups.find((item) => String(item.id) === String(context.groupId));
        return group ? { type: 'group', item: group, id: group.id } : null;
    }
    const id = context.characterId;
    const character = id === undefined ? null : context.characters[id];
    return character ? { type: 'character', item: character, id } : null;
}

function getCharacterGreetings(entity = currentEntity()) {
    if (!entity || entity.type !== 'character') return [];
    const data = entity.item?.data || {};
    const first = String(data.first_mes ?? entity.item?.first_mes ?? '').trim();
    const alternates = Array.isArray(data.alternate_greetings)
        ? data.alternate_greetings
        : (Array.isArray(entity.item?.alternate_greetings) ? entity.item.alternate_greetings : []);
    return [first, ...alternates.map((item) => String(item ?? '').trim())].filter(Boolean);
}

function currentGreetingIndex(context, greetings) {
    const opening = context?.chat?.[0];
    if (!opening || opening.is_user) return -1;
    const exact = greetings.findIndex((item) => item === String(opening.mes || '').trim());
    if (exact >= 0) return exact;
    const swipeId = Number(opening.swipe_id);
    const swipes = Array.isArray(opening.swipes) ? opening.swipes.map((item) => String(item || '').trim()) : [];
    if (Number.isInteger(swipeId) && swipeId >= 0 && swipeId < swipes.length) {
        const matchedSwipe = greetings.findIndex((item) => item === swipes[swipeId]);
        if (matchedSwipe >= 0) return matchedSwipe;
    }
    return 0;
}

async function switchGreeting(index) {
    const context = getContext();
    const entity = currentEntity(context);
    if (!entity || entity.type !== 'character') {
        notify('開場白切換僅支援單人角色聊天室。', 'warning');
        return false;
    }
    const greetings = getCharacterGreetings(entity);
    const selected = greetings[index];
    if (!selected) {
        notify('找不到指定的開場白。', 'warning');
        return false;
    }
    const opening = context.chat?.[0];
    if (!opening || opening.is_user) {
        notify('目前聊天室沒有可替換的第一則角色訊息。', 'warning');
        return false;
    }
    opening.swipes = [...greetings];
    opening.swipe_id = index;
    opening.mes = selected;
    opening.name = entity.item?.name || entity.item?.data?.name || opening.name;
    if (opening.extra) delete opening.extra.display_text;
    if (typeof context.saveChatConditional === 'function') await context.saveChatConditional();
    else await context.saveChat?.();
    context.updateMessageBlock?.(0, opening);
    const editedEvent = getEventTypes(context).MESSAGE_EDITED;
    if (editedEvent) await context.eventSource?.emit?.(editedEvent, 0);
    refreshAll();
    notify((index === 0 ? '預設開場白' : '開場白 ' + (index + 1)) + '已套用至目前聊天室。');
    return true;
}

function avatarUrl(entity, context = getContext()) {
    if (!entity || !context) return '';
    try {
        if (entity.type === 'group') return entity.item.avatar_url || '';
        return context.getThumbnailUrl('avatar', entity.item.avatar);
    } catch {
        return '';
    }
}

function originalAvatarUrl(entity) {
    if (!entity) return '';
    if (entity.type === 'group') return entity.item.avatar_url || '';
    const avatar = String(entity.item?.avatar || '').trim();
    if (!avatar || avatar === 'none') return '';
    if (/^(?:data:|blob:|https?:\/\/|\/)/i.test(avatar)) return avatar;
    return '/characters/' + avatar.split('/').map(encodeURIComponent).join('/');
}

function portraitImageMarkup(entity, context, alt, className = '') {
    const original = originalAvatarUrl(entity);
    const fallback = avatarUrl(entity, context);
    if (!original && !fallback) return '';
    return '<img' + (className ? ' class="' + escapeHtml(className) + '"' : '')
        + ' src="' + escapeHtml(original || fallback) + '"'
        + (fallback && fallback !== original ? ' data-fallback="' + escapeHtml(fallback) + '"' : '')
        + ' alt="' + escapeHtml(alt || '') + '" loading="eager" decoding="async" draggable="false">';
}

function wireImageFallbacks(scope = document) {
    scope.querySelectorAll?.('img[data-fallback]').forEach((image) => {
        image.addEventListener('error', () => {
            const fallback = image.dataset.fallback;
            if (!fallback || image.dataset.fallbackUsed === 'true') return;
            image.dataset.fallbackUsed = 'true';
            image.src = fallback;
        }, { once: true });
    });
}

function entityRole(entity) {
    if (!entity) return '尚未選擇';
    if (entity.type === 'group') return '群組對話';
    const data = entity.item.data || {};
    return truncate(data.creator_notes || data.personality || entity.item.creator_notes || '角色', 22);
}

function getChatMeta(context = getContext()) {
    const defaults = { relationship: 50, memory: '', memorySummary: structuredClone(DEFAULT_MEMORY), usage: structuredClone(EMPTY_USAGE), statusBar: null };
    const stored = context?.chatMetadata?.[MODULE_NAME];
    if (!stored || typeof stored !== 'object') return defaults;
    return {
        relationship: Number.isFinite(Number(stored.relationship)) ? Number(stored.relationship) : 50,
        memory: typeof stored.memory === 'string' ? stored.memory : '',
        memorySummary: normalizeMemory(stored.memorySummary, stored.memory),
        usage: normalizeUsage(stored.usage),
        statusBar: normalizeStatusBar(stored.statusBar),
    };
}

async function saveChatMeta(patch) {
    const context = getContext();
    if (!context?.chatMetadata) return;
    context.chatMetadata[MODULE_NAME] = { ...getChatMeta(context), ...patch };
    await context.saveMetadata();
    applyMemoryInjection();
    refreshDetail();
}

function numberText(value) {
    return Number(value || 0).toLocaleString();
}

async function persistUsage({ chatUsage, globalUsage }) {
    const context = getContext();
    if (chatUsage && context?.chatMetadata) {
        context.chatMetadata[MODULE_NAME] = { ...getChatMeta(context), usage: normalizeUsage(chatUsage) };
        await context.saveMetadata();
    }
    if (globalUsage) {
        getSettings().usageTotals = normalizeUsage(globalUsage);
        context?.saveSettingsDebounced?.();
    }
    if (isOpen) refreshDetail();
}

async function recordUserMessage() {
    const context = getContext();
    if (!context?.chatMetadata) return;
    const chatUsage = getChatMeta(context).usage;
    const globalUsage = getSettings().usageTotals;
    chatUsage.userMessages += 1;
    globalUsage.userMessages += 1;
    await persistUsage({ chatUsage, globalUsage });
}

async function recordApiUsage(usage, requestType) {
    const context = getContext();
    if (!context?.chatMetadata) return;
    const chatUsage = getChatMeta(context).usage;
    const globalUsage = getSettings().usageTotals;
    const available = Boolean(usage);
    chatUsage.last = {
        available,
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        total: usage?.total ?? 0,
        type: requestType || currentGeneration.type || 'normal',
        at: Date.now(),
    };
    if (available) {
        chatUsage.input += usage.input;
        chatUsage.output += usage.output;
        chatUsage.total += usage.total;
        globalUsage.input += usage.input;
        globalUsage.output += usage.output;
        globalUsage.total += usage.total;
        globalUsage.last = { ...chatUsage.last };
    }
    await persistUsage({ chatUsage, globalUsage });
}

function parseActualUsage(text) {
    const roots = [];
    try { roots.push(JSON.parse(text)); } catch { /* may be SSE */ }
    for (const line of String(text).split(/\r?\n/)) {
        const value = line.trim();
        if (!value.startsWith('data:')) continue;
        const payload = value.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { roots.push(JSON.parse(payload)); } catch { /* ignore incomplete events */ }
    }
    let input = -1;
    let output = -1;
    let total = -1;
    const visit = (value, seen = new WeakSet()) => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        const usage = value.usage && typeof value.usage === 'object' ? value.usage : null;
        const google = value.usageMetadata && typeof value.usageMetadata === 'object' ? value.usageMetadata : null;
        const read = (source, keys) => {
            for (const key of keys) {
                if (Number.isFinite(Number(source?.[key]))) return Math.max(0, Number(source[key]));
            }
            return -1;
        };
        if (usage) {
            input = Math.max(input, read(usage, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']));
            output = Math.max(output, read(usage, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']));
            total = Math.max(total, read(usage, ['total_tokens', 'totalTokens']));
        }
        if (google) {
            input = Math.max(input, read(google, ['promptTokenCount']));
            output = Math.max(output, read(google, ['candidatesTokenCount']));
            total = Math.max(total, read(google, ['totalTokenCount']));
        }
        for (const child of Object.values(value)) visit(child, seen);
    };
    roots.forEach((root) => visit(root));
    if (input < 0 && output < 0 && total < 0) return null;
    input = Math.max(0, input);
    output = Math.max(0, output);
    total = total >= 0 ? total : input + output;
    return { input, output, total };
}

function installUsageCapture() {
    if (nativeFetch || typeof globalThis.fetch !== 'function') return;
    nativeFetch = globalThis.fetch.bind(globalThis);
    fetchWrapper = async (...args) => {
        const response = await nativeFetch(...args);
        try {
            const rawUrl = typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0]?.url;
            const path = new URL(rawUrl, location.href).pathname;
            if (GENERATION_ENDPOINTS.has(path)) {
                const clone = response.clone();
                const requestType = currentGeneration.type;
                clone.text().then((body) => recordApiUsage(parseActualUsage(body), requestType)).catch(() => recordApiUsage(null, requestType));
            }
        } catch (error) {
            console.debug('[墨藍藝廊] 無法讀取 API usage', error);
        }
        return response;
    };
    globalThis.fetch = fetchWrapper;
}

function restoreUsageCapture() {
    if (nativeFetch && globalThis.fetch === fetchWrapper) globalThis.fetch = nativeFetch;
    nativeFetch = null;
    fetchWrapper = null;
}

function getWorldInfoApi() {
    worldInfoModulePromise ||= import('/scripts/world-info.js');
    return worldInfoModulePromise;
}

function getScriptApi() {
    scriptModulePromise ||= import('/script.js');
    return scriptModulePromise;
}

function getGroupApi() {
    groupModulePromise ||= import('/scripts/group-chats.js');
    return groupModulePromise;
}

function getPersonaApi() {
    personaModulePromise ||= import('/scripts/personas.js');
    return personaModulePromise;
}

function playerAvatarUrl(avatarId, cacheBust = '') {
    if (!avatarId) return '';
    const suffix = cacheBust ? '?t=' + encodeURIComponent(cacheBust) : '';
    return '/User%20Avatars/' + encodeURIComponent(String(avatarId)) + suffix;
}

async function getPlayerProfiles() {
    const context = getContext();
    const api = await getPersonaApi();
    const avatars = await api.getUserAvatars(false).catch(() => []);
    const settings = context?.powerUserSettings || {};
    const names = settings.personas || {};
    const descriptions = settings.persona_descriptions || {};
    return (Array.isArray(avatars) ? avatars : []).map((avatarId) => {
        const descriptor = descriptions[avatarId] || {};
        return {
            avatarId,
            name: String(names[avatarId] || '[未命名玩家]'),
            title: String(descriptor.title || ''),
            description: String(descriptor.description || ''),
            position: Number.isFinite(Number(descriptor.position)) ? Number(descriptor.position) : 0,
            depth: Number.isFinite(Number(descriptor.depth)) ? Number(descriptor.depth) : 2,
            role: Number.isFinite(Number(descriptor.role)) ? Number(descriptor.role) : 0,
            lorebook: String(descriptor.lorebook || ''),
            connections: Array.isArray(descriptor.connections) ? descriptor.connections : [],
            active: api.user_avatar === avatarId,
            chatLocked: context?.chatMetadata?.persona === avatarId,
        };
    }).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh-Hant'));
}

async function uploadPlayerAvatar(file, overwriteName = '') {
    const api = await getScriptApi();
    let avatarFile = file;
    if (!(avatarFile instanceof File)) {
        const response = await fetch('/img/user-default.png');
        if (!response.ok) throw new Error('Default avatar unavailable');
        const blob = await response.blob();
        avatarFile = new File([blob], 'player-avatar.png', { type: blob.type || 'image/png' });
    }
    const formData = new FormData();
    formData.append('avatar', avatarFile);
    if (overwriteName) formData.append('overwrite_name', overwriteName);
    const response = await fetch('/api/avatars/upload', {
        method: 'POST',
        headers: api.getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
        body: formData,
    });
    if (!response.ok) throw new Error('Avatar upload failed: ' + response.status);
    const result = await response.json();
    return String(result?.path || overwriteName || '');
}

async function savePlayerProfile(avatarId, values, avatarFile) {
    const context = getContext();
    const personaApi = await getPersonaApi();
    const scriptApi = await getScriptApi();
    const settings = context.powerUserSettings;
    settings.personas ||= {};
    settings.persona_descriptions ||= {};
    const editing = Boolean(avatarId && settings.personas[avatarId]);
    let finalAvatarId = avatarId;
    if (!editing) finalAvatarId = await uploadPlayerAvatar(avatarFile);
    else if (avatarFile instanceof File && avatarFile.size) await uploadPlayerAvatar(avatarFile, finalAvatarId);
    if (!finalAvatarId) throw new Error('Avatar id unavailable');

    const previous = settings.persona_descriptions[finalAvatarId] || {};
    const descriptor = {
        ...previous,
        description: values.description,
        title: values.title,
        position: Number.isFinite(Number(previous.position)) ? Number(previous.position) : 0,
        depth: Number.isFinite(Number(previous.depth)) ? Number(previous.depth) : 2,
        role: Number.isFinite(Number(previous.role)) ? Number(previous.role) : 0,
        lorebook: String(previous.lorebook || ''),
        connections: Array.isArray(previous.connections) ? previous.connections : [],
    };

    if (!editing) {
        await personaApi.initPersona(finalAvatarId, values.name, values.description, values.title, {
            position: descriptor.position,
            depth: descriptor.depth,
            role: descriptor.role,
            lorebook: descriptor.lorebook,
        });
        settings.persona_descriptions[finalAvatarId] = descriptor;
    } else {
        settings.personas[finalAvatarId] = values.name;
        settings.persona_descriptions[finalAvatarId] = descriptor;
        context.saveSettingsDebounced();
        if (context.eventTypes.PERSONA_UPDATED) {
            await context.eventSource.emit(context.eventTypes.PERSONA_UPDATED, finalAvatarId);
        }
    }

    if (personaApi.user_avatar === finalAvatarId) {
        settings.persona_description = descriptor.description;
        settings.persona_description_position = descriptor.position;
        settings.persona_description_depth = descriptor.depth;
        settings.persona_description_role = descriptor.role;
        settings.persona_description_lorebook = descriptor.lorebook;
        scriptApi.setUserName(values.name, { toastPersonaNameChange: false });
        personaApi.setPersonaDescription();
    }
    await personaApi.getUserAvatars(true, finalAvatarId);
    return finalAvatarId;
}

async function selectPlayerProfile(avatarId) {
    const context = getContext();
    const api = await getPersonaApi();
    const settings = context.powerUserSettings;
    if (!settings?.personas?.[avatarId]) throw new Error('Persona not found');
    await api.setUserAvatar(avatarId, { toastPersonaNameChange: false, navigateToCurrent: true });
    if (context.chatId) {
        context.chatMetadata.persona = avatarId;
        await context.saveMetadata();
    }
    context.saveSettingsDebounced();
    refreshAll();
}

async function deletePlayerProfile(avatarId) {
    const context = getContext();
    const personaApi = await getPersonaApi();
    const scriptApi = await getScriptApi();
    const settings = context.powerUserSettings;
    const name = String(settings?.personas?.[avatarId] || '未命名玩家');
    const response = await fetch('/api/avatars/delete', {
        method: 'POST',
        headers: scriptApi.getRequestHeaders(),
        body: JSON.stringify({ avatar: avatarId }),
    });
    if (!response.ok && response.status !== 404) throw new Error('Persona delete failed: ' + response.status);
    delete settings.personas?.[avatarId];
    delete settings.persona_descriptions?.[avatarId];
    if (settings.default_persona === avatarId) settings.default_persona = null;
    if (context.chatMetadata?.persona === avatarId) {
        delete context.chatMetadata.persona;
        await context.saveMetadata();
    }
    context.saveSettingsDebounced();
    if (context.eventTypes.PERSONA_DELETED) {
        await context.eventSource.emit(context.eventTypes.PERSONA_DELETED, { avatarId, name });
    }
    if (personaApi.user_avatar === avatarId) {
        const remaining = await personaApi.getUserAvatars(false).catch(() => []);
        const next = remaining.find((item) => settings.personas?.[item]);
        if (next) await personaApi.setUserAvatar(next, { toastPersonaNameChange: false });
        else {
            personaApi.initUserAvatar('');
            settings.persona_description = '';
            settings.persona_description_lorebook = '';
            scriptApi.setUserName('User', { toastPersonaNameChange: false });
        }
    }
    await personaApi.getUserAvatars(true);
}

function permitManualGeneration(milliseconds = 60000) {
    blockedGenerationUntil = 0;
    manualGenerationPermitUntil = Date.now() + milliseconds;
}

function disableGroupAutoMode() {
    const checkbox = document.getElementById('rm_group_automode');
    if (checkbox instanceof HTMLInputElement && checkbox.checked) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

function enterInspectionMode({ stopActive = false, guardMilliseconds = 8000 } = {}) {
    manualGenerationPermitUntil = 0;
    blockedGenerationUntil = Math.max(blockedGenerationUntil, Date.now() + guardMilliseconds);
    groupReplyBatchActive = false;
    groupDraftOverLimit = false;
    groupReplyCounts.clear();
    isBusy = false;
    disableGroupAutoMode();
    if (stopActive) getContext()?.stopGeneration?.();
    if (isOpen) renderComposer();
}

function applyMemoryInjection() {
    const context = getContext();
    if (!context?.setExtensionPrompt) return;
    const memory = getChatMeta(context).memorySummary;
    const value = memory.content.trim()
        ? '以下是使用者確認過、供後續對話參考的長期記憶。若與最新對話衝突，以最新對話為準。\n\n' + memory.content.trim()
        : '';
    context.setExtensionPrompt('molan_gallery_memory_summary', value, 0, 0, false, 0);
    context.setExtensionPrompt('molan_gallery_creator_widget', '', 0, 0, false, 0);
    const statusBar = getChatMeta(context).statusBar;
    const statusValue = statusBar?.enabled ? buildStatusBarPrompt(statusBar) : '';
    context.setExtensionPrompt('molan_gallery_statusbar', statusValue, 0, 0, false, 0);
    const entity = currentEntity(context);
    const groupValue = entity?.type === 'group'
        ? '目前是多人群組聊天。每位角色只依自己的角色卡、世界書、後台提示、已知資訊與聊天上下文回覆，維持各自口吻、立場、關係及知識邊界。像真人群聊一樣自然判斷是否需要發言，不必讓所有成員每輪都出聲，不要重複其他角色已說過的內容，也不要替使用者說話、決定動作或描述未表達的內心。單一角色在同一輪玩家訊息後最多回覆 2 次。'
        : '';
    context.setExtensionPrompt('molan_gallery_group_chat_rules', groupValue, 0, 0, false, 0);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(value, fallback = 'export') {
    const cleaned = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').trim();
    return cleaned || fallback;
}

async function fetchChatListForEntry(context, type, entity, id) {
    const response = await fetch('/api/chats/search', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            query: '',
            avatar_url: type === 'character' ? entity.avatar : null,
            group_id: type === 'group' ? entity.id : null,
        }),
    });
    if (!response.ok) return [];
    const rows = await response.json();
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
        type,
        entityId: id,
        entity,
        chatId: String(row.file_name || '').replace(/\.jsonl$/i, ''),
        name: entity.name || entity.data?.name || (type === 'group' ? '未命名群組' : '未命名角色'),
        preview: row.preview_message || '尚無預覽',
        messageCount: Number(row.message_count) || 0,
        lastMes: row.last_mes || '',
    })).filter((row) => row.chatId);
}

async function loadChatEntries() {
    const context = getContext();
    if (!context) return;
    const requestId = ++chatListRequest;
    chatListLoading = true;
    renderEntityList();
    try {
        const tasks = [
            ...context.characters.map((character, id) => fetchChatListForEntry(context, 'character', character, id)),
            ...context.groups.map((group) => fetchChatListForEntry(context, 'group', group, group.id)),
        ];
        const rows = (await Promise.all(tasks)).flat();
        if (requestId !== chatListRequest) return;
        chatEntries = rows.sort((a, b) => String(b.lastMes).localeCompare(String(a.lastMes)));
    } catch (error) {
        console.error('[墨藍藝廊] 讀取聊天室列表失敗', error);
        if (requestId === chatListRequest) chatEntries = [];
    } finally {
        if (requestId === chatListRequest) {
            chatListLoading = false;
            renderEntityList();
        }
    }
}

async function ensureGroupChatStartsBlank(context, groupId, chatId) {
    const id = String(chatId || '').trim();
    if (!id) throw new Error('Group chat id is required');
    const existingResponse = await fetch('/api/chats/group/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ id }),
    });
    if (!existingResponse.ok && existingResponse.status !== 404) {
        throw new Error('Group chat lookup failed: ' + existingResponse.status);
    }
    if (existingResponse.ok) {
        const existing = await existingResponse.json();
        if (!Array.isArray(existing)) throw new Error('Invalid group chat response');
        if (existing.length) return false;
    }
    const integrity = globalThis.crypto?.randomUUID?.()
        || 'molan-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const chatHeader = {
        chat_metadata: {
            integrity,
            molan_gallery_blank_group: true,
            molan_gallery_group_id: String(groupId || ''),
        },
        user_name: 'unused',
        character_name: 'unused',
    };
    const saveResponse = await fetch('/api/chats/group/save', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ id, chat: [chatHeader], force: false }),
    });
    if (!saveResponse.ok) throw new Error('Blank group chat save failed: ' + saveResponse.status);
    return true;
}

async function selectChatEntry(type, entityId, chatId) {
    const context = getContext();
    if (!context) return;
    enterInspectionMode({ stopActive: true });
    try {
        if (type === 'group') {
            const api = await getGroupApi();
            await ensureGroupChatStartsBlank(context, entityId, chatId);
            await api.openGroupChat(entityId, chatId);
        } else {
            if (String(context.characterId) !== String(entityId)) {
                await context.selectCharacterById(Number(entityId), { switchMenu: false });
            }
            const nextContext = getContext();
            if (String(nextContext.chatId || '') !== String(chatId)) {
                const api = await getScriptApi();
                await api.openCharacterChat(chatId);
            }
        }
        enterInspectionMode();
        applyMemoryInjection();
        sidebarOpen = false;
        refreshAll();
    } catch (error) {
        console.error('[墨藍藝廊] 開啟聊天室失敗', error);
        notify('無法開啟聊天室，請稍後再試。', 'error');
    }
}

function createRoot() {
    if (document.getElementById(ROOT_ID)) return;
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.dataset.molanGalleryVersion = BUILD_VERSION;
    root.hidden = true;
    root.innerHTML = [
        '<aside class="mol-rail" aria-label="主要導覽">',
        '  <button class="mol-brand" data-action="close" title="關閉墨藍藝廊"><span>T</span></button>',
        '  <nav>',
        '    <button class="mol-rail-button active" data-action="show-chats" title="對話"><i class="fa-solid fa-pen-nib"></i></button>',
        '    <button class="mol-rail-button" data-action="character-overview" title="角色總覽"><i class="fa-solid fa-address-card"></i></button>',
        '    <button class="mol-rail-button" data-action="player-profiles" title="玩家設定檔"><i class="fa-solid fa-user-pen"></i></button>',
        '    <button class="mol-rail-button" data-action="world-info" title="世界書"><i class="fa-solid fa-book-atlas"></i></button>',
        '    <button class="mol-rail-button" data-action="statusbar-manager" title="互動狀態欄"><i class="fa-solid fa-table-list"></i></button>',
        '    <button class="mol-rail-button" data-action="continue" title="續寫"><i class="fa-solid fa-wand-magic-sparkles"></i></button>',
        '  </nav>',
        '  <div class="mol-rail-bottom"><button class="mol-profile-dot" data-action="player-profiles" title="玩家設定檔">U</button><button class="mol-rail-settings" data-action="user-settings" title="藝廊介面設定"><i class="fa-solid fa-gear"></i></button></div>',
        '</aside>',
        '<aside class="mol-chat-list" aria-label="聊天室列表">',
        '  <div class="mol-list-heading"><div><p class="mol-eyebrow">COLLECTION</p><h1>對話</h1></div><button class="mol-icon-button" data-action="new-chat" title="建立新對話"><i class="fa-solid fa-plus"></i></button></div>',
        '  <label class="mol-search"><i class="fa-solid fa-magnifying-glass"></i><input id="mol-search-input" type="search" placeholder="搜尋聊天室、角色…" aria-label="搜尋聊天室與角色"></label>',
        '  <div class="mol-filters">',
        '    <button data-filter="all" class="active">全部</button>',
        '    <button data-filter="group">群組</button>',
        '  </div>',
        '  <button id="mol-create-group-button" class="mol-create-group-button" data-action="create-group" hidden><i class="fa-solid fa-user-group"></i><span>建立群組</span><small>指定 1–5 張角色卡</small></button>',
        '  <div id="mol-entity-list" class="mol-entity-list"></div>',
        '  <div class="mol-list-note"><span>ISSUE 01</span><p>每一次對話，都是尚未裝框的作品。</p></div>',
        '</aside>',
        '<section class="mol-conversation">',
        '  <header class="mol-header">',
        '    <div class="mol-title"><button class="mol-mobile-menu" data-action="mobile-menu" title="顯示對話列表"><i class="fa-solid fa-bars"></i></button><div id="mol-header-avatar" class="mol-avatar small"></div><div><strong id="mol-current-name">尚未選擇角色</strong><span id="mol-current-role">請從左側選擇</span></div></div>',
        '    <div class="mol-header-actions">',
        '      <button class="mol-text-button" data-action="focus"><i class="fa-regular fa-eye"></i><span>專注</span></button>',
        '      <button class="mol-icon-button" data-action="more" title="對話選項"><i class="fa-solid fa-ellipsis"></i></button>',
        '    </div>',
        '  </header>',
        '  <div class="mol-chapter"><span>LIVE CHAT</span><i></i><span id="mol-chat-name">尚未開啟對話</span></div>',
        '  <div id="mol-messages" class="mol-messages" aria-live="polite"></div>',
        '  <div id="mol-tavern-helper-statusbar-slot" class="mol-tavern-helper-statusbar-slot" aria-label="酒館助手互動狀態欄" hidden></div>',
        '  <div class="mol-composer-wrap">',
        '    <form id="mol-composer" class="mol-composer">',
        '      <button type="button" data-action="attach" class="mol-add-button" title="加入附件"><i class="fa-solid fa-plus"></i></button>',
        '      <textarea id="mol-draft" rows="1" placeholder="寫下你的回覆…" aria-label="輸入訊息"></textarea>',
        '      <button type="submit" class="mol-send-button" title="送出訊息"><i class="fa-solid fa-paper-plane"></i></button>',
        '    </form>',
        '    <div class="mol-composer-meta"><span id="mol-attachment">Enter 傳送 · Shift + Enter 換行</span><span id="mol-token-count">0 / --</span></div>',
        '  </div>',
        '</section>',
        '<aside class="mol-detail" aria-label="角色資訊">',
        '  <div id="mol-art-card" class="mol-art-card"></div>',
        '  <div class="mol-profile-heading"><div><p class="mol-eyebrow">CHARACTER PROFILE</p><h2 id="mol-profile-name">—</h2></div><span id="mol-status" class="mol-status">OFFLINE</span></div>',
        '  <p id="mol-profile-note" class="mol-profile-note">選擇角色後顯示資料。</p>',
        '  <div class="mol-stat-row-wrap"><button class="mol-stat-row" data-action="relationship" title="調整關係值"><span>關係</span><span class="mol-stat-bar"><i id="mol-relationship-bar"></i></span><strong id="mol-relationship">50</strong></button><button class="mol-help-button" data-action="relationship-help" title="關係值功能說明" aria-label="關係值功能說明">?</button></div>',
        '  <div class="mol-context-list">',
        '    <button id="mol-group-members-row" data-action="group-members" hidden><span class="mol-context-icon"><i class="fa-solid fa-user-group"></i></span><span><strong>群組成員</strong><small id="mol-group-members-summary">管理可加入群聊的角色</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '    <button data-action="player-profiles"><span class="mol-context-icon"><i class="fa-solid fa-user-pen"></i></span><span><strong>玩家設定檔</strong><small id="mol-player-summary">新增、修改、刪除與切換</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '    <button data-action="world-info"><span class="mol-context-icon"><i class="fa-solid fa-book-atlas"></i></span><span><strong>世界書</strong><small id="mol-world-count">在藝廊內查看</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '    <button data-action="memory-summary"><span class="mol-context-icon"><i class="fa-solid fa-leaf"></i></span><span><strong>記憶自動摘要</strong><small id="mol-memory-summary">尚未建立摘要</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '    <button data-action="statusbar-manager"><span class="mol-context-icon"><i class="fa-solid fa-table-list"></i></span><span><strong>互動狀態欄</strong><small id="mol-statusbar-summary">匯入酒館助手狀態欄 JSON</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '    <button data-action="generation-settings"><span class="mol-context-icon"><i class="fa-solid fa-sliders"></i></span><span><strong>生成中心</strong><small>模型、狀態與生成操作</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '    <button data-action="usage-stats"><span class="mol-context-icon"><i class="fa-solid fa-chart-simple"></i></span><span><strong>API 用量</strong><small id="mol-usage-summary">等待實際回傳</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '  </div>',
        '  <button class="mol-model-note" data-action="generation-settings" title="在藝廊內查看生成資訊"><span>MODEL / API</span><strong id="mol-model-name">—</strong><small id="mol-stream-state">Ready</small></button>',
        '</aside>',
        '<div id="mol-dialog" class="mol-dialog-layer" hidden></div>',
    ].join('');
    document.body.append(root);

    root.addEventListener('click', handleRootClick);
    root.querySelector('#mol-search-input').addEventListener('input', (event) => {
        searchQuery = event.currentTarget.value.trim().toLocaleLowerCase();
        renderEntityList();
    });
    root.querySelector('#mol-composer').addEventListener('submit', handleComposerSubmit);
    root.querySelector('#mol-draft').addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
        }
    });
}

function installLauncher() {
    if (document.getElementById(LAUNCHER_ID)) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const container = document.createElement('div');
    container.id = LAUNCHER_ID;
    container.className = 'extension_container';
    container.innerHTML = '<div class="list-group-item flex-container flexGap5 interactable" role="button" tabindex="0"><div class="fa-solid fa-palette extensionsMenuExtensionButton"></div><span>墨藍藝廊</span></div>';
    const button = container.firstElementChild;
    button.addEventListener('click', () => setOpen(true));
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') setOpen(true);
    });
    menu.prepend(container);
}

function installSettings() {
    if (document.getElementById(SETTINGS_ID)) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const block = document.createElement('div');
    block.id = SETTINGS_ID;
    block.className = 'extension_container';
    block.innerHTML = [
        '<div class="inline-drawer">',
        '<div class="inline-drawer-toggle inline-drawer-header"><b>墨藍藝廊聊天介面</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>',
        '<div class="inline-drawer-content">',
        '<label class="checkbox_label"><input id="mol-auto-open" type="checkbox"><span>啟動 SillyTavern 時自動開啟</span></label>',
        '<label class="checkbox_label"><input id="mol-compact-messages" type="checkbox"><span>緊湊訊息間距</span></label>',
        '<label>介面字體 <output id="mol-interface-font-output"></output><input id="mol-interface-font" type="range" min="11" max="22" step="1"></label>',
        '<label>聊天室訊息字體 <output id="mol-message-font-output"></output><input id="mol-message-font" type="range" min="12" max="32" step="1"></label>',
        '<button id="mol-open-settings" class="menu_button">開啟墨藍藝廊</button>',
        '<small>快捷鍵：Ctrl/Cmd + Shift + M</small>',
        '</div></div>',
    ].join('');
    host.append(block);
    const settings = getSettings();
    block.querySelector('#mol-auto-open').checked = Boolean(settings.autoOpen);
    block.querySelector('#mol-compact-messages').checked = Boolean(settings.compactMessages);
    const interfaceFont = block.querySelector('#mol-interface-font');
    const messageFont = block.querySelector('#mol-message-font');
    const interfaceOutput = block.querySelector('#mol-interface-font-output');
    const messageOutput = block.querySelector('#mol-message-font-output');
    interfaceFont.value = String(settings.interfaceFontSize);
    messageFont.value = String(settings.messageFontSize);
    interfaceOutput.value = settings.interfaceFontSize + ' px';
    messageOutput.value = settings.messageFontSize + ' px';
    block.querySelector('#mol-auto-open').addEventListener('change', (event) => {
        settings.autoOpen = event.currentTarget.checked;
        getContext().saveSettingsDebounced();
    });
    block.querySelector('#mol-compact-messages').addEventListener('change', (event) => {
        settings.compactMessages = event.currentTarget.checked;
        document.getElementById(ROOT_ID)?.classList.toggle('compact-messages', settings.compactMessages);
        getContext().saveSettingsDebounced();
    });
    interfaceFont.addEventListener('input', (event) => {
        settings.interfaceFontSize = clampFontSize(event.currentTarget.value, 11, 22, DEFAULT_SETTINGS.interfaceFontSize);
        interfaceOutput.value = settings.interfaceFontSize + ' px';
        applyTypographySettings();
        getContext().saveSettingsDebounced();
    });
    messageFont.addEventListener('input', (event) => {
        settings.messageFontSize = clampFontSize(event.currentTarget.value, 12, 32, DEFAULT_SETTINGS.messageFontSize);
        messageOutput.value = settings.messageFontSize + ' px';
        applyTypographySettings();
        getContext().saveSettingsDebounced();
    });
    block.querySelector('#mol-open-settings').addEventListener('click', () => setOpen(true));
}

function setOpen(value) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    isOpen = Boolean(value);
    root.hidden = !isOpen;
    document.body.classList.toggle('mol-gallery-open', isOpen);
    if (isOpen) {
        syncDialogViewport();
        enterInspectionMode({ stopActive: true });
        applyMemoryInjection();
        root.classList.toggle('compact-messages', Boolean(getSettings().compactMessages));
        applyTypographySettings();
        startTavernHelperStatusBarBridge();
        refreshAll();
        loadChatEntries();
        setTimeout(() => root.querySelector('#mol-draft')?.focus(), 0);
    } else {
        stopTavernHelperStatusBarBridge();
        closeDialog();
    }
}

function getEntities() {
    return chatEntries
        .filter((entry) => activeFilter === 'all' || (activeFilter === 'group' && entry.type === 'group'))
        .filter((entry) => !searchQuery || (entry.name + ' ' + entry.chatId + ' ' + entry.preview).toLocaleLowerCase().includes(searchQuery));
}

function renderEntityList() {
    const context = getContext();
    const host = document.getElementById('mol-entity-list');
    if (!context || !host) return;
    const current = currentEntity(context);
    const entries = getEntities();
    if (chatListLoading && !entries.length) {
        host.innerHTML = '<div class="mol-empty"><i class="fa-solid fa-spinner fa-spin"></i> 正在讀取聊天室…</div>';
        return;
    }
    if (!entries.length) {
        host.innerHTML = '<div class="mol-empty">沒有符合條件的聊天室。建立並儲存訊息後，聊天室會出現在這裡。</div>';
        return;
    }
    host.innerHTML = entries.map((entry) => {
        const entity = { type: entry.type, item: entry.entity, id: entry.entityId };
        const url = avatarUrl(entity, context);
        const active = current && current.type === entry.type && String(current.id) === String(entry.entityId) && String(context.chatId) === String(entry.chatId);
        const avatar = url
            ? '<img src="' + escapeHtml(url) + '" alt="">'
            : '<span>' + escapeHtml(initials(entry.name)) + '</span>';
        return [
            '<article class="mol-chat-card' + (active ? ' active' : '') + '">',
            '<button class="mol-chat-open" data-chat-type="' + entry.type + '" data-entity-id="' + escapeHtml(entry.entityId) + '" data-chat-id="' + escapeHtml(entry.chatId) + '">',
            '<span class="mol-avatar">' + avatar + '</span><span class="mol-chat-copy"><span class="mol-chat-line"><strong>' + escapeHtml(entry.name) + '</strong></span>',
            '<span class="mol-role">' + (entry.type === 'group' ? 'GROUP' : 'CHARACTER') + ' · ' + escapeHtml(entry.chatId) + '</span>',
            '<span class="mol-preview">' + escapeHtml(entry.preview) + '</span></span></button>',
            '<div class="mol-chat-card-actions"><span>' + numberText(entry.messageCount) + ' 則</span><button data-action="export-chat-entry" data-chat-type="' + entry.type + '" data-entity-id="' + escapeHtml(entry.entityId) + '" data-chat-id="' + escapeHtml(entry.chatId) + '" title="匯出 TXT"><i class="fa-solid fa-file-arrow-down"></i></button><button data-action="delete-chat-entry" data-chat-type="' + entry.type + '" data-entity-id="' + escapeHtml(entry.entityId) + '" data-chat-id="' + escapeHtml(entry.chatId) + '" title="刪除聊天室"><i class="fa-solid fa-trash"></i></button></div>',
            '</article>',
        ].join('');
    }).join('');
}

function renderHeader() {
    const context = getContext();
    const entity = currentEntity(context);
    const name = entity?.item?.name || entity?.item?.data?.name || '尚未選擇角色';
    const role = entity ? entityRole(entity) : '請從左側選擇';
    const avatar = document.getElementById('mol-header-avatar');
    document.getElementById('mol-current-name').textContent = name;
    document.getElementById('mol-current-role').textContent = role + (entity ? ' · ' + String(context.onlineStatus || 'Ready') : '');
    document.getElementById('mol-chat-name').textContent = context.chatId || '尚未開啟對話';
    if (avatar) {
        const url = avatarUrl(entity, context);
        avatar.innerHTML = url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span>' + escapeHtml(initials(name)) + '</span>';
    }
    document.getElementById(ROOT_ID)?.classList.toggle('focus-mode', focusMode);
    document.getElementById(ROOT_ID)?.classList.toggle('mobile-sidebar-open', sidebarOpen);
    const focusButton = document.querySelector('#' + ROOT_ID + ' [data-action="focus"]');
    focusButton?.classList.toggle('active', focusMode);
    renderPlayerProfileShortcut();
}

async function renderPlayerProfileShortcut() {
    const context = getContext();
    const dot = document.querySelector('#' + ROOT_ID + ' .mol-profile-dot');
    const summary = document.getElementById('mol-player-summary');
    if (!context || !dot) return;
    try {
        const api = await getPersonaApi();
        const avatarId = api.user_avatar || context.chatMetadata?.persona || '';
        const name = String(context.powerUserSettings?.personas?.[avatarId] || context.name1 || 'User');
        dot.textContent = initials(name);
        dot.title = '玩家設定檔：' + name;
        dot.style.backgroundImage = avatarId ? 'url("' + playerAvatarUrl(avatarId) + '")' : '';
        dot.classList.toggle('has-image', Boolean(avatarId));
        if (summary) summary.textContent = name + (context.chatMetadata?.persona === avatarId ? ' · 已綁定目前聊天室' : ' · 目前使用中');
    } catch {
        dot.textContent = initials(context.name1 || 'User');
        if (summary) summary.textContent = String(context.name1 || 'User');
    }
}

function formattedMessage(message, index, context) {
    const text = message?.extra?.display_text ?? message?.mes ?? '';
    try {
        const html = context.messageFormatting(text, message.name, message.is_system, message.is_user, index, {}, false);
        return globalThis.SillyTavern.libs.DOMPurify.sanitize(html);
    } catch {
        return escapeHtml(text).replaceAll('\n', '<br>');
    }
}

function activeStatusBar(meta = getChatMeta()) {
    return meta.statusBar?.enabled && !meta.statusBar.state.hidden ? meta.statusBar : null;
}

function statusBarAffinityBadge(statusBar, value) {
    return statusBar.config.affinityBadges.find((item) => value < item.below)?.label || '';
}

function renderStatusBarFields(statusBar, mode) {
    const selected = mode.fields.length ? statusBar.config.fields.filter((item) => mode.fields.includes(item.id)) : statusBar.config.fields;
    const fields = selected.map((item) => {
        const value = statusBar.state.fields[item.id];
        const text = Array.isArray(value) ? (value.length ? value.join('、') : '—') : String(value ?? '—');
        return '<div class="mol-statusbar-card' + (item.type === 'list' || item.id === 'currentSituation' ? ' wide' : '') + '"><span>' + escapeHtml(item.label) + '</span><strong>' + escapeHtml(text) + '</strong></div>';
    }).join('');
    const affinities = statusBar.config.affinities.map((item) => {
        const value = Math.max(0, Math.min(item.max, Number(statusBar.state.affinities[item.id]) || 0));
        const percent = (value / item.max) * 100;
        return '<div class="mol-statusbar-affinity"><div><strong>' + escapeHtml(item.name) + '</strong><span>' + escapeHtml(statusBarAffinityBadge(statusBar, value)) + ' · ' + value + '</span></div><i><b style="width:' + percent + '%"></b></i></div>';
    }).join('');
    const memo = statusBar.state.memo ? '<div class="mol-statusbar-memo"><span>備忘錄</span><p>' + escapeHtml(statusBar.state.memo) + '</p></div>' : '';
    return '<div class="mol-statusbar-field-grid">' + fields + '</div>' + (affinities ? '<div class="mol-statusbar-section-title">角色關係</div><div class="mol-statusbar-affinity-grid">' + affinities + '</div>' : '') + memo;
}

function renderStatusBarResources(statusBar, mode) {
    const category = mode.id === 'food' ? 'food' : (mode.id === 'items' ? 'item' : mode.id);
    const resources = statusBar.config.resources.filter((item) => item.category === category);
    if (!resources.length) return '<div class="mol-statusbar-empty">此分類目前沒有資源。</div>';
    return '<div class="mol-statusbar-resource-grid">' + resources.map((item) => {
        const value = Math.max(0, Math.min(item.max, Number(statusBar.state.resources[item.id]) || 0));
        return '<div class="mol-statusbar-resource"><span title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span><strong>' + value + ' / ' + item.max + '</strong><button type="button" data-action="statusbar-consume" data-statusbar-resource="' + escapeHtml(item.id) + '"' + (value <= 0 ? ' disabled' : '') + '>使用</button></div>';
    }).join('') + '</div>';
}

function renderStatusBarMarkup(statusBar = activeStatusBar()) {
    if (!statusBar || isTavernHelperStatusBarBridged()) return '';
    const mode = statusBar.config.modes.find((item) => item.id === statusBar.state.mode) || statusBar.config.modes[0];
    const statusMode = mode.fields.length > 0 || mode.id === 'status';
    const body = statusMode ? renderStatusBarFields(statusBar, mode) : renderStatusBarResources(statusBar, mode);
    const theme = statusBar.config.theme;
    const style = '--sb-bg:' + theme.background + ';--sb-panel:' + theme.panel + ';--sb-soft:' + theme.panelSoft + ';--sb-border:' + theme.border + ';--sb-text:' + theme.text + ';--sb-muted:' + theme.muted + ';--sb-accent:' + theme.accent;
    return [
        '<section class="mol-statusbar' + (statusBar.state.collapsed ? ' collapsed' : '') + '" style="' + style + '">',
        '<header><span class="mol-statusbar-seal">晏</span><div><strong>' + escapeHtml(statusBar.config.title) + '</strong><small>匯入狀態欄 · 本聊天室獨立保存</small></div><button type="button" data-action="statusbar-collapse" title="展開或收合"><i class="fa-solid fa-chevron-up"></i></button><button type="button" data-action="statusbar-manager" title="管理互動狀態欄"><i class="fa-solid fa-gear"></i></button></header>',
        '<nav>' + statusBar.config.modes.map((item) => '<button type="button" data-action="statusbar-mode" data-statusbar-mode="' + escapeHtml(item.id) + '" class="' + (item.id === mode.id ? 'active' : '') + '">' + escapeHtml(item.name) + '</button>').join('') + '</nav>',
        '<div class="mol-statusbar-body">' + body + '</div>',
        '<div class="mol-statusbar-summary">' + escapeHtml(String(statusBar.state.fields.time || '狀態已載入')) + ' · 持有 ' + statusBar.config.resources.filter((item) => Number(statusBar.state.resources[item.id]) > 0).length + ' 種資源</div>',
        '</section>',
    ].join('');
}

function renderStatusBarArea() {
    const slot = document.getElementById(TAVERN_HELPER_STATUSBAR_SLOT_ID);
    if (!slot) return;
    if (isTavernHelperStatusBarBridged()) {
        slot.dataset.statusbarSource = 'tavern-helper';
        slot.hidden = false;
        return;
    }
    const markup = renderStatusBarMarkup();
    if (!markup) {
        if (slot.dataset.statusbarSource === 'internal') slot.replaceChildren();
        delete slot.dataset.statusbarSource;
        slot.hidden = true;
        return;
    }
    if (slot.dataset.statusbarSource !== 'internal' || slot.innerHTML !== markup) {
        slot.innerHTML = markup;
    }
    slot.dataset.statusbarSource = 'internal';
    slot.hidden = false;
}

function renderMessages({ preserveScroll = false } = {}) {
    const context = getContext();
    const host = document.getElementById('mol-messages');
    if (!context || !host) return;
    const wasNearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 120;
    if (!context.chat?.length) {
        host.innerHTML = '<div class="mol-scene"><span>NEW CHAT</span><strong>尚未有訊息</strong><p>從下方輸入框開始這段對話。</p></div>';
        return;
    }
    const entity = currentEntity(context);
    host.innerHTML = [
        '<div class="mol-scene"><span>' + escapeHtml(context.chat.length) + ' MESSAGES</span><strong>' + escapeHtml(context.chatId || '未命名對話') + '</strong><p>' + escapeHtml(entity?.item?.name || 'SillyTavern') + '</p></div>',
        context.chat.map((message, index) => {
            const side = message.is_user ? ' user' : (message.is_system ? ' system' : ' character');
            const isLastCharacter = index === context.chat.length - 1 && !message.is_user && !message.is_system;
            return [
                '<article class="mol-message' + side + '" data-message-id="' + index + '">',
                '<div class="mol-message-meta"><strong>' + escapeHtml(message.name || (message.is_user ? context.name1 : context.name2)) + '</strong><span>#' + index + '</span></div>',
                '<div class="mol-message-text">' + formattedMessage(message, index, context) + '</div>',
                '<div class="mol-message-tools">',
                '<button data-action="edit-message" data-message-id="' + index + '">編輯</button>',
                isLastCharacter ? '<button data-action="regenerate">重試</button>' : '',
                '<button data-action="delete-message" data-message-id="' + index + '">刪除</button>',
                '</div></article>',
            ].join('');
        }).join(''),
    ].join('');
    if (!preserveScroll || wasNearBottom) host.scrollTop = host.scrollHeight;
}

function renderComposer() {
    const root = document.getElementById(ROOT_ID);
    const button = root?.querySelector('.mol-send-button');
    const stream = document.getElementById('mol-stream-state');
    if (button) {
        button.title = isBusy ? '停止生成' : '送出訊息';
        button.innerHTML = isBusy ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-paper-plane"></i>';
    }
    if (stream) stream.textContent = isBusy ? 'Generating…' : 'Ready';
    const attachment = document.getElementById('mol-attachment');
    if (attachment) attachment.textContent = attachmentName ? '附件：' + attachmentName : 'Enter 傳送 · Shift + Enter 換行';
}

function renderDetail() {
    const context = getContext();
    if (!context) return;
    const entity = currentEntity(context);
    const name = entity?.item?.name || entity?.item?.data?.name || '—';
    const data = entity?.item?.data || {};
    const profile = entity?.type === 'group'
        ? '群組成員：' + (entity.item.members?.length || 0) + ' 人'
        : truncate(data.description || entity?.item?.description || data.personality || '角色卡未填寫簡介。', 180);
    const portrait = portraitImageMarkup(entity, context, name);
    const art = document.getElementById('mol-art-card');
    if (art) {
        art.innerHTML = [
            '<span class="mol-art-index">NO. ' + String(context.chat?.length || 0).padStart(2, '0') + '</span>',
            '<div class="mol-portrait">' + (portrait || '<span>' + escapeHtml(initials(name)) + '</span>') + '<i class="one"></i><i class="two"></i></div>',
            '<p>THE CURATOR<br>OF BLUE HOURS</p>',
        ].join('');
        wireImageFallbacks(art);
    }
    document.getElementById('mol-profile-name').textContent = name;
    document.getElementById('mol-profile-note').textContent = profile;
    const status = document.getElementById('mol-status');
    status.textContent = entity ? 'ACTIVE' : 'IDLE';
    status.classList.toggle('inactive', !entity);
    const meta = getChatMeta(context);
    document.getElementById('mol-relationship').textContent = String(meta.relationship);
    document.getElementById('mol-relationship-bar').style.width = Math.max(0, Math.min(100, meta.relationship)) + '%';
    const groupRow = document.getElementById('mol-group-members-row');
    if (groupRow) groupRow.hidden = entity?.type !== 'group';
    const groupSummary = document.getElementById('mol-group-members-summary');
    if (groupSummary) groupSummary.textContent = entity?.type === 'group'
        ? (entity.item.members?.length || 0) + ' 名角色 · 傳送後依設定主動回覆'
        : '管理可加入群聊的角色';
    document.getElementById('mol-memory-summary').textContent = meta.memorySummary.content
        ? truncate(meta.memorySummary.content, 28)
        : (meta.memorySummary.enabled ? '已啟用，等待摘要' : '尚未建立摘要');
    const statusBarSummary = document.getElementById('mol-statusbar-summary');
    if (statusBarSummary) statusBarSummary.textContent = getTavernHelperStatusBar()
        ? (isTavernHelperStatusBarBridged() ? '酒館助手狀態欄 · 已同步顯示' : '酒館助手狀態欄 · 等待同步')
        : (meta.statusBar ? meta.statusBar.name + (meta.statusBar.enabled ? ' · 已啟用' : ' · 已停用') : '尚未偵測到酒館助手狀態欄');
    let model = context.mainApi || 'Unknown';
    try {
        model = context.getChatCompletionModel?.() || model;
    } catch { /* use API name */ }
    document.getElementById('mol-model-name').textContent = String(model);
    const names = context.getWorldInfoNames?.() || [];
    document.getElementById('mol-world-count').textContent = names.length ? names.length + ' 本世界書可用' : '目前沒有世界書';
    const usage = meta.usage;
    const usageSummary = document.getElementById('mol-usage-summary');
    if (usageSummary) usageSummary.textContent = usage.last?.available
        ? '本次 ' + numberText(usage.last.total) + ' · 本聊天 ' + numberText(usage.total)
        : '尚無供應商實際用量';
}

async function updateTokenCount() {
    const context = getContext();
    const output = document.getElementById('mol-token-count');
    if (!context || !output) return;
    const text = (context.chat || []).map((message) => message.mes || '').join('\n');
    try {
        const count = await context.getTokenCountAsync(text);
        if (document.body.contains(output)) output.textContent = count.toLocaleString() + ' / ' + (context.maxContext || '--');
    } catch {
        output.textContent = (context.chat?.length || 0) + ' 則訊息';
    }
}

function refreshDetail() {
    renderDetail();
    updateTokenCount();
}

function refreshAll() {
    renderEntityList();
    renderHeader();
    renderMessages();
    renderStatusBarArea();
    renderComposer();
    refreshDetail();
    queueTavernHelperStatusBarSync();
}

async function selectEntity(type, id) {
    const context = getContext();
    if (!context) return;
    try {
        enterInspectionMode({ stopActive: true });
        if (type === 'group') {
            const group = context.groups.find((item) => String(item.id) === String(id));
            if (!group?.chat_id) {
                notify('這個群組尚未有可開啟的對話。', 'warning');
                return;
            }
            await ensureGroupChatStartsBlank(context, group.id, group.chat_id);
            await context.openGroupChat(group.id, group.chat_id);
        } else {
            await context.selectCharacterById(Number(id), { switchMenu: false });
        }
        enterInspectionMode();
        applyMemoryInjection();
        sidebarOpen = false;
        refreshAll();
        loadChatEntries();
    } catch (error) {
        console.error('[墨藍藝廊] 切換對話失敗', error);
        notify('無法切換對話，請稍後再試。', 'error');
    }
}

function closeDialog() {
    activeDialogCleanup?.();
    activeDialogCleanup = null;
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    layer.hidden = true;
    layer.innerHTML = '';
}

function openTextDialog({ title, label, value = '', multiline = false, submitText = '儲存', onSubmit }) {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    const field = multiline
        ? '<textarea name="value" rows="7">' + escapeHtml(value) + '</textarea>'
        : '<input name="value" type="text" value="' + escapeHtml(value) + '">';
    layer.innerHTML = '<form class="mol-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog" title="關閉">×</button><p class="mol-eyebrow">EDIT</p><h3>' + escapeHtml(title) + '</h3><label><span>' + escapeHtml(label) + '</span>' + field + '</label><div class="mol-dialog-actions"><button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">' + escapeHtml(submitText) + '</button></div></form>';
    layer.hidden = false;
    const form = layer.querySelector('form');
    const handler = async (event) => {
        event.preventDefault();
        const input = new FormData(form).get('value');
        const shouldClose = await onSubmit(String(input ?? ''));
        if (shouldClose !== false) closeDialog();
    };
    form.addEventListener('submit', handler);
    activeDialogCleanup = () => form.removeEventListener('submit', handler);
    setTimeout(() => form.elements.value?.focus(), 0);
}

function openConfirmDialog(title, message, onConfirm) {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    layer.innerHTML = '<div class="mol-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog" title="關閉">×</button><p class="mol-eyebrow">CONFIRM</p><h3>' + escapeHtml(title) + '</h3><p class="mol-dialog-copy">' + escapeHtml(message) + '</p><div class="mol-dialog-actions"><button data-action="close-dialog">取消</button><button data-action="confirm-dialog" class="primary">確認</button></div></div>';
    layer.hidden = false;
    const confirm = layer.querySelector('[data-action="confirm-dialog"]');
    const handler = async () => {
        const shouldClose = await onConfirm();
        if (shouldClose !== false) closeDialog();
    };
    confirm.addEventListener('click', handler);
    activeDialogCleanup = () => confirm.removeEventListener('click', handler);
}

function openRelationshipDialog() {
    closeDialog();
    const meta = getChatMeta();
    const layer = document.getElementById('mol-dialog');
    layer.innerHTML = '<form class="mol-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">RELATIONSHIP</p><h3>調整關係值</h3><label><span>目前數值：<strong id="mol-range-output">' + meta.relationship + '</strong></span><input name="value" type="range" min="0" max="100" value="' + meta.relationship + '"></label><div class="mol-dialog-actions"><button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary">儲存</button></div></form>';
    layer.hidden = false;
    const form = layer.querySelector('form');
    const range = form.elements.value;
    range.addEventListener('input', () => { layer.querySelector('#mol-range-output').textContent = range.value; });
    const handler = async (event) => {
        event.preventDefault();
        await saveChatMeta({ relationship: Number(range.value) });
        closeDialog();
    };
    form.addEventListener('submit', handler);
    activeDialogCleanup = () => form.removeEventListener('submit', handler);
}

function openRelationshipHelpDialog() {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    layer.innerHTML = [
        '<div class="mol-dialog mol-panel-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">RELATIONSHIP GUIDE</p><h3>關係值功能說明</h3>',
        '<p class="mol-dialog-copy">關係值用來記錄目前聊天室中角色與玩家的互動進度。數值獨立保存在這個聊天室，不會影響同角色的其他對話，也不會改寫角色卡原始設定。</p>',
        '<div class="mol-relationship-guide">',
        '<div><strong>0–19</strong><span>疏離／警戒</span><small>角色仍保持距離，對互動較為防備。</small></div>',
        '<div><strong>20–39</strong><span>生疏／觀察</span><small>開始認識彼此，但信任尚未建立。</small></div>',
        '<div><strong>40–59</strong><span>熟悉／普通信任</span><small>能自然交流，願意分享部分資訊。</small></div>',
        '<div><strong>60–79</strong><span>信任／重視</span><small>關係穩定，角色更重視玩家的反應與選擇。</small></div>',
        '<div><strong>80–100</strong><span>親密／深度羈絆</span><small>代表高度信任或親密關係；實際表現仍以角色卡設定為準。</small></div>',
        '</div><p class="mol-dialog-hint">調整數值後會立即儲存；角色回覆仍會綜合角色卡、世界書、後台提示與聊天上下文，不會只依單一數字決定。</p>',
        '<div class="mol-dialog-actions"><button class="primary" data-action="relationship">調整關係值</button><button data-action="close-dialog">關閉</button></div></div>',
    ].join('');
    layer.hidden = false;
}

async function saveGroupConfiguration(group, patch) {
    const context = getContext();
    const next = { ...group, ...patch };
    next.members = Array.from(new Set((next.members || []).filter(Boolean)));
    if (!next.members.length || next.members.length > MAX_GROUP_MEMBERS) {
        throw new Error('Group members must contain 1–' + MAX_GROUP_MEMBERS + ' characters');
    }
    next.disabled_members = (next.disabled_members || []).filter((avatar) => next.members.includes(avatar));
    const response = await fetch('/api/groups/edit', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(next),
    });
    if (!response.ok) throw new Error('Group update failed: ' + response.status);
    Object.assign(group, next);
    const api = await getGroupApi();
    await api.getGroups?.();
    refreshAll();
}

function groupCharacterChoiceMarkup(context, character, selected) {
    const entityMarkup = { type: 'character', item: character, id: context.characters.indexOf(character) };
    const avatar = portraitImageMarkup(entityMarkup, context, character.name, '');
    return [
        '<label class="mol-group-member-card' + (selected ? ' joined' : '') + '">',
        '<input type="checkbox" name="members" value="' + escapeHtml(character.avatar) + '"' + (selected ? ' checked' : '') + '>',
        '<span class="mol-group-member-avatar">' + (avatar || '<span>' + escapeHtml(initials(character.name)) + '</span>') + '</span>',
        '<span class="mol-group-member-copy"><strong>' + escapeHtml(character.name || '未命名角色') + '</strong><small>' + escapeHtml(truncate(character.data?.personality || character.description || '角色卡', 70)) + '</small><em>' + (selected ? '已選擇' : '點擊加入群聊') + '</em></span>',
        '<span class="mol-group-member-check"><i class="fa-solid fa-check"></i></span>',
        '</label>',
    ].join('');
}

async function createNativeGroup(name, members, activationStrategy) {
    const context = getContext();
    const chatName = 'molan-' + Date.now();
    const payload = {
        name,
        members,
        avatar_url: '',
        allow_self_responses: false,
        hideMutedSprites: false,
        activation_strategy: activationStrategy,
        generation_mode: 0,
        disabled_members: [],
        fav: false,
        chat_id: chatName,
        chats: [chatName],
        auto_mode_delay: 5,
    };
    const response = await fetch('/api/groups/create', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error('Group create failed: ' + response.status);
    const data = await response.json();
    if (!data?.id) throw new Error('Group create response did not include an id');
    await ensureGroupChatStartsBlank(context, data.id, chatName);
    const api = await getGroupApi();
    await api.getGroups?.();
    await context.openGroupChat(String(data.id), chatName);
    enterInspectionMode();
    applyMemoryInjection();
    activeFilter = 'group';
    document.querySelectorAll('#' + ROOT_ID + ' [data-filter]').forEach((button) => button.classList.toggle('active', button.dataset.filter === 'group'));
    const createButton = document.getElementById('mol-create-group-button');
    if (createButton) createButton.hidden = false;
    closeDialog();
    refreshAll();
    await loadChatEntries();
}

async function openGroupEditorDialog(group = null) {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    const memberSet = new Set(group?.members || []);
    const characters = (context.characters || []).filter((character) => character?.avatar).sort((a, b) => {
        const memberOrder = Number(memberSet.has(b.avatar)) - Number(memberSet.has(a.avatar));
        return memberOrder || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant');
    });
    const initialStrategy = Number(group?.activation_strategy ?? 0);
    const strategy = initialStrategy === 2 ? 0 : initialStrategy;
    const cards = characters.length
        ? characters.map((character) => groupCharacterChoiceMarkup(context, character, memberSet.has(character.avatar))).join('')
        : '<div class="mol-profile-empty"><i class="fa-solid fa-user-slash"></i><strong>目前沒有可選擇的角色卡</strong><span>請先建立或匯入角色卡。</span></div>';
    layer.innerHTML = [
        '<form class="mol-dialog mol-panel-dialog mol-wide-dialog mol-group-editor"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">' + (group ? 'EDIT GROUP' : 'NEW GROUP') + '</p><h3>' + (group ? '編輯群組成員' : '建立群組聊天') + '</h3>',
        '<div class="mol-group-editor-fields"><label><span>群組名稱</span><input type="text" name="group_name" required maxlength="80" value="' + escapeHtml(group?.name || '') + '" placeholder="例如：夜間策展組"></label><label><span>回覆方式</span><select name="activation_strategy"><option value="0"' + (strategy === 0 ? ' selected' : '') + '>自然判斷（推薦）</option><option value="1"' + (strategy === 1 ? ' selected' : '') + '>依群組順序</option><option value="3"' + (strategy === 3 ? ' selected' : '') + '>輪替選擇</option></select></label></div>',
        '<div class="mol-group-reply-status"><span><strong>真人感群組回覆</strong><small>角色會讀取自己的角色卡、世界書、後台設定與聊天上下文，維持各自口吻與知識邊界；不強迫所有角色每輪發言。每名角色單輪最多回覆 2 次。</small></span><em><i class="fa-solid fa-circle-check"></i> 原生生成</em></div>',
        '<div class="mol-group-selection-heading"><span>選擇角色卡</span><strong id="mol-group-selection-count">' + memberSet.size + ' / ' + MAX_GROUP_MEMBERS + '</strong></div>',
        '<div class="mol-group-member-list">' + cards + '</div>',
        '<div class="mol-dialog-actions"><button type="button" data-action="close-dialog">取消</button><button type="submit" class="primary"' + (!characters.length ? ' disabled' : '') + '>' + (group ? '儲存群組' : '建立並進入群聊') + '</button></div></form>',
    ].join('');
    layer.hidden = false;
    wireImageFallbacks(layer);
    const form = layer.querySelector('form');
    const checkboxes = Array.from(form.querySelectorAll('input[name="members"]'));
    const counter = form.querySelector('#mol-group-selection-count');
    const submit = form.querySelector('button[type="submit"]');
    const updateSelection = (changed = null) => {
        let selected = checkboxes.filter((checkbox) => checkbox.checked);
        if (selected.length > MAX_GROUP_MEMBERS && changed) {
            changed.checked = false;
            selected = checkboxes.filter((checkbox) => checkbox.checked);
            notify('群組最多只能選擇 ' + MAX_GROUP_MEMBERS + ' 名角色。', 'warning');
        }
        for (const checkbox of checkboxes) {
            checkbox.disabled = !checkbox.checked && selected.length >= MAX_GROUP_MEMBERS;
            const card = checkbox.closest('.mol-group-member-card');
            card?.classList.toggle('joined', checkbox.checked);
            const status = card?.querySelector('em');
            if (status) status.textContent = checkbox.checked ? '已選擇' : '點擊加入群聊';
        }
        if (counter) counter.textContent = selected.length + ' / ' + MAX_GROUP_MEMBERS;
        if (submit) submit.disabled = selected.length < 1 || selected.length > MAX_GROUP_MEMBERS;
    };
    const onChange = (event) => updateSelection(event.target);
    const onSubmit = async (event) => {
        event.preventDefault();
        const name = String(new FormData(form).get('group_name') || '').trim();
        const members = checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
        const activationStrategy = Number(new FormData(form).get('activation_strategy') || 0);
        if (!name) { notify('請輸入群組名稱。', 'warning'); return; }
        if (!members.length || members.length > MAX_GROUP_MEMBERS) { notify('請選擇 1–' + MAX_GROUP_MEMBERS + ' 名角色。', 'warning'); return; }
        submit.disabled = true;
        try {
            if (group) {
                await saveGroupConfiguration(group, {
                    name,
                    members,
                    activation_strategy: activationStrategy,
                    disabled_members: (group.disabled_members || []).filter((avatar) => members.includes(avatar)),
                });
                closeDialog();
                applyMemoryInjection();
                notify('群組成員與回覆方式已更新。');
            } else {
                await createNativeGroup(name, members, activationStrategy);
                notify('群組已建立；聊天室保持空白，請傳送第一則訊息開始聊天。');
            }
        } catch (error) {
            console.error('[墨藍藝廊] 群組儲存失敗', error);
            notify(group ? '群組更新失敗，原設定仍會保留。' : '群組建立失敗，請稍後再試。', 'error');
            submit.disabled = false;
        }
    };
    checkboxes.forEach((checkbox) => checkbox.addEventListener('change', onChange));
    form.addEventListener('submit', onSubmit);
    activeDialogCleanup = () => {
        checkboxes.forEach((checkbox) => checkbox.removeEventListener('change', onChange));
        form.removeEventListener('submit', onSubmit);
    };
    updateSelection();
}

async function openGroupMembersPanel() {
    const entity = currentEntity(getContext());
    if (!entity || entity.type !== 'group') {
        notify('請先開啟群組聊天室。', 'warning');
        return;
    }
    await openGroupEditorDialog(entity.item);
}

async function openCreateGroupDialog() {
    await openGroupEditorDialog(null);
}

function openMoreDialog() {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    layer.innerHTML = [
        '<div class="mol-dialog mol-action-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHAT ACTIONS</p><h3>對話選項</h3>',
        '<button data-action="rename-chat"><i class="fa-solid fa-pen"></i><span>重新命名對話</span></button>',
        '<button data-action="greeting-selector"><i class="fa-solid fa-book-open"></i><span>切換開場白</span></button>',
        '<button data-action="export-current-chat"><i class="fa-solid fa-file-arrow-down"></i><span>匯出對話 TXT</span></button>',
        '<button data-action="memory-summary"><i class="fa-solid fa-brain"></i><span>記憶自動摘要</span></button>',
        '<button data-action="statusbar-manager"><i class="fa-solid fa-table-list"></i><span>互動狀態欄</span></button>',
        '<button data-action="player-profiles"><i class="fa-solid fa-user-pen"></i><span>玩家設定檔</span></button>',
        '<button data-action="delete-last"><i class="fa-solid fa-trash"></i><span>刪除最後訊息</span></button>',
        '<button data-action="delete-chat" class="danger"><i class="fa-solid fa-trash-can"></i><span>刪除目前聊天室</span></button>',
        '<button data-action="user-settings"><i class="fa-solid fa-palette"></i><span>藝廊介面設定</span></button>',
        '</div>',
    ].join('');
    layer.hidden = false;
}

function openGreetingSelector() {
    closeDialog();
    const context = getContext();
    const entity = currentEntity(context);
    if (!entity || entity.type !== 'character') {
        notify('開場白切換僅支援單人角色聊天室。', 'warning');
        return;
    }
    const greetings = getCharacterGreetings(entity);
    if (!greetings.length) {
        notify('目前角色卡沒有可用的開場白。', 'warning');
        return;
    }
    const opening = context.chat?.[0];
    if (!opening || opening.is_user) {
        notify('目前聊天室沒有可替換的第一則角色訊息。', 'warning');
        return;
    }
    const selectedIndex = currentGreetingIndex(context, greetings);
    const options = greetings.map((greeting, index) => [
        '<button type="button" class="mol-greeting-option' + (index === selectedIndex ? ' is-current' : '') + '" data-action="select-greeting" data-greeting-index="' + index + '">',
        '<span><strong>' + (index === 0 ? '預設開場白' : '開場白 ' + (index + 1)) + '</strong>' + (index === selectedIndex ? '<em><i class="fa-solid fa-check"></i> 目前使用</em>' : '') + '</span>',
        '<p>' + escapeHtml(greeting) + '</p>',
        '</button>',
    ].join('')).join('');
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    layer.innerHTML = [
        '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">OPENING GREETINGS</p><h3>切換開場白</h3>',
        '<p class="mol-dialog-copy">選擇後只會替換目前聊天室的第一則角色訊息；同角色的其他聊天室不受影響。</p>',
        '<div class="mol-greeting-list">' + options + '</div>',
        '<div class="mol-dialog-actions"><button data-action="more">返回對話選項</button></div></div>',
    ].join('');
    layer.hidden = false;
}

async function openPlayerProfilesPanel() {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    layer.innerHTML = '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">PLAYER PROFILES</p><h3>玩家設定檔</h3><div class="mol-profile-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在讀取設定檔…</div></div>';
    layer.hidden = false;
    try {
        const profiles = await getPlayerProfiles();
        if (layer.hidden) return;
        const cards = profiles.length ? profiles.map((profile) => [
            '<article class="mol-player-card' + (profile.active ? ' active' : '') + '">',
            '<span class="mol-player-avatar"><img src="' + escapeHtml(playerAvatarUrl(profile.avatarId, Date.now())) + '" alt=""></span>',
            '<span class="mol-player-copy"><strong>' + escapeHtml(profile.name) + '</strong><small>' + escapeHtml(profile.title || truncate(profile.description, 70) || '尚未填寫玩家描述') + '</small><em>' + (profile.chatLocked ? '目前聊天室已綁定' : (profile.active ? '目前使用中' : '可套用')) + '</em></span>',
            '<button data-action="select-player-profile" data-player-avatar="' + escapeHtml(profile.avatarId) + '"' + (profile.active && profile.chatLocked ? ' disabled' : '') + '>' + (profile.active && profile.chatLocked ? '已套用' : '套用') + '</button>',
            '<button data-action="edit-player-profile" data-player-avatar="' + escapeHtml(profile.avatarId) + '">修改</button>',
            '<button class="danger" data-action="delete-player-profile" data-player-avatar="' + escapeHtml(profile.avatarId) + '">刪除</button>',
            '</article>',
        ].join('')).join('') : '<div class="mol-profile-empty"><i class="fa-regular fa-user"></i><strong>尚未建立玩家設定檔</strong><span>建立後可在不同聊天室切換玩家名稱、頭像與提供給 AI 的人物描述。</span></div>';
        layer.innerHTML = [
            '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">PLAYER PROFILES</p><h3>玩家設定檔</h3>',
            '<div class="mol-panel-toolbar"><button class="primary" data-action="new-player-profile"><i class="fa-solid fa-plus"></i> 新增設定檔</button><button data-action="refresh-player-profiles"><i class="fa-solid fa-rotate"></i> 重新整理</button></div>',
            '<p class="mol-dialog-copy">每份設定檔皆使用 SillyTavern 原生 Persona 資料；套用後，玩家名稱、頭像與描述會提供給目前聊天室及 AI。</p>',
            '<div class="mol-player-grid">' + cards + '</div></div>',
        ].join('');
    } catch (error) {
        console.error('[墨藍藝廊] 讀取玩家設定檔失敗', error);
        layer.innerHTML = '<div class="mol-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">PLAYER PROFILES</p><h3>無法讀取玩家設定檔</h3><p class="mol-dialog-copy">請確認 SillyTavern 已更新至支援 Persona 的版本，再重新整理後重試。</p></div>';
    }
}

async function openPlayerProfileEditor(avatarId = '') {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context || !layer) return;
    const descriptor = context.powerUserSettings?.persona_descriptions?.[avatarId] || {};
    const name = String(context.powerUserSettings?.personas?.[avatarId] || '');
    const title = String(descriptor.title || '');
    const description = String(descriptor.description || '');
    const preview = avatarId
        ? '<img src="' + escapeHtml(playerAvatarUrl(avatarId, Date.now())) + '" alt="">'
        : '<span><i class="fa-regular fa-user"></i></span>';
    layer.innerHTML = [
        '<form class="mol-dialog mol-panel-dialog mol-player-editor"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">' + (avatarId ? 'EDIT PLAYER' : 'NEW PLAYER') + '</p><h3>' + (avatarId ? '修改玩家設定檔' : '新增玩家設定檔') + '</h3>',
        '<div class="mol-player-editor-layout"><label class="mol-player-avatar-field"><span class="mol-player-avatar-preview">' + preview + '</span><strong>' + (avatarId ? '更換頭像' : '選擇頭像') + '</strong><small>未選擇時使用預設頭像</small><input name="avatar" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>',
        '<div class="mol-form-grid"><label><span>玩家名稱</span><input name="name" type="text" maxlength="100" required value="' + escapeHtml(name) + '"></label><label><span>設定檔標題（僅顯示）</span><input name="title" type="text" maxlength="120" value="' + escapeHtml(title) + '"></label>',
        '<label class="wide"><span>玩家描述（會提供給 AI）</span><textarea name="description" rows="10" maxlength="30000" placeholder="例如：身分、外觀、個性、背景、偏好與互動界線…">' + escapeHtml(description) + '</textarea></label></div></div>',
        '<div class="mol-dialog-actions"><button type="button" data-action="player-profiles">取消</button><button type="submit" class="primary">儲存設定檔</button></div></form>',
    ].join('');
    layer.hidden = false;
    const form = layer.querySelector('form');
    const fileInput = form.elements.avatar;
    const previewHost = form.querySelector('.mol-player-avatar-preview');
    let previewUrl = '';
    const onFile = () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        const file = fileInput.files?.[0];
        if (!file) return;
        previewUrl = URL.createObjectURL(file);
        previewHost.innerHTML = '<img src="' + escapeHtml(previewUrl) + '" alt="頭像預覽">';
    };
    const onSubmit = async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        const data = new FormData(form);
        const values = {
            name: String(data.get('name') || '').trim(),
            title: String(data.get('title') || '').trim(),
            description: String(data.get('description') || '').trim(),
        };
        if (!values.name) { notify('請輸入玩家名稱。', 'warning'); return; }
        submit.disabled = true;
        submit.textContent = '儲存中…';
        try {
            await savePlayerProfile(avatarId, values, fileInput.files?.[0]);
            notify(avatarId ? '玩家設定檔已更新。' : '玩家設定檔已新增。');
            await openPlayerProfilesPanel();
        } catch (error) {
            console.error('[墨藍藝廊] 儲存玩家設定檔失敗', error);
            notify('玩家設定檔儲存失敗，請確認頭像格式後重試。', 'error');
            submit.disabled = false;
            submit.textContent = '儲存設定檔';
        }
    };
    fileInput.addEventListener('change', onFile);
    form.addEventListener('submit', onSubmit);
    activeDialogCleanup = () => {
        fileInput.removeEventListener('change', onFile);
        form.removeEventListener('submit', onSubmit);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    setTimeout(() => form.elements.name?.focus(), 0);
}

const MODEL_SELECTORS = {
    openai: '#model_openai_select', claude: '#model_claude_select', openrouter: '#model_openrouter_select',
    ai21: '#model_ai21_select', makersuite: '#model_google_select', vertexai: '#model_vertexai_select',
    mistralai: '#model_mistralai_select', cohere: '#model_cohere_select', perplexity: '#model_perplexity_select',
    groq: '#model_groq_select', electronhub: '#model_electronhub_select', chutes: '#model_chutes_select',
    nanogpt: '#model_nanogpt_select', deepseek: '#model_deepseek_select', aimlapi: '#model_aimlapi_select',
    xai: '#model_xai_select', pollinations: '#model_pollinations_select', moonshot: '#model_moonshot_select',
    fireworks: '#model_fireworks_select', cometapi: '#model_cometapi_select', azure_openai: '#azure_openai_model',
    zai: '#model_zai_select', siliconflow: '#model_siliconflow_select', workers_ai: '#model_workers_ai_select',
    minimax: '#model_minimax_select', custom: '#model_custom_select',
};

function getModelSelect(context = getContext()) {
    let selector = '';
    if (context?.mainApi === 'openai') selector = MODEL_SELECTORS[context.chatCompletionSettings?.chat_completion_source] || '';
    else if (context?.mainApi === 'novel') selector = '#model_novel_select';
    else if (context?.mainApi === 'horde') selector = '#horde_model';
    const fallbacks = [
        selector, '#mancer_model', '#model_togetherai_select', '#ollama_model', '#model_infermaticai_select',
        '#model_dreamgen_select', '#openrouter_model', '#vllm_model', '#aphrodite_model', '#featherless_model',
        '#tabby_model', '#llamacpp_model', '#generic_model',
    ].filter(Boolean);
    for (const candidate of fallbacks) {
        const element = document.querySelector(candidate);
        if (element instanceof HTMLSelectElement && element.options.length) return element;
    }
    return null;
}

function applyModelSelection(value) {
    const select = getModelSelect();
    if (!select || !Array.from(select.options).some((option) => option.value === value)) {
        notify('這個 API 尚未提供可切換的模型清單。', 'warning');
        return;
    }
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    notify('模型已切換為「' + (select.selectedOptions[0]?.textContent?.trim() || value) + '」。');
    refreshDetail();
}

function getChatCompletionPresetManager() {
    const context = getContext();
    try {
        return context?.getPresetManager?.('openai') || null;
    } catch (error) {
        console.error('[墨藍藝廊] 讀取聊天補全預設管理器失敗', error);
        return null;
    }
}

function chatCompletionPresetData(manager, name, useLiveSettings = false) {
    const source = useLiveSettings
        ? manager?.getPresetSettings?.(name)
        : manager?.getCompletionPresetByName?.(name);
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    return structuredClone(source);
}

async function saveAndSelectChatCompletionPreset(manager, name, preset) {
    await manager.savePreset(name, preset);
    const value = manager.findPreset(name);
    if (value !== undefined && value !== null) manager.selectPreset(value);
}

async function openChatCompletionPresetsPanel() {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    const manager = getChatCompletionPresetManager();
    if (!manager) {
        layer.innerHTML = '<div class="mol-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHAT COMPLETION</p><h3>無法讀取預設設定檔</h3><p class="mol-dialog-copy">目前 SillyTavern 未提供聊天補全預設管理器。請確認版本與 API 設定後再試一次。</p><div class="mol-dialog-actions"><button data-action="generation-settings">返回生成中心</button></div></div>';
        layer.hidden = false;
        return;
    }
    const names = manager.getAllPresets?.() || [];
    const selectedName = String(manager.getSelectedPresetName?.() || '');
    const rows = names.length ? names.map((name, index) => {
        const current = name === selectedName;
        return [
            '<article class="mol-preset-card' + (current ? ' active' : '') + '">',
            '<span class="mol-preset-number">' + String(index + 1).padStart(2, '0') + '</span>',
            '<span class="mol-preset-copy"><strong>' + escapeHtml(name) + '</strong><small>Chat Completion 預設</small>' + (current ? '<em><i class="fa-solid fa-check"></i> 目前使用</em>' : '') + '</span>',
            '<button data-action="select-chat-preset" data-preset-name="' + escapeHtml(name) + '"' + (current ? ' disabled' : '') + '>' + (current ? '已套用' : '切換') + '</button>',
            '<button data-action="export-chat-preset" data-preset-name="' + escapeHtml(name) + '">匯出</button>',
            '</article>',
        ].join('');
    }).join('') : '<div class="mol-profile-empty"><i class="fa-solid fa-sliders"></i><strong>尚無聊天補全預設</strong><span>可從目前生成參數建立第一份設定檔，或匯入 JSON。</span></div>';
    layer.innerHTML = [
        '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHAT COMPLETION PRESETS</p><h3>聊天補全預設設定檔</h3>',
        '<div class="mol-panel-toolbar"><button class="primary" data-action="new-chat-preset"><i class="fa-solid fa-plus"></i> 新增設定檔</button><button data-action="import-chat-preset"><i class="fa-solid fa-file-import"></i> 匯入 JSON</button><button data-action="refresh-chat-presets"><i class="fa-solid fa-rotate"></i> 重新整理</button></div>',
        '<input id="mol-chat-preset-import" type="file" accept=".json,application/json" hidden>',
        '<p class="mol-dialog-copy">切換會同步套用至 SillyTavern 原生 Chat Completion。新增會複製目前完整生成參數；匯入與匯出會保留取樣器、Token、串流、推理及 Prompt Manager 等 JSON 欄位。</p>',
        '<div class="mol-preset-list">' + rows + '</div>',
        '<div class="mol-dialog-actions"><button data-action="generation-settings">返回生成中心</button></div></div>',
    ].join('');
    layer.hidden = false;
    const input = layer.querySelector('#mol-chat-preset-import');
    const onImport = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            const source = parsed?.openai || parsed?.preset || parsed;
            if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid preset JSON');
            const fallbackName = file.name.replace(/\.json$/i, '').trim();
            const name = String(source.preset_name || source.name || fallbackName || '').trim();
            if (!name) throw new Error('Missing preset name');
            const preset = structuredClone(source);
            preset.preset_name = name;
            const existing = names.find((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase());
            const commit = async () => {
                try {
                    await saveAndSelectChatCompletionPreset(manager, existing || name, preset);
                    notify('聊天補全預設「' + (existing || name) + '」已匯入並套用。');
                    await openChatCompletionPresetsPanel();
                } catch (error) {
                    console.error('[墨藍藝廊] 儲存匯入的聊天補全預設失敗', error);
                    notify('預設匯入失敗，請檢查 SillyTavern 連線後重試。', 'error');
                }
                return false;
            };
            if (existing) {
                openConfirmDialog('覆蓋聊天補全預設', '已存在「' + existing + '」。是否以匯入檔完整覆蓋並立即套用？', commit);
            } else {
                await commit();
            }
        } catch (error) {
            console.error('[墨藍藝廊] 匯入聊天補全預設失敗', error);
            notify('匯入失敗：請選擇有效的聊天補全預設 JSON。', 'error');
        } finally {
            input.value = '';
        }
    };
    input.addEventListener('change', onImport);
    activeDialogCleanup = () => input.removeEventListener('change', onImport);
}

function openNewChatCompletionPresetDialog() {
    const manager = getChatCompletionPresetManager();
    if (!manager) {
        notify('目前無法讀取聊天補全預設。', 'error');
        return;
    }
    const selectedName = String(manager.getSelectedPresetName?.() || '');
    openTextDialog({
        title: '新增聊天補全預設',
        label: '設定檔名稱',
        value: selectedName ? selectedName + ' 副本' : '',
        submitText: '建立並套用',
        onSubmit: async (value) => {
            const name = value.trim();
            if (!name) { notify('請輸入設定檔名稱。', 'warning'); return false; }
            const names = manager.getAllPresets?.() || [];
            if (names.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase())) {
                notify('已有同名聊天補全預設，請使用其他名稱。', 'warning');
                return false;
            }
            const preset = chatCompletionPresetData(manager, selectedName, true);
            if (!preset) { notify('無法取得目前生成參數。', 'error'); return false; }
            preset.preset_name = name;
            try {
                await saveAndSelectChatCompletionPreset(manager, name, preset);
                notify('聊天補全預設「' + name + '」已建立並套用。');
                await openChatCompletionPresetsPanel();
                return false;
            } catch (error) {
                console.error('[墨藍藝廊] 新增聊天補全預設失敗', error);
                notify('設定檔建立失敗，請檢查 SillyTavern 連線後重試。', 'error');
                return false;
            }
        },
    });
}

async function openWorldInfoPanel() {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context || !layer) return;
    const names = context.getWorldInfoNames?.() || [];
    layer.innerHTML = [
        '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button>',
        '<p class="mol-eyebrow">WORLD INFO</p><h3>世界書</h3>',
        '<div class="mol-panel-toolbar"><button data-action="new-world-book" class="primary"><i class="fa-solid fa-plus"></i> 新增</button><button data-action="import-world-info"><i class="fa-solid fa-file-import"></i> 匯入</button><button data-action="refresh-world-info"><i class="fa-solid fa-rotate"></i> 重新整理</button></div>',
        '<input id="mol-world-import" type="file" accept=".json,.png" hidden>',
        names.length ? '<div class="mol-world-books">' + names.map((name, index) => [
            '<article><span class="mol-book-number">' + String(index + 1).padStart(2, '0') + '</span><div><strong>' + escapeHtml(name) + '</strong><small>世界書資料</small></div>',
            '<button data-action="edit-world-book" data-book="' + escapeHtml(name) + '">開啟／修改</button>',
            '<button data-action="rename-world-book" data-book="' + escapeHtml(name) + '">重新命名</button>',
            '<button data-action="delete-world-book" data-book="' + escapeHtml(name) + '" class="danger">刪除</button></article>',
        ].join('')).join('') + '</div>' : '<p class="mol-dialog-copy">目前沒有世界書。可新增空白世界書，或匯入 JSON／PNG。</p>',
        '<div class="mol-dialog-actions"><button class="primary" data-action="close-dialog">完成</button></div></div>',
    ].join('');
    layer.hidden = false;
    const input = layer.querySelector('#mol-world-import');
    const onChange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const baseName = file.name.replace(/\.[^.]+$/, '');
            if ((context.getWorldInfoNames?.() || []).some((name) => String(name).toLocaleLowerCase() === baseName.toLocaleLowerCase())) {
                notify('已有同名世界書；請先重新命名檔案或刪除舊世界書。', 'warning');
                input.value = '';
                return;
            }
            const api = await getWorldInfoApi();
            await api.importWorldInfo(file);
            notify('世界書已匯入。');
            await openWorldInfoPanel();
        } catch (error) {
            console.error('[墨藍藝廊] 匯入世界書失敗', error);
            notify('世界書匯入失敗，請確認檔案格式。', 'error');
        }
    };
    input.addEventListener('change', onChange);
    activeDialogCleanup = () => input.removeEventListener('change', onChange);
}

function worldEntryTitle(entry, uid) {
    return entry?.comment?.trim() || entry?.key?.filter(Boolean)?.join('、') || '條目 #' + uid;
}

async function openWorldBookPanel(name) {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    try {
        const api = await getWorldInfoApi();
        const data = await api.loadWorldInfo(name);
        const entries = Object.entries(data?.entries || {}).sort(([, a], [, b]) => Number(b.order || 0) - Number(a.order || 0));
        layer.innerHTML = [
            '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button>',
            '<p class="mol-eyebrow">WORLD BOOK</p><h3>' + escapeHtml(name) + '</h3>',
            '<div class="mol-panel-toolbar"><button data-action="world-info"><i class="fa-solid fa-arrow-left"></i> 返回</button><button data-action="rename-world-book" data-book="' + escapeHtml(name) + '"><i class="fa-solid fa-pen"></i> 修改名稱</button><button class="primary" data-action="new-world-entry" data-book="' + escapeHtml(name) + '"><i class="fa-solid fa-plus"></i> 新增條目</button></div>',
            entries.length ? '<div class="mol-world-entries">' + entries.map(([uid, entry]) => [
                '<article><div><strong>' + escapeHtml(worldEntryTitle(entry, uid)) + '</strong><small>' + escapeHtml(truncate(entry.content || '尚無內容', 88)) + '</small></div>',
                '<span class="mol-entry-state">' + (entry.disable ? '停用' : '啟用') + '</span>',
                '<button data-action="edit-world-entry" data-book="' + escapeHtml(name) + '" data-uid="' + escapeHtml(uid) + '">修改</button>',
                '<button data-action="delete-world-entry" data-book="' + escapeHtml(name) + '" data-uid="' + escapeHtml(uid) + '" class="danger">刪除</button></article>',
            ].join('')).join('') + '</div>' : '<p class="mol-dialog-copy">這本世界書還沒有條目。</p>',
            '</div>',
        ].join('');
        layer.hidden = false;
    } catch (error) {
        console.error('[墨藍藝廊] 讀取世界書失敗', error);
        notify('無法讀取世界書。', 'error');
        await openWorldInfoPanel();
    }
}

async function renameWorldBook(oldName, newName) {
    const context = getContext();
    const api = await getWorldInfoApi();
    const nextName = String(newName || '').trim();
    if (!context || !oldName) throw new Error('World info context is unavailable');
    if (!nextName) {
        notify('世界書名稱不可空白。', 'warning');
        return null;
    }
    if (nextName === oldName) return oldName;
    if (nextName.toLocaleLowerCase() === String(oldName).toLocaleLowerCase()) {
        notify('新名稱不可只變更英文字母大小寫。', 'warning');
        return null;
    }
    const names = context.getWorldInfoNames?.() || [];
    if (names.some((name) => name !== oldName && String(name).toLocaleLowerCase() === nextName.toLocaleLowerCase())) {
        notify('已有同名世界書，請使用其他名稱。', 'warning');
        return null;
    }

    const data = await api.loadWorldInfo(oldName);
    if (!data) throw new Error('World info not found');
    await api.saveWorldInfo(nextName, data, true);

    const selectedIndex = api.selected_world_info?.findIndex((name) => name === oldName) ?? -1;
    if (selectedIndex >= 0) api.selected_world_info.splice(selectedIndex, 1, nextName);
    if (api.world_info && typeof api.world_info === 'object') {
        api.world_info.globalSelect = [...(api.selected_world_info || [])];
    }
    for (const link of api.world_info?.charLore || []) {
        if (!Array.isArray(link.extraBooks)) continue;
        link.extraBooks = link.extraBooks.map((name) => name === oldName ? nextName : name);
    }
    if (context.powerUserSettings?.persona_description_lorebook === oldName) {
        context.powerUserSettings.persona_description_lorebook = nextName;
    }
    for (const descriptor of Object.values(context.powerUserSettings?.persona_descriptions || {})) {
        if (descriptor?.lorebook === oldName) descriptor.lorebook = nextName;
    }

    for (const character of context.characters || []) {
        if (character?.data?.extensions?.world !== oldName) continue;
        const response = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar: character.avatar, data: { extensions: { world: nextName } } }),
        });
        if (!response.ok) throw new Error('Could not update character lorebook link');
        character.data.extensions.world = nextName;
    }

    const deletion = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ name: oldName }),
    });
    if (!deletion.ok) throw new Error('Could not remove the previous world info file');
    await api.updateWorldInfoList?.();
    context.saveSettingsDebounced();
    return nextName;
}

async function openWorldEntryEditor(name, uid = null) {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    const api = await getWorldInfoApi();
    const data = await api.loadWorldInfo(name);
    const isNew = uid === null;
    let entry = isNew
        ? { ...structuredClone(api.newWorldInfoEntryTemplate || {}), key: [], keysecondary: [], comment: '', content: '', constant: false, order: 100, disable: false }
        : data?.entries?.[uid];
    if (!entry) {
        notify('找不到指定的世界書條目。', 'error');
        await openWorldBookPanel(name);
        return;
    }
    layer.innerHTML = [
        '<form class="mol-dialog mol-panel-dialog mol-wide-dialog mol-entry-form"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button>',
        '<p class="mol-eyebrow">WORLD ENTRY</p><h3>' + (isNew ? '新增條目' : '修改條目') + '</h3>',
        '<div class="mol-form-grid"><label><span>標題／註解</span><input name="comment" value="' + escapeHtml(entry.comment || '') + '"></label>',
        '<label><span>順序</span><input name="order" type="number" value="' + escapeHtml(entry.order ?? 100) + '"></label>',
        '<label class="wide"><span>主要關鍵字（逗號分隔）</span><input name="key" value="' + escapeHtml((entry.key || []).join(', ')) + '"></label>',
        '<label class="wide"><span>次要關鍵字（逗號分隔）</span><input name="keysecondary" value="' + escapeHtml((entry.keysecondary || []).join(', ')) + '"></label>',
        '<label class="wide"><span>內容</span><textarea name="content" rows="10">' + escapeHtml(entry.content || '') + '</textarea></label>',
        '<label class="check"><input name="constant" type="checkbox"' + (entry.constant ? ' checked' : '') + '><span>常駐啟用</span></label>',
        '<label class="check"><input name="disable" type="checkbox"' + (entry.disable ? ' checked' : '') + '><span>停用此條目</span></label></div>',
        '<div class="mol-dialog-actions"><button type="button" data-action="edit-world-book" data-book="' + escapeHtml(name) + '">取消</button><button type="submit" class="primary">儲存條目</button></div></form>',
    ].join('');
    layer.hidden = false;
    const form = layer.querySelector('form');
    const handler = async (event) => {
        event.preventDefault();
        const values = new FormData(form);
        const split = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
        const patch = {
            comment: String(values.get('comment') || '').trim(),
            content: String(values.get('content') || ''),
            key: split(values.get('key')),
            keysecondary: split(values.get('keysecondary')),
            order: Number(values.get('order') || 100),
            constant: values.get('constant') === 'on',
            disable: values.get('disable') === 'on',
        };
        if (isNew) {
            entry = api.createWorldInfoEntry(name, data);
            if (!entry) throw new Error('Could not create world info entry');
            uid = String(entry.uid);
        }
        Object.assign(entry, patch);
        data.entries[uid] = entry;
        await api.saveWorldInfo(name, data, true);
        notify('世界書條目已儲存。');
        await openWorldBookPanel(name);
    };
    form.addEventListener('submit', handler);
    activeDialogCleanup = () => form.removeEventListener('submit', handler);
}

function openCharacterOverview(index = characterCarouselIndex, flipped = false) {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context || !layer) return;
    const characters = context.characters || [];
    characterCarouselIndex = characters.length ? Math.max(0, Math.min(characters.length - 1, Number(index) || 0)) : 0;
    characterCarouselFlipped = Boolean(flipped);
    let card = '<div class="mol-character-empty"><strong>目前沒有角色</strong><p>可新增角色，或匯入 JSON、PNG、YAML、CHARX、BYAF 角色卡。</p></div>';
    if (characters.length) {
        const id = characterCarouselIndex;
        const character = characters[id];
        const data = character.data || {};
        const name = character.name || data.name || '未命名角色';
        const entity = { type: 'character', item: character, id };
        const image = portraitImageMarkup(entity, context, name, 'mol-character-portrait-image');
        const field = (label, value) => '<section><span>' + label + '</span><p>' + escapeHtml(value || '—').replaceAll('\n', '<br>') + '</p></section>';
        const dots = characters.map((_, dotIndex) => '<button type="button" class="mol-carousel-dot' + (dotIndex === id ? ' active' : '') + '" data-action="character-carousel-go" data-character-index="' + dotIndex + '" aria-label="前往第 ' + (dotIndex + 1) + ' 張角色卡"></button>').join('');
        card = [
            '<div class="mol-character-carousel" data-character-index="' + id + '">',
            '<div class="mol-carousel-count"><span>FRAME ' + String(id + 1).padStart(2, '0') + '</span><strong>' + (id + 1) + ' / ' + characters.length + '</strong></div>',
            '<div class="mol-frame-stage">',
            '<article class="mol-character-frame-shell' + (characterCarouselEnterDirection > 0 ? ' is-entering-next' : characterCarouselEnterDirection < 0 ? ' is-entering-previous' : '') + '">',
            '<div class="mol-character-flip' + (characterCarouselFlipped ? ' is-flipped' : '') + '"><div class="mol-character-flip-inner">',
            '<section class="mol-character-face mol-character-front" aria-hidden="' + (characterCarouselFlipped ? 'true' : 'false') + '">',
            '<span class="mol-frame-ornament" aria-hidden="true"></span><button type="button" class="mol-character-image-wrap" data-action="toggle-character-flip" aria-label="查看 ' + escapeHtml(name) + ' 的角色資訊" tabindex="' + (characterCarouselFlipped ? '-1' : '0') + '">' + (image || '<span class="mol-character-image-fallback">' + escapeHtml(initials(name)) + '</span>') + '</button>',
            '<span class="mol-character-nameplate"><strong>' + escapeHtml(name) + '</strong><small>' + escapeHtml(data.personality || character.personality || '角色卡') + '</small></span></section>',
            '<section class="mol-character-face mol-character-back" data-action="toggle-character-flip" aria-label="' + escapeHtml(name) + ' 的角色資訊；點擊卡片可翻回角色圖片" aria-hidden="' + (characterCarouselFlipped ? 'false' : 'true') + '"><span class="mol-frame-ornament" aria-hidden="true"></span>',
            '<div class="mol-character-back-heading"><div><p class="mol-eyebrow">CHARACTER CARD</p><h4>' + escapeHtml(name) + '</h4><small class="mol-back-flip-hint"><i class="fa-solid fa-rotate-left"></i> 再點一次卡片返回圖片</small></div><button type="button" data-action="toggle-character-flip" title="翻回圖片"><i class="fa-solid fa-rotate-left"></i></button></div>',
            '<div class="mol-character-back-scroll">' + field('DESCRIPTION', data.description || character.description) + field('PERSONALITY', data.personality || character.personality) + field('SCENARIO', data.scenario) + field('FIRST MESSAGE', data.first_mes || character.first_mes) + '</div>',
            '<div class="mol-character-card-actions"><button data-action="edit-character-card" data-character-id="' + id + '">修改</button><button data-action="export-character-card" data-character-id="' + id + '" data-format="png">匯出 PNG</button><button data-action="export-character-card" data-character-id="' + id + '" data-format="json">匯出 JSON</button><button data-action="delete-character-card" data-character-id="' + id + '" class="danger">刪除</button><button class="primary" data-action="select-overview-character" data-character-id="' + id + '">進入聊天室</button></div>',
            '</section></div></div></article>',
            '</div><div class="mol-carousel-dots" aria-label="角色卡頁面">' + dots + '</div></div>',
        ].join('');
    }
    layer.innerHTML = '<div class="mol-dialog mol-panel-dialog mol-character-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHARACTER ARCHIVE</p><h3>角色總覽</h3><div class="mol-panel-toolbar"><button class="primary" data-action="new-character-card"><i class="fa-solid fa-plus"></i> 新增角色</button><button data-action="import-character-card"><i class="fa-solid fa-file-import"></i> 匯入角色卡</button><button data-action="refresh-character-overview"><i class="fa-solid fa-rotate"></i> 重新整理</button></div><input id="mol-character-import" type="file" accept=".json,.png,.yaml,.yml,.charx,.byaf" multiple hidden>' + card + '</div>';
    layer.hidden = false;
    wireImageFallbacks(layer);
    const input = layer.querySelector('#mol-character-import');
    const onChange = async () => {
        try {
            for (const file of Array.from(input.files || [])) await importCharacterCardFile(file);
            input.value = '';
            await context.getCharacters();
            await loadChatEntries();
            openCharacterOverview(context.characters.length - 1, false);
        } catch (error) {
            console.error('[墨藍藝廊] 匯入角色卡失敗', error);
            notify('角色卡匯入失敗，請確認檔案格式。', 'error');
        }
    };
    input.addEventListener('change', onChange);
    const stage = layer.querySelector('.mol-frame-stage');
    const shell = layer.querySelector('.mol-character-frame-shell');
    if (characterCarouselEnterDirection && shell) {
        requestAnimationFrame(() => requestAnimationFrame(() => shell.classList.add('is-settled')));
        window.setTimeout(() => {
            shell.classList.remove('is-entering-next', 'is-entering-previous', 'is-settled');
            characterCarouselTransitioning = false;
        }, 420);
        characterCarouselEnterDirection = 0;
    } else {
        characterCarouselTransitioning = false;
    }
    let startX = 0;
    let startY = 0;
    let pointerId = null;
    let horizontalDragStarted = false;
    let pointerStartedOnFlipTarget = false;
    const onPointerDown = (event) => {
        if (characters.length < 2 || characterCarouselTransitioning || (event.pointerType === 'mouse' && event.button !== 0)) return;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        horizontalDragStarted = false;
        pointerStartedOnFlipTarget = Boolean(event.target.closest?.('[data-action="toggle-character-flip"]'));
    };
    const onPointerMove = (event) => {
        if (pointerId !== event.pointerId || !shell) return;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        if (Math.abs(deltaY) > Math.abs(deltaX) * 1.25) return;
        if (!horizontalDragStarted) {
            if (Math.abs(deltaX) < 10) return;
            horizontalDragStarted = true;
            shell.classList.add('is-dragging');
            stage?.setPointerCapture?.(event.pointerId);
        }
        const limitedX = Math.max(-110, Math.min(110, deltaX * .72));
        shell.style.setProperty('--mol-card-drag-x', limitedX + 'px');
        shell.style.setProperty('--mol-card-drag-rotate', (limitedX / 42) + 'deg');
    };
    const onPointerUp = (event) => {
        if (pointerId !== event.pointerId) return;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        const wasHorizontalDrag = horizontalDragStarted;
        const startedOnFlipTarget = pointerStartedOnFlipTarget;
        pointerId = null;
        horizontalDragStarted = false;
        pointerStartedOnFlipTarget = false;
        if (stage?.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
        shell?.classList.remove('is-dragging');
        shell?.style.removeProperty('--mol-card-drag-x');
        shell?.style.removeProperty('--mol-card-drag-rotate');
        if (Math.abs(deltaX) < 52 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) {
            if (wasHorizontalDrag && startedOnFlipTarget && Math.abs(deltaX) < 24 && Math.abs(deltaY) < 24) {
                characterSwipeIgnoreUntil = Date.now() + 80;
                characterCarouselFlipped = !characterCarouselFlipped;
                const flip = layer.querySelector('.mol-character-flip');
                flip?.classList.toggle('is-flipped', characterCarouselFlipped);
                flip?.querySelector('.mol-character-front')?.setAttribute('aria-hidden', characterCarouselFlipped ? 'true' : 'false');
                flip?.querySelector('.mol-character-image-wrap')?.setAttribute('tabindex', characterCarouselFlipped ? '-1' : '0');
                flip?.querySelector('.mol-character-back')?.setAttribute('aria-hidden', characterCarouselFlipped ? 'false' : 'true');
            }
            return;
        }
        characterSwipeIgnoreUntil = Date.now() + 360;
        changeCharacterOverview(deltaX > 0 ? -1 : 1);
    };
    const onPointerCancel = (event) => {
        if (pointerId !== event.pointerId) return;
        pointerId = null;
        horizontalDragStarted = false;
        pointerStartedOnFlipTarget = false;
        shell?.classList.remove('is-dragging');
        shell?.style.removeProperty('--mol-card-drag-x');
        shell?.style.removeProperty('--mol-card-drag-rotate');
    };
    const onKeyDown = (event) => {
        if (characters.length < 2) return;
        if (event.key === 'ArrowRight') changeCharacterOverview(1);
        if (event.key === 'ArrowLeft') changeCharacterOverview(-1);
    };
    stage?.addEventListener('pointerdown', onPointerDown);
    stage?.addEventListener('pointermove', onPointerMove);
    stage?.addEventListener('pointerup', onPointerUp);
    stage?.addEventListener('pointercancel', onPointerCancel);
    layer.addEventListener('keydown', onKeyDown);
    activeDialogCleanup = () => {
        if (characterCarouselTransitionTimer) {
            window.clearTimeout(characterCarouselTransitionTimer);
            characterCarouselTransitionTimer = null;
        }
        input.removeEventListener('change', onChange);
        stage?.removeEventListener('pointerdown', onPointerDown);
        stage?.removeEventListener('pointermove', onPointerMove);
        stage?.removeEventListener('pointerup', onPointerUp);
        stage?.removeEventListener('pointercancel', onPointerCancel);
        layer.removeEventListener('keydown', onKeyDown);
    };
}

function changeCharacterOverview(direction, explicitIndex = null) {
    const context = getContext();
    const characters = context?.characters || [];
    if (characters.length < 2 || characterCarouselTransitioning) return;
    const normalizedDirection = direction >= 0 ? 1 : -1;
    const nextIndex = explicitIndex === null
        ? (characterCarouselIndex + normalizedDirection + characters.length) % characters.length
        : Math.max(0, Math.min(characters.length - 1, Number(explicitIndex) || 0));
    if (nextIndex === characterCarouselIndex) return;
    const shell = document.querySelector('#mol-dialog .mol-character-frame-shell');
    if (!shell || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        openCharacterOverview(nextIndex, false);
        return;
    }
    characterCarouselTransitioning = true;
    characterCarouselFlipped = false;
    shell.querySelector('.mol-character-flip')?.classList.remove('is-flipped');
    shell.classList.add(normalizedDirection > 0 ? 'is-exiting-next' : 'is-exiting-previous');
    characterCarouselTransitionTimer = window.setTimeout(() => {
        characterCarouselTransitionTimer = null;
        characterCarouselEnterDirection = normalizedDirection;
        openCharacterOverview(nextIndex, false);
    }, 230);
}

function openCharacterCard(id) {
    const context = getContext();
    const character = context?.characters?.[Number(id)];
    const layer = document.getElementById('mol-dialog');
    if (!character || !layer) return;
    const data = character.data || {};
    const field = (label, value) => '<section><span>' + label + '</span><p>' + escapeHtml(value || '—').replaceAll('\n', '<br>') + '</p></section>';
    layer.innerHTML = '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHARACTER CARD</p><h3>' + escapeHtml(character.name || data.name || '未命名角色') + '</h3><div class="mol-character-detail">' + field('DESCRIPTION', data.description || character.description) + field('PERSONALITY', data.personality) + field('SCENARIO', data.scenario) + field('FIRST MESSAGE', data.first_mes || character.first_mes) + field('CREATOR NOTES', data.creator_notes || character.creator_notes) + field('SYSTEM PROMPT', data.system_prompt) + '</div><div class="mol-dialog-actions"><button data-action="character-overview">返回總覽</button><button data-action="edit-character-card" data-character-id="' + Number(id) + '">修改</button><button class="primary" data-action="select-overview-character" data-character-id="' + Number(id) + '">進入聊天室</button></div></div>';
    layer.hidden = false;
}

async function importCharacterCardFile(file, preserveFileName = '') {
    const context = getContext();
    const extension = file.name.split('.').pop()?.toLocaleLowerCase();
    if (!['json', 'png', 'yaml', 'yml', 'charx', 'byaf'].includes(extension)) {
        notify('不支援的角色卡格式：' + file.name, 'warning');
        return false;
    }
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', extension);
    formData.append('user_name', context.name1 || 'User');
    if (preserveFileName) formData.append('preserved_name', preserveFileName);
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        headers: context.getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.error) throw new Error(result.error || response.statusText || 'Import failed');
    notify(preserveFileName ? '角色卡已更新。' : '角色卡已匯入。');
    return true;
}

async function exportCharacterCard(id, format = 'png') {
    const context = getContext();
    const character = context?.characters?.[Number(id)];
    if (!character) return;
    const response = await fetch('/api/characters/export', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ format, avatar_url: character.avatar }),
    });
    if (!response.ok) throw new Error(response.statusText || 'Export failed');
    downloadBlob(await response.blob(), safeFilename(character.name || 'character') + '.' + format);
    notify('角色卡已匯出。');
}

async function getCharacterJson(character) {
    const context = getContext();
    const response = await fetch('/api/characters/export', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ format: 'json', avatar_url: character.avatar }),
    });
    if (!response.ok) throw new Error(response.statusText || 'Could not read character card');
    return response.json();
}

function newCharacterCardData(values) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: values.name,
            description: values.description,
            personality: values.personality,
            scenario: values.scenario,
            first_mes: values.first_mes,
            mes_example: values.mes_example,
            creator_notes: values.creator_notes,
            system_prompt: values.system_prompt,
            post_history_instructions: '',
            alternate_greetings: values.alternate_greetings || [], tags: [], creator: '', character_version: '', extensions: {},
        },
    };
}

async function openCharacterEditor(id = null) {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context || !layer) return;
    const character = id === null ? null : context.characters[Number(id)];
    const data = character?.data || {};
    const value = (key, fallback = '') => escapeHtml(data[key] ?? character?.[key] ?? fallback);
    const alternateValue = escapeHtml((Array.isArray(data.alternate_greetings) ? data.alternate_greetings : (character?.alternate_greetings || [])).map(String).join('\n---\n'));
    layer.innerHTML = [
        '<form class="mol-dialog mol-panel-dialog mol-wide-dialog mol-character-form"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHARACTER EDITOR</p><h3>' + (character ? '修改角色卡' : '新增角色卡') + '</h3>',
        '<div class="mol-form-grid"><label><span>角色名稱</span><input name="name" required value="' + value('name') + '"></label><label><span>角色定位</span><input name="personality" value="' + value('personality') + '"></label>',
        '<label class="wide"><span>角色描述</span><textarea name="description" rows="5">' + value('description') + '</textarea></label>',
        '<label class="wide"><span>場景設定</span><textarea name="scenario" rows="4">' + value('scenario') + '</textarea></label>',
        '<label class="wide"><span>預設開場白</span><textarea name="first_mes" rows="5">' + value('first_mes') + '</textarea></label>',
        '<label class="wide"><span>替代開場白（使用單獨一行 --- 分隔）</span><textarea name="alternate_greetings" rows="8">' + alternateValue + '</textarea></label>',
        '<label class="wide"><span>對話範例</span><textarea name="mes_example" rows="4">' + value('mes_example') + '</textarea></label>',
        '<label class="wide"><span>創作者備註</span><textarea name="creator_notes" rows="4">' + value('creator_notes') + '</textarea></label>',
        '<label class="wide"><span>System Prompt</span><textarea name="system_prompt" rows="4">' + value('system_prompt') + '</textarea></label></div>',
        '<div class="mol-dialog-actions"><button type="button" data-action="character-overview">取消</button><button type="submit" class="primary">' + (character ? '儲存修改' : '建立角色') + '</button></div></form>',
    ].join('');
    layer.hidden = false;
    const form = layer.querySelector('form');
    const handler = async (event) => {
        event.preventDefault();
        try {
            const formData = new FormData(form);
            const values = Object.fromEntries(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt'].map((key) => [key, String(formData.get(key) || '')]));
            values.alternate_greetings = String(formData.get('alternate_greetings') || '').split(/\n\s*---\s*\n/g).map((item) => item.trim()).filter(Boolean);
            if (!values.name.trim()) return notify('請輸入角色名稱。', 'warning');
            let card = character ? await getCharacterJson(character) : newCharacterCardData(values);
            card.data ||= {};
            Object.assign(card.data, values);
            card.name = values.name;
            const file = new File([JSON.stringify(card)], safeFilename(values.name, 'character') + '.json', { type: 'application/json' });
            await importCharacterCardFile(file, character?.avatar || '');
            await context.getCharacters();
            await loadChatEntries();
            openCharacterOverview();
        } catch (error) {
            console.error('[墨藍藝廊] 儲存角色卡失敗', error);
            notify('角色卡儲存失敗。', 'error');
        }
    };
    form.addEventListener('submit', handler);
    activeDialogCleanup = () => form.removeEventListener('submit', handler);
}

function openMemorySummaryPanel() {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context || !layer) return;
    const memory = getChatMeta(context).memorySummary;
    const status = memory.updatedAt ? new Date(memory.updatedAt).toLocaleString() : '尚未產生摘要';
    layer.innerHTML = [
        '<form class="mol-dialog mol-panel-dialog mol-wide-dialog mol-memory-form"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">AUTO MEMORY</p><h3>記憶自動摘要</h3>',
        '<p class="mol-dialog-hint">摘要只屬於目前聊天室。儲存後會作為系統記憶提供給後續 AI 回覆；AI 產生的內容可在下方直接修改。</p>',
        '<div class="mol-settings-list"><label><span><strong>自動摘要</strong><small>達到設定的新增訊息數後自動更新</small></span><input name="enabled" type="checkbox"' + (memory.enabled ? ' checked' : '') + '></label></div>',
        '<div class="mol-form-grid"><label><span>每新增幾則訊息摘要一次</span><input name="everyMessages" type="number" min="5" max="200" value="' + memory.everyMessages + '"></label><label><span>狀態</span><strong>' + escapeHtml(status) + '</strong></label>',
        '<label class="wide"><span>提供給 AI 的摘要要求</span><textarea name="instruction" rows="5">' + escapeHtml(memory.instruction) + '</textarea></label>',
        '<label class="wide"><span>提供給 AI 的輸出格式</span><textarea name="format" rows="9">' + escapeHtml(memory.format) + '</textarea></label>',
        '<label class="wide"><span>AI 摘要內容（可人工修改）</span><textarea name="content" rows="13">' + escapeHtml(memory.content) + '</textarea></label></div>',
        '<div class="mol-dialog-actions"><button type="button" data-action="clear-memory-summary">清空摘要</button><button type="button" data-action="generate-memory-summary">立即由 AI 摘要</button><button type="submit" class="primary">儲存設定與內容</button></div></form>',
    ].join('');
    layer.hidden = false;
    const form = layer.querySelector('form');
    const saveFromForm = async ({ close = true } = {}) => {
        const values = new FormData(form);
        const next = normalizeMemory({
            enabled: values.get('enabled') === 'on',
            everyMessages: Number(values.get('everyMessages')),
            instruction: String(values.get('instruction') || '').trim(),
            format: String(values.get('format') || '').trim(),
            content: String(values.get('content') || '').trim(),
            lastSummarizedCount: memory.lastSummarizedCount,
            updatedAt: memory.updatedAt,
        });
        await saveChatMeta({ memorySummary: next, memory: next.content });
        if (close) closeDialog();
        return next;
    };
    const submit = async (event) => { event.preventDefault(); await saveFromForm(); notify('記憶摘要設定已儲存。'); };
    const generate = async () => { await saveFromForm({ close: false }); await generateMemorySummary({ force: true }); };
    const clear = async () => {
        form.elements.content.value = '';
        const next = await saveFromForm({ close: false });
        next.lastSummarizedCount = 0;
        next.updatedAt = 0;
        await saveChatMeta({ memorySummary: next, memory: '' });
        notify('摘要內容已清空。');
    };
    form.addEventListener('submit', submit);
    layer.querySelector('[data-action="generate-memory-summary"]').addEventListener('click', generate);
    layer.querySelector('[data-action="clear-memory-summary"]').addEventListener('click', clear);
    activeDialogCleanup = () => {
        form.removeEventListener('submit', submit);
        layer.querySelector('[data-action="generate-memory-summary"]')?.removeEventListener('click', generate);
        layer.querySelector('[data-action="clear-memory-summary"]')?.removeEventListener('click', clear);
    };
}

async function generateMemorySummary({ force = false } = {}) {
    const context = getContext();
    if (!context?.chat?.length || summaryRunning) {
        if (force && !context?.chat?.length) notify('目前聊天室沒有可摘要的訊息。', 'warning');
        return;
    }
    const memory = getChatMeta(context).memorySummary;
    if (!force && (!memory.enabled || context.chat.length - memory.lastSummarizedCount < memory.everyMessages || isBusy)) return;
    summaryRunning = true;
    permitManualGeneration(120000);
    try {
        const transcript = context.chat.map((message) => {
            const speaker = message.is_user ? (context.name1 || '使用者') : (message.name || context.name2 || '角色');
            return speaker + '：' + String(message.mes || '');
        }).join('\n').slice(-60000);
        const prompt = [
            '你正在為角色扮演對話整理可供後續 AI 使用的長期記憶。',
            '使用者要求：\n' + (memory.instruction || DEFAULT_MEMORY.instruction),
            '輸出格式：\n' + (memory.format || DEFAULT_MEMORY.format),
            memory.content ? '上一次摘要（請依新對話整合、修正，不要盲目保留已失效資訊）：\n' + memory.content : '',
            '目前完整對話：\n' + transcript,
            '只輸出摘要正文，不要附加解釋、前言或 Markdown 程式碼框。',
        ].filter(Boolean).join('\n\n');
        notify('正在產生記憶摘要…');
        const result = await context.generateQuietPrompt({ quietPrompt: prompt, trimToSentence: false, removeReasoning: true });
        const next = { ...memory, content: String(result || '').trim(), lastSummarizedCount: context.chat.length, updatedAt: Date.now() };
        await saveChatMeta({ memorySummary: next, memory: next.content });
        notify('AI 摘要已產生，可繼續人工修改。');
        if (!document.getElementById('mol-dialog')?.hidden) openMemorySummaryPanel();
    } catch (error) {
        console.error('[墨藍藝廊] 產生記憶摘要失敗', error);
        notify('記憶摘要產生失敗，請確認 API 連線。', 'error');
    } finally {
        summaryRunning = false;
    }
}

async function maybeAutoSummarize() {
    try { await generateMemorySummary({ force: false }); } catch (error) { console.error('[墨藍藝廊] 自動摘要失敗', error); }
}

async function saveStatusBar(statusBar) {
    await saveChatMeta({ statusBar: statusBar ? normalizeStatusBar(statusBar) : null });
    applyMemoryInjection();
    refreshAll();
}

function buildStatusBarPrompt(statusBar) {
    const config = statusBar.config;
    const state = statusBar.state;
    const marker = statusBar.marker;
    const resourceCatalog = config.resources.map((item) => item.id + '=' + item.name + '(上限' + item.max + ')').join('；');
    const affinityCatalog = config.affinities.map((item) => item.id + '=' + item.name).join('；');
    return [
        '【' + config.title + '｜回合狀態更新規則】',
        '請依本回合實際完成的劇情更新狀態，不得虛構未發生的事件。',
        config.resourcePolicy.aiPrompt,
        '目前狀態：' + JSON.stringify({ fields: state.fields, affinities: state.affinities, resources: state.resources, memo: state.memo, lastButtonAction: state.lastAction }),
        resourceCatalog ? '合法資源 ID：' + resourceCatalog : '',
        affinityCatalog ? '好感角色 ID：' + affinityCatalog + '。好感值必須介於 0 與各角色上限之間。' : '',
        '回覆正文結束後，額外輸出以下 HTML 註解，不可包在程式碼區塊內，也不要解釋它：',
        '<!--' + marker,
        '{"fields":{"欄位id":"更新後的值"},"affinities":[{"id":"角色id","value":50}],"resources":[{"id":"資源id","value":0}],"memo":"待辦內容"}',
        '-->',
        'fields、affinities、resources 只需列本回合需要更新者；value 必須是更新後的絕對值，不是增減量。沒有變動時使用空物件或空陣列。',
        config.dynamicMessages.map((item) => item.rule).filter(Boolean).join('\n'),
        '若 lastButtonAction 已記錄物品使用，本回合不得對同一次動作再次扣除。HTML 註解不屬於故事正文。',
    ].filter(Boolean).join('\n');
}

function openStatusBarManager() {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context?.chatMetadata || !context.chatId || !layer) {
        notify('請先開啟一個聊天室。', 'warning');
        return;
    }
    const statusBar = getChatMeta(context).statusBar;
    const tavernHelperStatusBar = getTavernHelperStatusBar();
    const tavernHelperSummary = tavernHelperStatusBar ? [
        '<article class="mol-statusbar-manager-card tavern-helper"><div><strong>酒館助手渲染狀態欄</strong><small>已偵測到目前角色卡綁定的《大晏》狀態欄</small></div><span>' + (isTavernHelperStatusBarBridged() ? '已同步顯示' : '等待同步') + '</span></article>',
        '<p class="mol-dialog-hint">墨藍藝廊會直接承接酒館助手已啟用的渲染節點，按鈕、狀態更新與聊天變數仍由原角色腳本管理。</p>',
        '<div class="mol-panel-toolbar"><button class="primary" data-action="sync-tavern-helper-statusbar"><i class="fa-solid fa-arrows-rotate"></i> 重新偵測並顯示</button></div>',
    ].join('') : '';
    const summary = statusBar ? [
        '<article class="mol-statusbar-manager-card"><div><strong>' + escapeHtml(statusBar.name) + '</strong><small>' + statusBar.config.fields.length + ' 個欄位 · ' + statusBar.config.affinities.length + ' 名角色 · ' + statusBar.config.resources.length + ' 項資源</small></div><span>' + (statusBar.enabled ? '已啟用' : '已停用') + '</span></article>',
        '<p class="mol-dialog-hint">' + escapeHtml(statusBar.sourceInfo || '狀態與資源會依目前聊天室分別保存。') + '</p>',
        '<div class="mol-panel-toolbar"><button data-action="toggle-statusbar">' + (statusBar.enabled ? '停用狀態欄' : '啟用狀態欄') + '</button><button data-action="reset-statusbar">重置數值</button><button data-action="export-statusbar-state">匯出目前狀態</button><button data-action="remove-statusbar" class="danger">移除狀態欄</button></div>',
    ].join('') : (tavernHelperStatusBar ? '' : '<div class="mol-statusbar-import-empty"><i class="fa-solid fa-file-code"></i><strong>尚未偵測到狀態欄</strong><p>請先在酒館助手將角色腳本綁定至目前角色卡並啟用渲染；墨藍藝廊會自動把已渲染的狀態欄顯示在輸入框上方。也可使用下方 JSON 匯入器建立獨立狀態欄。</p></div>');
    layer.innerHTML = [
        '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">INTERACTIVE STATUS BAR</p><h3>互動狀態欄</h3>',
        tavernHelperSummary,
        summary,
        '<div class="mol-panel-toolbar mol-statusbar-import-actions"><button data-action="import-statusbar"><i class="fa-solid fa-file-import"></i> ' + (statusBar ? '重新匯入／替換 JSON' : '另行匯入 JSON（可選）') + '</button></div>',
        '<input id="mol-statusbar-import" type="file" accept=".json,application/json" hidden></div>',
    ].join('');
    layer.hidden = false;
    const input = layer.querySelector('#mol-statusbar-import');
    const onImport = async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > MAX_STATUSBAR_FILE_BYTES) {
            notify('狀態欄檔案不可超過 2 MB。', 'warning');
            input.value = '';
            return;
        }
        try {
            const parsed = JSON.parse(await file.text());
            const imported = parseStatusBarFile(parsed, file.name);
            await saveStatusBar(imported);
            notify('已讀取「' + imported.name + '」，並套用至目前聊天室。');
            openStatusBarManager();
        } catch (error) {
            console.error('[墨藍藝廊] 狀態欄匯入失敗', error);
            notify('匯入失敗：' + (error.message || '請選擇有效的酒館助手狀態欄 JSON。'), 'error');
        } finally {
            input.value = '';
        }
    };
    input.addEventListener('change', onImport);
    activeDialogCleanup = () => input.removeEventListener('change', onImport);
}

async function updateStatusBarState(mutator) {
    const statusBar = getChatMeta().statusBar;
    if (!statusBar) return;
    const next = normalizeStatusBar(statusBar);
    mutator(next.state, next);
    await saveStatusBar(next);
}

async function runStatusBarResourceAction(resourceId) {
    const statusBar = getChatMeta().statusBar;
    const resource = statusBar?.config.resources.find((item) => item.id === resourceId);
    if (!statusBar || !resource) return;
    const current = Number(statusBar.state.resources[resource.id]) || 0;
    if (current <= 0) {
        notify('目前沒有「' + resource.name + '」。', 'warning');
        return;
    }
    await updateStatusBarState((state, bar) => {
        const amount = bar.config.resourcePolicy.amount;
        state.resources[resource.id] = Math.max(0, current - amount);
        state.lastAction = { type: 'consume', id: resource.id, name: resource.name, amount, at: Date.now() };
    });
    notify('已使用「' + resource.name + '」，剩餘 ' + Math.max(0, current - statusBar.config.resourcePolicy.amount) + '。');
}

function statusBarMessageText(message) {
    return String(message?.mes ?? message?.message ?? '');
}

async function processStatusBarMessage(messageId) {
    const context = getContext();
    const statusBar = getChatMeta(context).statusBar;
    if (!statusBar?.enabled || !context?.chat?.length) return;
    const index = Number.isFinite(Number(messageId)) ? Number(messageId) : context.chat.length - 1;
    const message = context.chat[index] || context.chat.at(-1);
    const text = statusBarMessageText(message);
    const match = text.match(new RegExp('<!--\\s*' + statusBar.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*([\\s\\S]*?)-->', 'i'));
    if (!match) return;
    try {
        const update = JSON.parse(match[1].trim());
        await updateStatusBarState((state, bar) => {
            const fields = update.fields && typeof update.fields === 'object' ? update.fields : {};
            for (const item of bar.config.fields) {
                if (!Object.hasOwn(fields, item.id)) continue;
                const value = fields[item.id];
                state.fields[item.id] = Array.isArray(value) ? value.slice(0, 20).map(String) : (typeof value === 'number' ? value : String(value ?? '').slice(0, 1000));
            }
            for (const change of Array.isArray(update.affinities) ? update.affinities : []) {
                const item = bar.config.affinities.find((candidate) => candidate.id === change?.id || candidate.name === change?.name);
                if (item && Object.hasOwn(change, 'value')) state.affinities[item.id] = Math.max(0, Math.min(item.max, Number(change.value) || 0));
            }
            for (const change of Array.isArray(update.resources) ? update.resources : []) {
                const item = bar.config.resources.find((candidate) => candidate.id === change?.id || candidate.name === change?.name);
                if (item && Object.hasOwn(change, 'value')) state.resources[item.id] = Math.max(0, Math.min(item.max, Math.round(Number(change.value) || 0)));
            }
            if (typeof update.memo === 'string') state.memo = update.memo.trim().slice(0, 6000) || '目前沒有待辦事項';
            state.lastAction = null;
            if (Object.hasOwn(state.fields, 'page')) state.fields.page = Math.max(1, context.chat.filter((item) => !item.is_user && !item.is_system).length);
        });
    } catch (error) {
        console.error('[墨藍藝廊] 狀態欄回合資料解析失敗', error);
        notify('本回合狀態更新格式有誤，已保留原數值。', 'warning');
    }
}

async function exportChatTxt({ type, entityId, chatId }) {
    const context = getContext();
    if (!context || !chatId) return;
    const character = type === 'character' ? context.characters[Number(entityId)] : null;
    const filename = safeFilename(chatId, 'chat') + '.txt';
    const response = await fetch('/api/chats/export', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            is_group: type === 'group',
            avatar_url: character?.avatar,
            file: chatId + '.jsonl',
            exportfilename: filename,
            format: 'txt',
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.message || response.statusText || 'Export failed');
    downloadBlob(new Blob([String(data.result || '')], { type: 'text/plain;charset=utf-8' }), filename);
    notify('對話已匯出為 TXT。');
}

async function deleteChatEntry({ type, entityId, chatId }) {
    const context = getContext();
    if (!context || !chatId) return;
    manualGenerationPermitUntil = 0;
    disableGroupAutoMode();
    const isCurrent = String(context.chatId || '') === String(chatId)
        && ((type === 'group' && String(context.groupId) === String(entityId)) || (type === 'character' && String(context.characterId) === String(entityId)));
    if (type === 'group') {
        const api = await getGroupApi();
        if (isCurrent) await api.deleteGroupChat(entityId, chatId, { jumpToNewChat: true });
        else await api.deleteGroupChatByName(entityId, chatId);
    } else {
        const api = await getScriptApi();
        // 無論是否為目前聊天室，都以「角色 ID + 聊天檔名」精準刪除。
        // 避免建立新聊天室後刪除目前聊天室的流程影響同角色的其他對話。
        await api.deleteCharacterChatByName(Number(entityId), chatId);
        if (isCurrent) {
            enterInspectionMode({ stopActive: true });
            await getContext()?.reloadCurrentChat?.();
            applyMemoryInjection();
        }
    }
    disableGroupAutoMode();
    await loadChatEntries();
    refreshAll();
    notify('聊天室已刪除，並已從對話列表移除。');
}

function openUsagePanel() {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    if (!layer) return;
    const current = getChatMeta().usage;
    const all = getSettings().usageTotals;
    const last = current.last;
    const actual = last?.available;
    layer.innerHTML = [
        '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">ACTUAL API USAGE</p><h3>Token 與訊息統計</h3>',
        '<p class="mol-dialog-hint">只統計 API 供應商實際回傳的 usage；供應商未回傳時不使用前端估算值替代。</p>',
        '<div class="mol-usage-grid">',
        '<div><span>本次輸入 TOKEN</span><strong>' + (actual ? numberText(last.input) : '未提供') + '</strong></div>',
        '<div><span>本次模型回覆 TOKEN</span><strong>' + (actual ? numberText(last.output) : '未提供') + '</strong></div>',
        '<div><span>本次合計</span><strong>' + (actual ? numberText(last.total) : '未提供') + '</strong></div>',
        '<div><span>目前聊天累計</span><strong>' + numberText(current.total) + '</strong><small>輸入 ' + numberText(current.input) + ' · 回覆 ' + numberText(current.output) + '</small></div>',
        '<div><span>全部累計</span><strong>' + numberText(all.total) + '</strong><small>輸入 ' + numberText(all.input) + ' · 回覆 ' + numberText(all.output) + '</small></div>',
        '<div><span>真正送出訊息</span><strong>' + numberText(current.userMessages) + ' / ' + numberText(all.userMessages) + '</strong><small>目前聊天 / 全部累計</small></div>',
        '</div><p class="mol-dialog-hint">Swipe、續寫與只重新生成模型回覆，不會增加使用者訊息次數。</p>',
        '<div class="mol-dialog-actions"><button class="primary" data-action="close-dialog">完成</button></div></div>',
    ].join('');
    layer.hidden = false;
}

function openInternalPanel(kind) {
    if (kind === 'world-info') {
        openWorldInfoPanel();
        return;
    }
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context || !layer) return;
    let title = '';
    let eyebrow = 'MOLAN GALLERY';
    let content = '';
    if (kind === 'generation-settings') {
        title = '生成中心';
        eyebrow = 'GENERATION';
        let model = context.mainApi || 'Unknown';
        try { model = context.getChatCompletionModel?.() || model; } catch { /* use API name */ }
        const modelSelect = getModelSelect(context);
        const modelOptions = modelSelect
            ? Array.from(modelSelect.options).map((option) => '<option value="' + escapeHtml(option.value) + '"' + (option.selected ? ' selected' : '') + '>' + escapeHtml(option.textContent?.trim() || option.value) + '</option>').join('')
            : '';
        const presetManager = getChatCompletionPresetManager();
        const presetName = String(presetManager?.getSelectedPresetName?.() || '尚未選擇');
        content = [
            '<label class="mol-model-picker"><span>目前模型</span>',
            modelSelect ? '<select id="mol-model-select">' + modelOptions + '</select>' : '<strong>' + escapeHtml(model) + '</strong><small>目前 API 沒有可選模型清單。</small>',
            '</label>',
            '<div class="mol-info-grid">',
            '<div><span>MODEL</span><strong>' + escapeHtml(model) + '</strong></div>',
            '<div><span>API</span><strong>' + escapeHtml(context.mainApi || 'Unknown') + '</strong></div>',
            '<div><span>CONTEXT</span><strong>' + escapeHtml(context.maxContext || '—') + '</strong></div>',
            '<div><span>STATUS</span><strong>' + (isBusy ? 'Generating' : 'Ready') + '</strong></div>',
            '</div>',
            '<button class="mol-preset-entry" data-action="chat-presets"><span><strong>聊天補全預設設定檔</strong><small>' + escapeHtml(presetName) + '</small></span><i class="fa-solid fa-chevron-right"></i></button>',
            '<div class="mol-dialog-actions">',
            isBusy ? '<button class="primary" data-action="stop-generation">停止生成</button>' : '<button data-action="continue">續寫</button>',
            '<button data-action="usage-stats">查看 API 用量</button>',
            '<button data-action="close-dialog">關閉</button>',
            '</div>',
        ].join('');
    } else {
        title = '藝廊介面設定';
        eyebrow = 'INTERFACE';
        const settings = getSettings();
        content = [
            '<div class="mol-settings-list">',
            '<label><span><strong>啟動時自動開啟</strong><small>進入 SillyTavern 後顯示墨藍藝廊</small></span><input name="autoOpen" type="checkbox"' + (settings.autoOpen ? ' checked' : '') + '></label>',
            '<label><span><strong>緊湊訊息間距</strong><small>在同一畫面顯示更多訊息</small></span><input name="compactMessages" type="checkbox"' + (settings.compactMessages ? ' checked' : '') + '></label>',
            '<label class="mol-range-setting"><span><strong>介面字體大小</strong><small>調整按鈕、選單與標題文字</small></span><span><input name="interfaceFontSize" type="range" min="11" max="22" step="1" value="' + settings.interfaceFontSize + '"><output>' + settings.interfaceFontSize + ' px</output></span></label>',
            '<label class="mol-range-setting"><span><strong>聊天室訊息字體</strong><small>只調整對話正文，不影響介面</small></span><span><input name="messageFontSize" type="range" min="12" max="32" step="1" value="' + settings.messageFontSize + '"><output>' + settings.messageFontSize + ' px</output></span></label>',
            '</div>',
            '<p class="mol-dialog-hint">快捷鍵：Ctrl/Cmd + Shift + M</p>',
            '<div class="mol-dialog-actions"><button class="primary" data-action="close-dialog">完成</button></div>',
        ].join('');
    }
    layer.innerHTML = '<div class="mol-dialog mol-panel-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog" title="關閉">×</button><p class="mol-eyebrow">' + eyebrow + '</p><h3>' + title + '</h3>' + content + '</div>';
    layer.hidden = false;
    if (kind === 'generation-settings') {
        const modelSelect = layer.querySelector('#mol-model-select');
        const onModelChange = () => applyModelSelection(modelSelect.value);
        modelSelect?.addEventListener('change', onModelChange);
        activeDialogCleanup = () => modelSelect?.removeEventListener('change', onModelChange);
    } else if (kind === 'user-settings') {
        const settings = getSettings();
        const autoOpen = layer.querySelector('input[name="autoOpen"]');
        const compact = layer.querySelector('input[name="compactMessages"]');
        const interfaceFont = layer.querySelector('input[name="interfaceFontSize"]');
        const messageFont = layer.querySelector('input[name="messageFontSize"]');
        const save = () => context.saveSettingsDebounced();
        const onAutoOpen = () => { settings.autoOpen = autoOpen.checked; save(); };
        const onCompact = () => {
            settings.compactMessages = compact.checked;
            document.getElementById(ROOT_ID)?.classList.toggle('compact-messages', settings.compactMessages);
            save();
        };
        const onInterfaceFont = () => {
            settings.interfaceFontSize = clampFontSize(interfaceFont.value, 11, 22, DEFAULT_SETTINGS.interfaceFontSize);
            interfaceFont.nextElementSibling.value = settings.interfaceFontSize + ' px';
            applyTypographySettings();
            save();
        };
        const onMessageFont = () => {
            settings.messageFontSize = clampFontSize(messageFont.value, 12, 32, DEFAULT_SETTINGS.messageFontSize);
            messageFont.nextElementSibling.value = settings.messageFontSize + ' px';
            applyTypographySettings();
            save();
        };
        autoOpen.addEventListener('change', onAutoOpen);
        compact.addEventListener('change', onCompact);
        interfaceFont.addEventListener('input', onInterfaceFont);
        messageFont.addEventListener('input', onMessageFont);
        activeDialogCleanup = () => {
            autoOpen.removeEventListener('change', onAutoOpen);
            compact.removeEventListener('change', onCompact);
            interfaceFont.removeEventListener('input', onInterfaceFont);
            messageFont.removeEventListener('input', onMessageFont);
        };
    }
}

async function executeNewChat() {
    const context = getContext();
    if (!currentEntity(context)) {
        notify('請先選擇角色或群組。', 'warning');
        return;
    }
    enterInspectionMode({ stopActive: true });
    await context.executeSlashCommandsWithOptions('/newchat');
    notify('已建立新對話。');
    refreshAll();
}

async function regenerate() {
    if (isBusy) return;
    try {
        permitManualGeneration();
        isBusy = true;
        renderComposer();
        await getContext().generate('regenerate');
    } finally {
        isBusy = false;
        refreshAll();
    }
}

async function continueGeneration() {
    const context = getContext();
    if (!context?.chat?.length) {
        notify('目前沒有可續寫的訊息。', 'warning');
        return;
    }
    if (isBusy) return;
    try {
        permitManualGeneration();
        isBusy = true;
        renderComposer();
        await context.generate('continue');
    } finally {
        isBusy = false;
        refreshAll();
    }
}

async function handleComposerSubmit(event) {
    event.preventDefault();
    const context = getContext();
    if (isBusy) {
        context.stopGeneration();
        return;
    }
    const entity = currentEntity(context);
    if (!entity) {
        notify('請先選擇角色或群組。', 'warning');
        return;
    }
    const draft = document.getElementById('mol-draft');
    const text = draft.value.trim();
    if (!text && !attachmentName) return;
    const nativeTextarea = document.getElementById('send_textarea');
    const nativeSend = document.getElementById('send_but');
    if (!(nativeTextarea instanceof HTMLTextAreaElement) || !(nativeSend instanceof HTMLElement)) {
        notify('找不到 SillyTavern 原生傳送控制項。', 'error');
        return;
    }
    nativeTextarea.value = text;
    nativeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    permitManualGeneration(entity.type === 'group' ? 180000 : 60000);
    draft.value = '';
    attachmentName = '';
    renderComposer();
    nativeSend.click();
}

async function handleRootClick(event) {
    const filter = event.target.closest('[data-filter]');
    if (filter) {
        activeFilter = filter.dataset.filter;
        document.querySelectorAll('#' + ROOT_ID + ' [data-filter]').forEach((button) => button.classList.toggle('active', button === filter));
        const createGroupButton = document.getElementById('mol-create-group-button');
        if (createGroupButton) createGroupButton.hidden = activeFilter !== 'group';
        renderEntityList();
        return;
    }
    const chat = event.target.closest('[data-chat-type][data-chat-id].mol-chat-open');
    if (chat) {
        await selectChatEntry(chat.dataset.chatType, chat.dataset.entityId, chat.dataset.chatId);
        return;
    }
    const actionElement = event.target.closest('[data-action]');
    const action = actionElement?.dataset.action;
    if (!action) return;
    const context = getContext();
    switch (action) {
        case 'close': setOpen(false); break;
        case 'show-chats': sidebarOpen = !sidebarOpen; renderHeader(); break;
        case 'mobile-menu': sidebarOpen = !sidebarOpen; renderHeader(); break;
        case 'focus': focusMode = !focusMode; renderHeader(); break;
        case 'world-info': openInternalPanel('world-info'); break;
        case 'refresh-world-info': openInternalPanel('world-info'); break;
        case 'character-overview': openCharacterOverview(0, false); break;
        case 'player-profiles': await openPlayerProfilesPanel(); break;
        case 'refresh-player-profiles': await openPlayerProfilesPanel(); break;
        case 'new-player-profile': await openPlayerProfileEditor(); break;
        case 'edit-player-profile': await openPlayerProfileEditor(actionElement.dataset.playerAvatar || ''); break;
        case 'select-player-profile':
            try {
                await selectPlayerProfile(actionElement.dataset.playerAvatar || '');
                notify(context.chatId ? '玩家設定檔已套用並綁定目前聊天室。' : '玩家設定檔已套用。');
                await openPlayerProfilesPanel();
            } catch (error) {
                console.error('[墨藍藝廊] 套用玩家設定檔失敗', error);
                notify('無法套用玩家設定檔。', 'error');
            }
            break;
        case 'delete-player-profile': {
            const avatarId = actionElement.dataset.playerAvatar || '';
            const name = context.powerUserSettings?.personas?.[avatarId] || '未命名玩家';
            openConfirmDialog('刪除玩家設定檔', '確定刪除「' + name + '」？玩家頭像與 Persona 資料會一併移除，但既有聊天訊息不會刪除。', async () => {
                try {
                    await deletePlayerProfile(avatarId);
                    notify('玩家設定檔已刪除。');
                    await openPlayerProfilesPanel();
                } catch (error) {
                    console.error('[墨藍藝廊] 刪除玩家設定檔失敗', error);
                    notify('玩家設定檔刪除失敗。', 'error');
                }
                return false;
            });
            break;
        }
        case 'refresh-character-overview': await context.getCharacters(); openCharacterOverview(characterCarouselIndex, false); break;
        case 'toggle-character-flip':
            if (Date.now() < characterSwipeIgnoreUntil || characterCarouselTransitioning) break;
            if (window.getSelection?.()?.toString()) break;
            characterCarouselFlipped = !characterCarouselFlipped;
            {
                const flip = document.querySelector('#mol-dialog .mol-character-flip');
                flip?.classList.toggle('is-flipped', characterCarouselFlipped);
                const front = flip?.querySelector('.mol-character-front');
                const imageButton = flip?.querySelector('.mol-character-image-wrap');
                const back = flip?.querySelector('.mol-character-back');
                front?.setAttribute('aria-hidden', characterCarouselFlipped ? 'true' : 'false');
                imageButton?.setAttribute('tabindex', characterCarouselFlipped ? '-1' : '0');
                back?.setAttribute('aria-hidden', characterCarouselFlipped ? 'false' : 'true');
            }
            break;
        case 'character-carousel-go': {
            const targetIndex = Number(actionElement.dataset.characterIndex);
            changeCharacterOverview(targetIndex > characterCarouselIndex ? 1 : -1, targetIndex);
            break;
        }
        case 'new-character-card': await openCharacterEditor(); break;
        case 'import-character-card': document.getElementById('mol-character-import')?.click(); break;
        case 'view-character-card': openCharacterCard(actionElement.dataset.characterId); break;
        case 'edit-character-card': await openCharacterEditor(Number(actionElement.dataset.characterId)); break;
        case 'export-character-card':
            try { await exportCharacterCard(Number(actionElement.dataset.characterId), actionElement.dataset.format || 'png'); }
            catch (error) { console.error(error); notify('角色卡匯出失敗。', 'error'); }
            break;
        case 'delete-character-card': {
            const id = Number(actionElement.dataset.characterId);
            const character = context.characters[id];
            if (!character) break;
            openConfirmDialog('刪除角色卡', '將刪除「' + (character.name || '未命名角色') + '」及其全部聊天室。此操作無法復原。', async () => {
                const api = await getScriptApi();
                await api.deleteCharacter(character.avatar, { deleteChats: true });
                await context.getCharacters();
                await loadChatEntries();
                notify('角色卡已刪除。');
                openCharacterOverview();
                return false;
            });
            break;
        }
        case 'select-overview-character':
            closeDialog();
            await selectEntity('character', actionElement.dataset.characterId);
            break;
        case 'generation-settings': openInternalPanel('generation-settings'); break;
        case 'chat-presets': await openChatCompletionPresetsPanel(); break;
        case 'refresh-chat-presets': await openChatCompletionPresetsPanel(); break;
        case 'new-chat-preset': openNewChatCompletionPresetDialog(); break;
        case 'import-chat-preset': document.getElementById('mol-chat-preset-import')?.click(); break;
        case 'select-chat-preset': {
            const manager = getChatCompletionPresetManager();
            const name = actionElement.dataset.presetName || '';
            const value = manager?.findPreset?.(name);
            if (!manager || value === undefined || value === null) {
                notify('找不到指定的聊天補全預設。', 'error');
                break;
            }
            manager.selectPreset(value);
            notify('已切換聊天補全預設為「' + name + '」。');
            await openChatCompletionPresetsPanel();
            break;
        }
        case 'export-chat-preset': {
            const manager = getChatCompletionPresetManager();
            const name = actionElement.dataset.presetName || String(manager?.getSelectedPresetName?.() || '');
            const preset = chatCompletionPresetData(manager, name);
            if (!preset) {
                notify('無法讀取指定的聊天補全預設。', 'error');
                break;
            }
            preset.preset_name = name;
            downloadBlob(new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json;charset=utf-8' }), safeFilename(name, 'chat-completion-preset') + '.json');
            notify('聊天補全預設「' + name + '」已匯出。');
            break;
        }
        case 'usage-stats': openUsagePanel(); break;
        case 'memory-summary': openMemorySummaryPanel(); break;
        case 'statusbar-manager': openStatusBarManager(); break;
        case 'sync-tavern-helper-statusbar': {
            const synced = syncTavernHelperStatusBar();
            notify(synced ? '酒館助手狀態欄已顯示於墨藍藝廊。' : '尚未偵測到已啟用渲染的酒館助手狀態欄。', synced ? 'info' : 'warning');
            openStatusBarManager();
            break;
        }
        case 'import-statusbar': document.getElementById('mol-statusbar-import')?.click(); break;
        case 'statusbar-mode':
            await updateStatusBarState((state, statusBar) => {
                if (statusBar.config.modes.some((item) => item.id === actionElement.dataset.statusbarMode)) state.mode = actionElement.dataset.statusbarMode;
            });
            break;
        case 'statusbar-collapse': await updateStatusBarState((state) => { state.collapsed = !state.collapsed; }); break;
        case 'statusbar-consume': await runStatusBarResourceAction(actionElement.dataset.statusbarResource); break;
        case 'toggle-statusbar': {
            const statusBar = getChatMeta(context).statusBar;
            if (!statusBar) break;
            statusBar.enabled = !statusBar.enabled;
            statusBar.state.hidden = false;
            await saveStatusBar(statusBar);
            notify(statusBar.enabled ? '互動狀態欄已啟用。' : '互動狀態欄已停用。');
            openStatusBarManager();
            break;
        }
        case 'reset-statusbar': {
            const statusBar = getChatMeta(context).statusBar;
            if (!statusBar) break;
            openConfirmDialog('重置互動狀態欄', '確定將目前聊天室的狀態、好感度、資源與備忘錄恢復為匯入檔的初始值？', async () => {
                statusBar.state = createStatusBarState(statusBar.config);
                await saveStatusBar(statusBar);
                notify('互動狀態欄已重置。');
                openStatusBarManager();
                return false;
            });
            break;
        }
        case 'export-statusbar-state': {
            const statusBar = getChatMeta(context).statusBar;
            if (!statusBar) break;
            downloadBlob(new Blob([JSON.stringify({ name: statusBar.name, sourceId: statusBar.sourceId, state: statusBar.state }, null, 2)], { type: 'application/json;charset=utf-8' }), safeFilename(statusBar.name, 'interactive-statusbar') + '-state.json');
            notify('目前聊天室的狀態已匯出。');
            break;
        }
        case 'remove-statusbar': {
            const statusBar = getChatMeta(context).statusBar;
            if (!statusBar) break;
            openConfirmDialog('移除互動狀態欄', '確定移除「' + statusBar.name + '」？此操作只影響目前聊天室。', async () => {
                await saveStatusBar(null);
                notify('互動狀態欄已移除。');
                openStatusBarManager();
                return false;
            });
            break;
        }
        case 'user-settings': openInternalPanel('user-settings'); break;
        case 'stop-generation': context.stopGeneration(); closeDialog(); break;
        case 'new-chat': await executeNewChat(); break;
        case 'continue': closeDialog(); await continueGeneration(); break;
        case 'more': openMoreDialog(); break;
        case 'greeting-selector': openGreetingSelector(); break;
        case 'select-greeting':
            if (await switchGreeting(Number(actionElement.dataset.greetingIndex))) closeDialog();
            break;
        case 'close-dialog': closeDialog(); break;
        case 'import-world-info': document.getElementById('mol-world-import')?.click(); break;
        case 'new-world-book':
            openTextDialog({
                title: '新增世界書',
                label: '世界書名稱',
                submitText: '建立',
                onSubmit: async (value) => {
                    const name = value.trim();
                    if (!name) {
                        notify('請輸入世界書名稱。', 'warning');
                        return false;
                    }
                    const api = await getWorldInfoApi();
                    if ((context.getWorldInfoNames?.() || []).includes(name)) {
                        notify('已有同名世界書，請使用其他名稱。', 'warning');
                        return false;
                    }
                    const created = await api.createNewWorldInfo(name, { interactive: false });
                    if (!created) return false;
                    notify('世界書已建立。');
                    await openWorldBookPanel(name);
                    return false;
                },
            });
            break;
        case 'edit-world-book': await openWorldBookPanel(actionElement.dataset.book); break;
        case 'rename-world-book': {
            const oldName = actionElement.dataset.book;
            openTextDialog({
                title: '修改世界書名稱',
                label: '世界書新名稱',
                value: oldName,
                submitText: '儲存名稱',
                onSubmit: async (value) => {
                    try {
                        const renamed = await renameWorldBook(oldName, value);
                        if (!renamed) return false;
                        if (renamed !== oldName) notify('世界書已重新命名為「' + renamed + '」。');
                        await openWorldBookPanel(renamed);
                    } catch (error) {
                        console.error('[墨藍藝廊] 世界書重新命名失敗', error);
                        notify('世界書重新命名失敗，原資料仍會保留。', 'error');
                    }
                    return false;
                },
            });
            break;
        }
        case 'delete-world-book': {
            const name = actionElement.dataset.book;
            openConfirmDialog('刪除世界書', '確定刪除「' + name + '」？此操作無法復原。', async () => {
                const api = await getWorldInfoApi();
                await api.deleteWorldInfo(name);
                notify('世界書已刪除。');
                await openWorldInfoPanel();
                return false;
            });
            break;
        }
        case 'new-world-entry': await openWorldEntryEditor(actionElement.dataset.book); break;
        case 'edit-world-entry': await openWorldEntryEditor(actionElement.dataset.book, actionElement.dataset.uid); break;
        case 'delete-world-entry': {
            const name = actionElement.dataset.book;
            const uid = actionElement.dataset.uid;
            openConfirmDialog('刪除世界書條目', '確定刪除此條目？', async () => {
                const api = await getWorldInfoApi();
                const data = await api.loadWorldInfo(name);
                await api.deleteWorldInfoEntry(data, Number(uid), { silent: true });
                await api.saveWorldInfo(name, data, true);
                notify('條目已刪除。');
                await openWorldBookPanel(name);
                return false;
            });
            break;
        }
        case 'relationship': openRelationshipDialog(); break;
        case 'relationship-help': openRelationshipHelpDialog(); break;
        case 'create-group': await openCreateGroupDialog(); break;
        case 'group-members': await openGroupMembersPanel(); break;
        case 'generate-memory-summary': break;
        case 'clear-memory-summary': break;
        case 'rename-chat':
            openTextDialog({
                title: '重新命名對話',
                label: '新名稱',
                value: context.chatId || '',
                onSubmit: async (value) => {
                    const next = value.trim();
                    if (!next || next === context.chatId) return;
                    await context.renameChat(context.chatId, next);
                    notify('對話名稱已更新。');
                    refreshAll();
                    await loadChatEntries();
                },
            });
            break;
        case 'delete-last':
            if (!context.chat.length) {
                notify('目前沒有可刪除的訊息。', 'warning');
                break;
            }
            openConfirmDialog('刪除最後訊息', '此操作會修改目前聊天紀錄。', async () => {
                await context.deleteMessage(context.chat.length - 1, undefined, false);
                refreshAll();
            });
            break;
        case 'delete-chat':
            if (!context.chatId || !currentEntity(context)) {
                notify('目前沒有可刪除的聊天室。', 'warning');
                break;
            }
            openConfirmDialog('刪除目前聊天室', '將永久刪除目前聊天紀錄，並從墨藍藝廊的對話列表移除。', async () => {
                const entity = currentEntity(context);
                await deleteChatEntry({ type: entity.type, entityId: entity.id, chatId: context.chatId });
            });
            break;
        case 'export-current-chat': {
            const entity = currentEntity(context);
            if (!entity || !context.chatId) { notify('目前沒有可匯出的聊天室。', 'warning'); break; }
            try { await exportChatTxt({ type: entity.type, entityId: entity.id, chatId: context.chatId }); }
            catch (error) { console.error(error); notify('對話匯出失敗。', 'error'); }
            break;
        }
        case 'export-chat-entry':
            try { await exportChatTxt({ type: actionElement.dataset.chatType, entityId: actionElement.dataset.entityId, chatId: actionElement.dataset.chatId }); }
            catch (error) { console.error(error); notify('對話匯出失敗。', 'error'); }
            break;
        case 'delete-chat-entry': {
            const target = { type: actionElement.dataset.chatType, entityId: actionElement.dataset.entityId, chatId: actionElement.dataset.chatId };
            openConfirmDialog('刪除聊天室', '將永久刪除「' + target.chatId + '」，並從對話列表移除。', async () => {
                await deleteChatEntry(target);
            });
            break;
        }
        case 'edit-message': {
            const id = Number(actionElement.dataset.messageId);
            const message = context.chat[id];
            if (!message) break;
            openTextDialog({
                title: '編輯訊息 #' + id,
                label: '訊息內容',
                value: message.mes || '',
                multiline: true,
                onSubmit: async (value) => {
                    message.mes = value;
                    if (message.extra) delete message.extra.display_text;
                    await context.saveChat();
                    context.updateMessageBlock(id, message);
                    await context.eventSource.emit(getEventTypes(context).MESSAGE_EDITED, id);
                    refreshAll();
                },
            });
            break;
        }
        case 'delete-message': {
            const id = Number(actionElement.dataset.messageId);
            openConfirmDialog('刪除訊息 #' + id, '刪除後將直接寫入目前聊天紀錄。', async () => {
                await context.deleteMessage(id, undefined, false);
                refreshAll();
            });
            break;
        }
        case 'regenerate': await regenerate(); break;
        case 'attach': {
            const input = document.getElementById('file_form_input');
            if (input instanceof HTMLInputElement) input.click();
            else notify('目前版本未提供附件輸入。', 'warning');
            break;
        }
    }
}

function scheduleMessageRefresh() {
    window.clearTimeout(streamTimer);
    streamTimer = window.setTimeout(() => renderMessages({ preserveScroll: true }), 90);
}

function subscribe(type, handler) {
    if (!type) return;
    const context = getContext();
    context.eventSource.on(type, handler);
    subscribedEvents.push({ type, handler });
}

function subscribeToSillyTavern() {
    const context = getContext();
    const events = getEventTypes(context);
    const refresh = () => { if (isOpen) refreshAll(); };
    const refreshWithList = () => {
        applyMemoryInjection();
        if (isOpen) {
            refreshAll();
            loadChatEntries();
        }
    };
    const refreshMessages = () => { if (isOpen) { renderMessages(); refreshDetail(); } };
    subscribe(events.CHAT_CHANGED, refreshWithList);
    subscribe(events.CHAT_CREATED, refreshWithList);
    subscribe(events.CHAT_DELETED, refreshWithList);
    subscribe(events.GROUP_CHAT_DELETED, refreshWithList);
    subscribe(events.CHARACTER_EDITED, refreshWithList);
    subscribe(events.CHARACTER_DELETED, refreshWithList);
    subscribe(events.PERSONA_CHANGED, refresh);
    subscribe(events.PERSONA_CREATED, refresh);
    subscribe(events.PERSONA_UPDATED, refresh);
    subscribe(events.PERSONA_DELETED, refresh);
    subscribe(events.MESSAGE_SENT, async () => {
        try { await recordUserMessage(); } catch (error) { console.error('[墨藍藝廊] 記錄訊息次數失敗', error); }
        refreshMessages();
        setTimeout(() => { if (isOpen) loadChatEntries(); }, 500);
    });
    subscribe(events.MESSAGE_RECEIVED, (messageId) => { refreshMessages(); setTimeout(() => processStatusBarMessage(messageId), 120); setTimeout(maybeAutoSummarize, 250); });
    subscribe(events.MESSAGE_EDITED, (messageId) => { refreshMessages(); setTimeout(() => processStatusBarMessage(messageId), 120); });
    subscribe(events.MESSAGE_DELETED, refreshMessages);
    subscribe(events.MESSAGE_SWIPED, (messageId) => { refreshMessages(); setTimeout(() => processStatusBarMessage(messageId), 120); });
    subscribe(events.STREAM_TOKEN_RECEIVED, () => { if (isOpen) scheduleMessageRefresh(); });
    subscribe(events.GROUP_WRAPPER_STARTED, () => {
        groupReplyBatchActive = true;
        groupDraftOverLimit = false;
        groupReplyCounts.clear();
        permitManualGeneration(180000);
    });
    subscribe(events.GROUP_MEMBER_DRAFTED, (characterId) => {
        const character = getContext()?.characters?.[Number(characterId)];
        const key = String(character?.avatar || character?.name || characterId);
        const count = (groupReplyCounts.get(key) || 0) + 1;
        groupReplyCounts.set(key, count);
        groupDraftOverLimit = count > 2;
    });
    subscribe(events.GROUP_WRAPPER_FINISHED, () => {
        groupReplyBatchActive = false;
        groupDraftOverLimit = false;
        groupReplyCounts.clear();
        manualGenerationPermitUntil = 0;
        blockedGenerationUntil = 0;
        isBusy = false;
        if (isOpen) { refreshAll(); loadChatEntries(); }
    });
    subscribe(events.GENERATION_STARTED, (type, options, dryRun) => {
        const liveContext = getContext();
        currentGeneration = { type: String(type || 'normal'), chatId: String(liveContext?.chatId || ''), startedAt: Date.now() };
        if (dryRun) return;
        if (groupReplyBatchActive && groupDraftOverLimit) {
            blockedGenerationUntil = Date.now() + 10000;
            setTimeout(() => liveContext?.stopGeneration?.(), 0);
            return;
        }
        const hasExplicitUserAction = groupReplyBatchActive || Date.now() < manualGenerationPermitUntil;
        if (isOpen && !hasExplicitUserAction) {
            blockedGenerationUntil = Date.now() + 10000;
            manualGenerationPermitUntil = 0;
            isBusy = false;
            disableGroupAutoMode();
            renderComposer();
            // SillyTavern 在 GENERATION_STARTED 之後才建立 AbortController；延後才能真正中止。
            setTimeout(() => {
                if (Date.now() < blockedGenerationUntil) context.stopGeneration();
                isBusy = false;
                if (isOpen) renderComposer();
            }, 0);
            notify(options?.automatic_trigger ? '已關閉群組自動回覆；目前只開啟聊天室供檢視。' : '已阻止未經使用者操作的自動回覆。');
            return;
        }
        if (!isOpen) {
            isBusy = false;
            return;
        }
        if (!groupReplyBatchActive) manualGenerationPermitUntil = 0;
        blockedGenerationUntil = 0;
        isBusy = true;
        if (isOpen) renderComposer();
    });
    subscribe(events.GENERATION_AFTER_COMMANDS, (_type, _options, dryRun) => {
        if (dryRun || !isOpen || Date.now() >= blockedGenerationUntil) return;
        context.stopGeneration();
        isBusy = false;
        disableGroupAutoMode();
        renderComposer();
    });
    subscribe(events.GENERATION_ENDED, () => { if (!groupReplyBatchActive) manualGenerationPermitUntil = 0; blockedGenerationUntil = 0; isBusy = false; disableGroupAutoMode(); if (isOpen) { refreshAll(); loadChatEntries(); } setTimeout(maybeAutoSummarize, 250); });
    subscribe(events.GENERATION_STOPPED, () => { if (!groupReplyBatchActive) manualGenerationPermitUntil = 0; isBusy = false; disableGroupAutoMode(); if (isOpen) renderComposer(); });
    subscribe(events.CHATCOMPLETION_MODEL_CHANGED, refresh);
    subscribe(events.MAIN_API_CHANGED, refresh);
    subscribe(events.WORLDINFO_UPDATED, refresh);
    subscribe(events.WORLDINFO_SETTINGS_UPDATED, refresh);
}

function handleGlobalKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLocaleLowerCase() === 'm') {
        event.preventDefault();
        setOpen(!isOpen);
    } else if (event.key === 'Escape' && isOpen) {
        if (!document.getElementById('mol-dialog')?.hidden) closeDialog();
        else setOpen(false);
    }
}

function handleFileChange(event) {
    if (event.target?.id !== 'file_form_input') return;
    attachmentName = Array.from(event.target.files || []).map((file) => file.name).join(', ');
    if (isOpen) renderComposer();
}

function initialize() {
    console.info('[墨藍藝廊] 已載入版本 ' + BUILD_VERSION + '｜狀態欄位置：輸入框上方');
    createRoot();
    installViewportSync();
    installLauncher();
    installSettings();
    installUsageCapture();
    subscribeToSillyTavern();
    document.addEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('change', handleFileChange, true);
    if (getSettings().autoOpen) setOpen(true);
}

export function onActivate() {
    if (initialized) return;
    initialized = true;
    const context = getContext();
    if (!context) {
        initialized = false;
        return;
    }
    const events = getEventTypes(context);
    const ready = () => setTimeout(initialize, 0);
    context.eventSource.on(events.APP_READY, ready);
    subscribedEvents.push({ type: events.APP_READY, handler: ready });
}

export function onDisable() {
    const context = getContext();
    manualGenerationPermitUntil = 0;
    blockedGenerationUntil = 0;
    context?.setExtensionPrompt?.('molan_gallery_memory_summary', '', 0, 0, false, 0);
    context?.setExtensionPrompt?.('molan_gallery_creator_widget', '', 0, 0, false, 0);
    context?.setExtensionPrompt?.('molan_gallery_statusbar', '', 0, 0, false, 0);
    context?.setExtensionPrompt?.('molan_gallery_group_chat_rules', '', 0, 0, false, 0);
    window.clearTimeout(streamTimer);
    for (const { type, handler } of subscribedEvents.splice(0)) {
        if (type) context?.eventSource?.off?.(type, handler);
    }
    document.removeEventListener('keydown', handleGlobalKeydown);
    document.removeEventListener('change', handleFileChange, true);
    stopTavernHelperStatusBarBridge();
    removeViewportSync();
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(LAUNCHER_ID)?.remove();
    document.getElementById(SETTINGS_ID)?.remove();
    document.body.classList.remove('mol-gallery-open');
    restoreUsageCapture();
    initialized = false;
    isOpen = false;
}
