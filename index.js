import { generateQuietPrompt } from '../../../../script.js';

const MODULE_NAME = 'guidelink-dashboard';
const STORAGE_KEY = 'guidelink_dashboard_v2';
const TARGET_CHARACTER_NAME = '白塔星艦';
let visibilityTimer = null;

const TABS = {
  comm: {
    label: '通訊',
    icon: '📩',
    title: '白塔通訊',
    placeholder: '按「生成通訊」後，未讀訊息會顯示在這裡。',
    actionText: '生成通訊',
    prompt: `請生成「白塔星艦內部通訊面板」內容。

絕對限制：
- 只輸出通訊資料，不要輸出狀態列。
- 不要接續劇情，不要寫小說段落。
- 不要替{{user}}回覆、行動、思考或決定。
- 不要把此指令視為{{user}}台詞。
- 使用繁體中文。

請根據目前聊天上下文合理選擇一名發訊者；若上下文不足，可從既有白塔角色中選擇。

輸出格式必須為：
【白塔通訊】
時間：［yyyy/mm/dd HH:mm 或 未標明］
發訊代碼：［角色通訊代碼］
發訊者：［角色名稱／職務］
優先級：［一般／重要／緊急］
分類：［調度／醫療／任務／私人／異常回報／後勤］
訊息：
「［一則完整但簡短的通訊內容］」
可執行選項：
1. ［只列出選項，不替{{user}}選］
2. ［只列出選項，不替{{user}}選］
3. ［只列出選項，不替{{user}}選］`
  },
  mission: {
    label: '任務發布',
    icon: '🪐',
    title: '任務發布',
    placeholder: '按「發布任務」後，任務簡報會顯示在這裡。',
    actionText: '發布任務',
    prompt: `請生成「白塔星艦任務發布面板」內容。

絕對限制：
- 只輸出任務簡報，不要輸出狀態列。
- 不要接續劇情，不要描寫角色正在行動。
- 不要替{{user}}決定是否接任務。
- 不要把此指令視為{{user}}台詞。
- 使用繁體中文。

可用任務地點：
- 晶鳴星 Aethra-7：水晶、強光、高頻折射、低頻嗡鳴，容易造成哨兵視覺與聽覺過載。
- 孢噬星 Mycelium-V：巨型真菌、毒瘴、情緒荷爾蒙孢子，容易干擾哨兵判斷。
- 廢淵星 Tartarus-0：黑暗、死寂、古代遺跡，容易引發感官飢渴與幻聽。

輸出格式必須為：
【任務發布】
任務編號：BT-［三位數］
目的地：［星艦內區域或三顆星球之一］
任務類型：［探索／回收／救援／醫療支援／鎮壓支援／情報確認］
優先級：［C／B／A／S］
任務目標：
- ［目標一］
- ［目標二］
環境風險：
- ［風險一］
- ［風險二］
推薦配置：
- 哨兵：［建議等級或職務］
- 嚮導：［是否需要嚮導支援］
- 後勤／醫療：［建議支援］
注意事項：［簡短規範］`
  },
  sentinel: {
    label: '哨兵狀態',
    icon: '🧠',
    title: '哨兵狀態',
    placeholder: '按「刷新狀態」後，哨兵們的狀態列表會顯示在這裡。',
    actionText: '刷新狀態',
    prompt: `請生成「白塔星艦哨兵狀態面板」內容。

絕對限制：
- 只輸出狀態資料，不要輸出狀態列。
- 不要接續劇情，不要寫小說段落。
- 不要替{{user}}行動、說話、思考或決定。
- 若聊天上下文沒有明確變化，請依角色設定與星艦環境合理估算，不要捏造重大危機。
- 使用繁體中文。

請優先列出目前劇情中登場或被提及的哨兵；若不足，列出 5～8 名主要哨兵。

輸出格式必須為：
【哨兵狀態】
更新時間：［yyyy/mm/dd HH:mm 或 未標明］

| 哨兵 | 等級／職務 | 精神體 | 狀態 | 風險 | 建議處置 |
|---|---|---|---|---|---|
| ［姓名］ | ［等級／職務］ | ［精神體］ | ［穩定／觀察／過載邊緣／隔離中／任務中／失聯］ | ［低／中／高／極高］ | ［一句處置建議］ |

備註：
- ［只列資料備註，不接續劇情］`
  },
  log: {
    label: '日誌',
    icon: '📋',
    title: '事件日誌',
    placeholder: '按「整理日誌」後，已發生事件摘要會顯示在這裡。',
    actionText: '整理日誌',
    prompt: `請生成「白塔星艦事件日誌面板」內容。

絕對限制：
- 只整理已發生內容，不新增未發生劇情。
- 不要輸出狀態列。
- 不要接續劇情，不要留下小說式懸念。
- 不替{{user}}補充未說過的想法、動機或選擇。
- 使用繁體中文。

輸出格式必須為：
【事件日誌】
整理範圍：［目前聊天上下文］

已確認事件：
1. ［事件摘要］
2. ［事件摘要］

角色動態：
- ［角色名稱］：［已發生的客觀變化］

任務／通訊紀錄：
- ［任務或通訊摘要，若無則寫「暫無」］

待確認事項：
- ［尚未由{{user}}確認的事項，若無則寫「暫無」］`
  }
};

