const MODULE_NAME = 'molan_gallery';
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
const DEFAULT_SETTINGS = Object.freeze({
    autoOpen: false,
    compactMessages: false,
    usageTotals: structuredClone(EMPTY_USAGE),
});

let initialized = false;
let isOpen = false;
let isBusy = false;
let activeFilter = 'all';
let searchQuery = '';
let focusMode = false;
let sidebarOpen = false;
let detailOpen = false;
let streamTimer = 0;
let attachmentName = '';
let activeDialogCleanup = null;
let inspectionSwitchUntil = 0;
let currentGeneration = { type: '', chatId: '', startedAt: 0 };
let nativeFetch = null;
let fetchWrapper = null;
let worldInfoModulePromise = null;
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
    return context.extensionSettings[MODULE_NAME];
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

function avatarUrl(entity, context = getContext()) {
    if (!entity || !context) return '';
    try {
        if (entity.type === 'group') return entity.item.avatar_url || '';
        return context.getThumbnailUrl('avatar', entity.item.avatar);
    } catch {
        return '';
    }
}

function entityRole(entity) {
    if (!entity) return '尚未選擇';
    if (entity.type === 'group') return '群組對話';
    const data = entity.item.data || {};
    return truncate(data.creator_notes || data.personality || entity.item.creator_notes || '角色', 22);
}

function getChatMeta(context = getContext()) {
    const defaults = { relationship: 50, memory: '', usage: structuredClone(EMPTY_USAGE) };
    const stored = context?.chatMetadata?.[MODULE_NAME];
    if (!stored || typeof stored !== 'object') return defaults;
    return {
        relationship: Number.isFinite(Number(stored.relationship)) ? Number(stored.relationship) : 50,
        memory: typeof stored.memory === 'string' ? stored.memory : '',
        usage: normalizeUsage(stored.usage),
    };
}