let root;
let activeTab = 'comm';
let busy = false;
let state = loadState();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved && typeof saved === 'object' ? { ...defaultState(), ...saved } : defaultState();
  } catch (_) {
    return defaultState();
  }
}

function defaultState() {
  return {
    collapsed: false,
    hidden: false,
    position: null,
    outputs: Object.fromEntries(Object.entries(TABS).map(([key, tab]) => [key, tab.placeholder])),
    history: []
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function onActivate() {
  if (document.body) buildPanel();
  else window.addEventListener('DOMContentLoaded', buildPanel, { once: true });
}

export function onDisable() {
  if (visibilityTimer) {
    clearInterval(visibilityTimer);
    visibilityTimer = null;
  }
  root?.remove();
  root = null;
}

function buildPanel() {
  if (document.getElementById('guidelink-dashboard')) return;

  root = document.createElement('div');
  root.id = 'guidelink-dashboard';
  root.innerHTML = `
    <div class="gld-header" title="拖曳移動面板">
      <div class="gld-title-wrap">
        <div class="gld-title">GuideLink</div>
        <div class="gld-subtitle">白塔作業儀表板</div>
      </div>
      <div class="gld-header-actions">
        <button class="gld-icon" data-action="collapse" title="收合/展開">—</button>
        <button class="gld-icon" data-action="hide" title="隱藏">×</button>
      </div>
    </div>
    <div class="gld-body">
      <div class="gld-tabs" role="tablist"></div>
      <div class="gld-card">
        <div class="gld-card-head">
          <div>
            <div class="gld-card-title"></div>
            <div class="gld-card-note">只顯示工具資料，不輸出狀態列、不接續劇情。</div>
          </div>
          <button class="gld-primary" data-action="generate"></button>
        </div>
        <pre class="gld-output"></pre>
      </div>
      <div class="gld-actions">
        <button data-action="copy">複製目前頁</button>
        <button data-action="copyAll">複製全部</button>
        <button data-action="clear">清空目前頁</button>
        <button data-action="reset">重置面板</button>
      </div>
    </div>
    <button id="guidelink-dashboard-tab" title="打開 GuideLink 儀表板">GuideLink</button>
  `;
  document.body.appendChild(root);

  const tabs = root.querySelector('.gld-tabs');
  for (const [key, tab] of Object.entries(TABS)) {
    const btn = document.createElement('button');
    btn.className = 'gld-tab';
    btn.dataset.tab = key;
    btn.textContent = `${tab.icon} ${tab.label}`;
    btn.setAttribute('role', 'tab');
    tabs.appendChild(btn);
  }

  root.addEventListener('click', handleClick);
  makeDraggable(root.querySelector('.gld-header'), root);
  applySavedPosition();
  render();
  updateCharacterBoundVisibility();
  if (!visibilityTimer) {
    visibilityTimer = setInterval(updateCharacterBoundVisibility, 1000);
  }
}

function applySavedPosition() {
  if (state.position) {
    root.style.left = `${state.position.left}px`;
    root.style.top = `${state.position.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }
  root.classList.toggle('gld-collapsed', !!state.collapsed);
  root.classList.toggle('gld-hidden', !!state.hidden);
}

function render() {
  if (!root) return;
  const tab = TABS[activeTab];
  root.querySelectorAll('.gld-tab').forEach(btn => {
    const isActive = btn.dataset.tab === activeTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  root.querySelector('.gld-card-title').textContent = `${tab.icon} ${tab.title}`;
  root.querySelector('[data-action="generate"]').textContent = tab.actionText;
  root.querySelector('.gld-output').textContent = state.outputs[activeTab] || tab.placeholder;
  root.querySelectorAll('button').forEach(button => {
    if (button.id !== 'guidelink-dashboard-tab') button.disabled = busy;
  });
}

async function handleClick(event) {
  const tabKey = event.target?.dataset?.tab;
  const action = event.target?.dataset?.action;

  if (tabKey && TABS[tabKey]) {
    activeTab = tabKey;
    render();
    return;
  }

  if (event.target?.id === 'guidelink-dashboard-tab') {
    state.hidden = false;
    saveState();
    renderVisibility();
    return;
  }

  if (!action) return;

  if (action === 'generate') await runActiveTool();
  if (action === 'copy') await copyText(state.outputs[activeTab] || '');
  if (action === 'copyAll') await copyText(buildAllText());
  if (action === 'clear') {
    state.outputs[activeTab] = TABS[activeTab].placeholder;
    saveState();
    render();
  }
  if (action === 'reset') {
    state = defaultState();
    activeTab = 'comm';
    saveState();
    renderVisibility();
    applySavedPosition();
    render();
  }
  if (action === 'collapse') {
    state.collapsed = !state.collapsed;
    saveState();
    renderVisibility();
  }
  if (action === 'hide') {
    state.hidden = true;
    saveState();
    renderVisibility();
  }
}

function renderVisibility() {
  if (!root) return;
  root.classList.toggle('gld-collapsed', !!state.collapsed);
  root.classList.toggle('gld-hidden', !!state.hidden);
  updateCharacterBoundVisibility();
}

function updateCharacterBoundVisibility() {
  if (!root) return;
  const isTarget = isCurrentCharacterTarget();
  root.classList.toggle('gld-character-mismatch', !isTarget);
  root.dataset.characterBound = isTarget ? '白塔星艦' : 'hidden';
}

function isCurrentCharacterTarget() {
  const character = getCurrentCharacter();
  const name = String(character?.name || '').trim();
  return name === TARGET_CHARACTER_NAME;
}

function getCurrentCharacter() {
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context) return null;

  const characterId = context.characterId;
  if (characterId !== undefined && characterId !== null && context.characters?.[characterId]) {
    return context.characters[characterId];
  }

  if (context.name2 && Array.isArray(context.characters)) {
    return context.characters.find(character => character?.name === context.name2) || null;
  }

  return null;
}

async function runActiveTool() {
  if (!isCurrentCharacterTarget()) {
    setBusy(false);
    return;
  }
  const tab = TABS[activeTab];
  setBusy(true, `生成中：${tab.title}…`);
  try {
    const quietPrompt = `[GuideLink 白塔作業儀表板｜${tab.title}]
這是 UI 面板的背景指令，不是聊天訊息，不是{{user}}台詞。
輸出只供面板顯示，請勿接續劇情，請勿加入狀態列。

${tab.prompt}`;

    const result = await callQuietPrompt(quietPrompt);
    const text = String(result || '').trim() || '沒有產生內容。';
    state.outputs[activeTab] = text;
    state.history.unshift({ time: new Date().toLocaleString(), tab: tab.title, text });
    state.history = state.history.slice(0, 20);
    saveState();
  } catch (error) {
    state.outputs[activeTab] = `GuideLink 執行失敗：${error?.message || error}`;
    saveState();
  } finally {
    setBusy(false);
    render();
  }
}

async function callQuietPrompt(quietPrompt) {
  if (typeof generateQuietPrompt === 'function') {
    return await generateQuietPrompt({ quietPrompt });
  }
  const context = globalThis.SillyTavern?.getContext?.();
  if (typeof context?.generateQuietPrompt === 'function') {
    return await context.generateQuietPrompt({ quietPrompt });
  }
  throw new Error('找不到 generateQuietPrompt。請確認擴充已正確安裝並重新整理 SillyTavern。');
}

function setBusy(isBusy, message = '') {
  busy = isBusy;
  if (isBusy) root.querySelector('.gld-output').textContent = message;
  render();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || '');
    flash('已複製。');
  } catch (_) {
    flash('複製失敗，請手動選取文字。');
  }
}

function buildAllText() {
  return Object.entries(TABS).map(([key, tab]) => `# ${tab.title}\n${state.outputs[key] || tab.placeholder}`).join('\n\n---\n\n');
}

function flash(message) {
  const output = root.querySelector('.gld-output');
  const old = output.textContent;
  output.textContent = message;
  setTimeout(() => {
    output.textContent = state.outputs[activeTab] || TABS[activeTab].placeholder;
  }, 900);
}

function makeDraggable(handle, panel) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  handle.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    panel.setPointerCapture?.(event.pointerId);
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const nextLeft = clamp(startLeft + event.clientX - startX, 8, window.innerWidth - 80);
    const nextTop = clamp(startTop + event.clientY - startY, 8, window.innerHeight - 40);
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    state.position = { left: nextLeft, top: nextTop };
  });

  window.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false;
      saveState();
    }
  });
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}