async function saveChatMeta(patch) {
    const context = getContext();
    if (!context?.chatMetadata) return;
    context.chatMetadata[MODULE_NAME] = { ...getChatMeta(context), ...patch };
    await context.saveMetadata();
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

function createRoot() {
    if (document.getElementById(ROOT_ID)) return;
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.hidden = true;
    root.innerHTML = [
        '<aside class="mol-rail" aria-label="主要導覽">',
        '  <button class="mol-brand" data-action="close" title="關閉墨藍藝廊"><span>T</span></button>',
        '  <nav>',
        '    <button class="mol-rail-button active" data-action="show-chats" title="對話"><i class="fa-solid fa-pen-nib"></i></button>',
        '    <button class="mol-rail-button" data-action="character-overview" title="角色總覽"><i class="fa-solid fa-address-card"></i></button>',
        '    <button class="mol-rail-button" data-action="world-info" title="世界書"><i class="fa-solid fa-book-atlas"></i></button>',
        '    <button class="mol-rail-button" data-action="continue" title="續寫"><i class="fa-solid fa-wand-magic-sparkles"></i></button>',
        '  </nav>',
        '  <div class="mol-rail-bottom"><button class="mol-profile-dot" data-action="user-settings" title="使用者設定">U</button></div>',
        '</aside>',
        '<aside class="mol-chat-list" aria-label="角色與群組列表">',
        '  <div class="mol-list-heading"><div><p class="mol-eyebrow">COLLECTION</p><h1>對話</h1></div><button class="mol-icon-button" data-action="new-chat" title="建立新對話"><i class="fa-solid fa-plus"></i></button></div>',
        '  <label class="mol-search"><i class="fa-solid fa-magnifying-glass"></i><input id="mol-search-input" type="search" placeholder="搜尋角色、群組…" aria-label="搜尋角色與群組"></label>',
        '  <div class="mol-filters">',
        '    <button data-filter="all" class="active">全部</button>',
        '    <button data-filter="favorite">收藏</button>',
        '    <button data-filter="group">群組</button>',
        '  </div>',
        '  <div id="mol-entity-list" class="mol-entity-list"></div>',
        '  <div class="mol-list-note"><span>ISSUE 01</span><p>每一次對話，都是尚未裝框的作品。</p></div>',
        '</aside>',
        '<section class="mol-conversation">',
        '  <header class="mol-header">',
        '    <div class="mol-title"><button class="mol-mobile-menu" data-action="mobile-menu" title="顯示對話列表"><i class="fa-solid fa-bars"></i></button><div id="mol-header-avatar" class="mol-avatar small"></div><div><strong id="mol-current-name">尚未選擇角色</strong><span id="mol-current-role">請從左側選擇</span></div></div>',
        '    <div class="mol-header-actions">',
        '      <button class="mol-text-button" data-action="focus"><i class="fa-regular fa-eye"></i><span>專注</span></button>',
        '      <button class="mol-icon-button" data-action="toggle-detail" title="角色資訊"><i class="fa-solid fa-sliders"></i></button>',
        '      <button class="mol-icon-button" data-action="more" title="對話選項"><i class="fa-solid fa-ellipsis"></i></button>',
        '    </div>',
        '  </header>',
        '  <div class="mol-chapter"><span>LIVE CHAT</span><i></i><span id="mol-chat-name">尚未開啟對話</span></div>',
        '  <div id="mol-messages" class="mol-messages" aria-live="polite"></div>',
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
        '  <button class="mol-stat-row" data-action="relationship" title="調整關係值"><span>關係</span><span class="mol-stat-bar"><i id="mol-relationship-bar"></i></span><strong id="mol-relationship">50</strong></button>',
        '  <div class="mol-context-list">',
        '    <button data-action="world-info"><span class="mol-context-icon"><i class="fa-solid fa-book-atlas"></i></span><span><strong>世界書</strong><small id="mol-world-count">在藝廊內查看</small></span><i class="fa-solid fa-chevron-right"></i></button>',
        '    <button data-action="memory"><span class="mol-context-icon"><i class="fa-solid fa-leaf"></i></span><span><strong>重要記憶</strong><small id="mol-memory-summary">尚未記錄</small></span><i class="fa-solid fa-chevron-right"></i></button>',
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
        '<button id="mol-open-settings" class="menu_button">開啟墨藍藝廊</button>',
        '<small>快捷鍵：Ctrl/Cmd + Shift + M</small>',
        '</div></div>',
    ].join('');
    host.append(block);
    const settings = getSettings();
    block.querySelector('#mol-auto-open').checked = Boolean(settings.autoOpen);
    block.querySelector('#mol-compact-messages').checked = Boolean(settings.compactMessages);
    block.querySelector('#mol-auto-open').addEventListener('change', (event) => {
        settings.autoOpen = event.currentTarget.checked;
        getContext().saveSettingsDebounced();
    });
    block.querySelector('#mol-compact-messages').addEventListener('change', (event) => {
        settings.compactMessages = event.currentTarget.checked;
        document.getElementById(ROOT_ID)?.classList.toggle('compact-messages', settings.compactMessages);
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
        root.classList.toggle('compact-messages', Boolean(getSettings().compactMessages));
        refreshAll();
        setTimeout(() => root.querySelector('#mol-draft')?.focus(), 0);
    } else {
        closeDialog();
    }
}

function getEntities(context = getContext()) {
    if (!context) return [];
    const characters = context.characters.map((item, index) => ({
        type: 'character',
        id: index,
        item,
        name: item.name || item.data?.name || '未命名角色',
        favorite: item.fav === true || item.fav === 'true' || item.data?.extensions?.fav === true,
        chatName: item.chat || '尚無對話',
    }));
    const groups = context.groups.map((item) => ({
        type: 'group',
        id: item.id,
        item,
        name: item.name || '未命名群組',
        favorite: Boolean(item.fav),
        chatName: item.chat_id || '尚無對話',
    }));
    return [...characters, ...groups]
        .filter((entry) => activeFilter === 'all' || (activeFilter === 'favorite' && entry.favorite) || (activeFilter === 'group' && entry.type === 'group'))
        .filter((entry) => !searchQuery || (entry.name + ' ' + entry.chatName).toLocaleLowerCase().includes(searchQuery));
}

function renderEntityList() {
    const context = getContext();
    const host = document.getElementById('mol-entity-list');
    if (!context || !host) return;
    const current = currentEntity(context);
    const entries = getEntities(context);
    if (!entries.length) {
        host.innerHTML = '<div class="mol-empty">沒有符合條件的角色或群組。</div>';
        return;
    }
    host.innerHTML = entries.map((entry) => {
        const entity = { type: entry.type, item: entry.item, id: entry.id };
        const url = avatarUrl(entity, context);
        const active = current && current.type === entry.type && String(current.id) === String(entry.id);
        const avatar = url
            ? '<img src="' + escapeHtml(url) + '" alt="">'
            : '<span>' + escapeHtml(initials(entry.name)) + '</span>';
        return [
            '<button class="mol-chat-card' + (active ? ' active' : '') + '" data-entity-type="' + entry.type + '" data-entity-id="' + escapeHtml(entry.id) + '">',
            '<span class="mol-avatar">' + avatar + '</span>',
            '<span class="mol-chat-copy"><span class="mol-chat-line"><strong>' + escapeHtml(entry.name) + '</strong><small>' + (entry.favorite ? '★' : '') + '</small></span>',
            '<span class="mol-role">' + (entry.type === 'group' ? 'GROUP' : 'CHARACTER') + '</span>',
            '<span class="mol-preview">' + escapeHtml(entry.chatName) + '</span></span>',
            '</button>',
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
    document.getElementById(ROOT_ID)?.classList.toggle('detail-open', detailOpen);
    const focusButton = document.querySelector('#' + ROOT_ID + ' [data-action="focus"]');
    focusButton?.classList.toggle('active', focusMode);
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
            const bookmarkActive = Boolean(message.extra?.bookmark_link);
            return [
                '<article class="mol-message' + side + '" data-message-id="' + index + '">',
                '<div class="mol-message-meta"><strong>' + escapeHtml(message.name || (message.is_user ? context.name1 : context.name2)) + '</strong><span>#' + index + '</span></div>',
                '<div class="mol-message-text">' + formattedMessage(message, index, context) + '</div>',
                '<div class="mol-message-tools">',
                '<button data-action="edit-message" data-message-id="' + index + '">編輯</button>',
                isLastCharacter ? '<button data-action="regenerate">重試</button>' : '',
                '<button data-action="bookmark-message" data-message-id="' + index + '">' + (bookmarkActive ? '已收藏' : '收藏') + '</button>',
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
    const url = avatarUrl(entity, context);
    const art = document.getElementById('mol-art-card');
    if (art) {
        art.innerHTML = [
            '<span class="mol-art-index">NO. ' + String(context.chat?.length || 0).padStart(2, '0') + '</span>',
            '<div class="mol-portrait">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span>' + escapeHtml(initials(name)) + '</span>') + '<i class="one"></i><i class="two"></i></div>',
            '<p>THE CURATOR<br>OF BLUE HOURS</p>',
        ].join('');
    }
    document.getElementById('mol-profile-name').textContent = name;
    document.getElementById('mol-profile-note').textContent = profile;
    const status = document.getElementById('mol-status');
    status.textContent = entity ? 'ACTIVE' : 'IDLE';
    status.classList.toggle('inactive', !entity);
    const meta = getChatMeta(context);
    document.getElementById('mol-relationship').textContent = String(meta.relationship);
    document.getElementById('mol-relationship-bar').style.width = Math.max(0, Math.min(100, meta.relationship)) + '%';
    document.getElementById('mol-memory-summary').textContent = meta.memory ? truncate(meta.memory, 28) : '尚未記錄';
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
    renderComposer();
    refreshDetail();
}

async function selectEntity(type, id) {
    const context = getContext();
    if (!context) return;
    try {
        inspectionSwitchUntil = Date.now() + 2000;
        if (type === 'group') {
            const group = context.groups.find((item) => String(item.id) === String(id));
            if (!group?.chat_id) {
                notify('這個群組尚未有可開啟的對話。', 'warning');
                return;
            }
            await context.openGroupChat(group.id, group.chat_id);
        } else {
            await context.selectCharacterById(Number(id), { switchMenu: false });
        }
        sidebarOpen = false;
        refreshAll();
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

function openMoreDialog() {
    closeDialog();
    const layer = document.getElementById('mol-dialog');
    layer.innerHTML = [
        '<div class="mol-dialog mol-action-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHAT ACTIONS</p><h3>對話選項</h3>',
        '<button data-action="rename-chat"><i class="fa-solid fa-pen"></i><span>重新命名對話</span></button>',
        '<button data-action="delete-last"><i class="fa-solid fa-trash"></i><span>刪除最後訊息</span></button>',
        '<button data-action="delete-chat" class="danger"><i class="fa-solid fa-trash-can"></i><span>刪除目前聊天室</span></button>',
        '<button data-action="user-settings"><i class="fa-solid fa-palette"></i><span>藝廊介面設定</span></button>',
        '</div>',
    ].join('');
    layer.hidden = false;
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
            '<div class="mol-panel-toolbar"><button data-action="world-info"><i class="fa-solid fa-arrow-left"></i> 返回</button><button class="primary" data-action="new-world-entry" data-book="' + escapeHtml(name) + '"><i class="fa-solid fa-plus"></i> 新增條目</button></div>',
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

function openCharacterOverview() {
    closeDialog();
    const context = getContext();
    const layer = document.getElementById('mol-dialog');
    if (!context || !layer) return;
    const cards = context.characters.map((character, id) => {
        const entity = { type: 'character', item: character, id };
        const url = avatarUrl(entity, context);
        const description = character.data?.description || character.description || character.data?.personality || '尚未填寫角色簡介。';
        return '<article class="mol-character-card"><div class="mol-avatar">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span>' + escapeHtml(initials(character.name)) + '</span>') + '</div><div><strong>' + escapeHtml(character.name || '未命名角色') + '</strong><small>' + escapeHtml(truncate(description, 82)) + '</small></div><button data-action="view-character-card" data-character-id="' + id + '">查看</button><button class="primary" data-action="select-overview-character" data-character-id="' + id + '">進入聊天室</button></article>';
    }).join('');
    layer.innerHTML = '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHARACTER ARCHIVE</p><h3>角色總覽</h3><div class="mol-character-grid">' + (cards || '<p class="mol-dialog-copy">目前沒有角色。</p>') + '</div></div>';
    layer.hidden = false;
}

function openCharacterCard(id) {
    const context = getContext();
    const character = context?.characters?.[Number(id)];
    const layer = document.getElementById('mol-dialog');
    if (!character || !layer) return;
    const data = character.data || {};
    const field = (label, value) => '<section><span>' + label + '</span><p>' + escapeHtml(value || '—').replaceAll('\n', '<br>') + '</p></section>';
    layer.innerHTML = '<div class="mol-dialog mol-panel-dialog mol-wide-dialog"><button type="button" class="mol-dialog-close" data-action="close-dialog">×</button><p class="mol-eyebrow">CHARACTER CARD</p><h3>' + escapeHtml(character.name || data.name || '未命名角色') + '</h3><div class="mol-character-detail">' + field('DESCRIPTION', data.description || character.description) + field('PERSONALITY', data.personality) + field('SCENARIO', data.scenario) + field('CREATOR NOTES', data.creator_notes || character.creator_notes) + '</div><div class="mol-dialog-actions"><button data-action="character-overview">返回總覽</button><button class="primary" data-action="select-overview-character" data-character-id="' + Number(id) + '">進入聊天室</button></div></div>';
    layer.hidden = false;
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
        const save = () => context.saveSettingsDebounced();
        const onAutoOpen = () => { settings.autoOpen = autoOpen.checked; save(); };
        const onCompact = () => {
            settings.compactMessages = compact.checked;
            document.getElementById(ROOT_ID)?.classList.toggle('compact-messages', settings.compactMessages);
            save();
        };
        autoOpen.addEventListener('change', onAutoOpen);
        compact.addEventListener('change', onCompact);
        activeDialogCleanup = () => {
            autoOpen.removeEventListener('change', onAutoOpen);
            compact.removeEventListener('change', onCompact);
        };
    }
}

async function executeNewChat() {
    const context = getContext();
    if (!currentEntity(context)) {
        notify('請先選擇角色或群組。', 'warning');
        return;
    }
    await context.executeSlashCommandsWithOptions('/newchat');
    notify('已建立新對話。');
    refreshAll();
}

async function regenerate() {
    if (isBusy) return;
    try {
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
    if (!currentEntity(context)) {
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
        renderEntityList();
        return;
    }
    const entity = event.target.closest('[data-entity-type]');
    if (entity) {
        await selectEntity(entity.dataset.entityType, entity.dataset.entityId);
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
        case 'toggle-detail': detailOpen = !detailOpen; renderHeader(); break;
        case 'focus': focusMode = !focusMode; renderHeader(); break;
        case 'world-info': openInternalPanel('world-info'); break;
        case 'refresh-world-info': openInternalPanel('world-info'); break;
        case 'character-overview': openCharacterOverview(); break;
        case 'view-character-card': openCharacterCard(actionElement.dataset.characterId); break;
        case 'select-overview-character':
            closeDialog();
            await selectEntity('character', actionElement.dataset.characterId);
            break;
        case 'generation-settings': openInternalPanel('generation-settings'); break;
        case 'usage-stats': openUsagePanel(); break;
        case 'user-settings': openInternalPanel('user-settings'); break;
        case 'stop-generation': context.stopGeneration(); closeDialog(); break;
        case 'new-chat': await executeNewChat(); break;
        case 'continue': closeDialog(); await continueGeneration(); break;
        case 'more': openMoreDialog(); break;
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
        case 'memory':
            openTextDialog({
                title: '重要記憶',
                label: '此內容只屬於目前聊天室',
                value: getChatMeta().memory,
                multiline: true,
                onSubmit: async (value) => saveChatMeta({ memory: value.trim() }),
            });
            break;
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
            if (!context.chatId) {
                notify('目前沒有可刪除的聊天室。', 'warning');
                break;
            }
            openConfirmDialog('刪除目前聊天室', '將永久刪除目前聊天紀錄，並建立一個新的空白對話。', async () => {
                const { doNewChat } = await import('/script.js');
                await doNewChat({ deleteCurrentChat: true });
                notify('聊天室已刪除，已建立新的空白對話。');
                refreshAll();
            });
            break;
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
        case 'bookmark-message': {
            const id = Number(actionElement.dataset.messageId);
            await context.executeSlashCommandsWithOptions('/checkpoint-create mesId=' + id);
            notify('已將訊息建立為 Checkpoint。');
            refreshAll();
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
    const refreshMessages = () => { if (isOpen) { renderMessages(); refreshDetail(); } };
    subscribe(events.CHAT_CHANGED, refresh);
    subscribe(events.CHAT_CREATED, refresh);
    subscribe(events.CHAT_DELETED, refresh);
    subscribe(events.CHARACTER_EDITED, refresh);
    subscribe(events.CHARACTER_DELETED, refresh);
    subscribe(events.PERSONA_CHANGED, refresh);
    subscribe(events.MESSAGE_SENT, async () => {
        try { await recordUserMessage(); } catch (error) { console.error('[墨藍藝廊] 記錄訊息次數失敗', error); }
        refreshMessages();
    });
    subscribe(events.MESSAGE_RECEIVED, refreshMessages);
    subscribe(events.MESSAGE_EDITED, refreshMessages);
    subscribe(events.MESSAGE_DELETED, refreshMessages);
    subscribe(events.MESSAGE_SWIPED, refreshMessages);
    subscribe(events.STREAM_TOKEN_RECEIVED, () => { if (isOpen) scheduleMessageRefresh(); });
    subscribe(events.GENERATION_STARTED, (type, options, dryRun) => {
        currentGeneration = { type: String(type || 'normal'), chatId: String(context.chatId || ''), startedAt: Date.now() };
        if (!dryRun && Date.now() < inspectionSwitchUntil && options?.automatic_trigger === true) {
            context.stopGeneration();
            notify('已阻止自動生成；目前只開啟聊天室供檢視。');
            return;
        }
        isBusy = true;
        if (isOpen) renderComposer();
    });
    subscribe(events.GENERATION_ENDED, () => { isBusy = false; if (isOpen) refreshAll(); });
    subscribe(events.GENERATION_STOPPED, () => { isBusy = false; if (isOpen) refreshAll(); });
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
    createRoot();
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
    window.clearTimeout(streamTimer);
    for (const { type, handler } of subscribedEvents.splice(0)) {
        if (type) context?.eventSource?.off?.(type, handler);
    }
    document.removeEventListener('keydown', handleGlobalKeydown);
    document.removeEventListener('change', handleFileChange, true);
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(LAUNCHER_ID)?.remove();
    document.getElementById(SETTINGS_ID)?.remove();
    document.body.classList.remove('mol-gallery-open');
    restoreUsageCapture();
    initialized = false;
    isOpen = false;
}
