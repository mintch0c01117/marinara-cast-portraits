// 출연진 초상화: fixed portraits, full-body sprites and appearance tags for game NPCs, without character cards.
// Runs as a full-page personal extension; `marinara` is the host API.

const ROOT_ID = "malu-cast";
// drawer: the 🎭 button is its own element directly in <body>, so 확장 서랍 can hold it apart from the panel.
const LAUNCHER_ID = "malu-cast-launcher";
const DRAWER_ROOT_ID = "exd-panel-root";
const DRAWER_PICK_SELECTOR = ".exd-pick-hint";
const DRAWER_GRACE_MS = 5000;
const ASSET_DIR = "cast";
const ACTIVE_CHAT_KEY = "marinara-active-chat-id";
const POLL_MS = 6000;
const SPEAKER_LINE = /^\[([^\]\n]{1,60})\]\s*\[/gm;
// `[Name] [type] [expression]: text`, or `[Name] [expression]: text` when the model drops the type.
const DIALOGUE_LINE = /^\s*\[([^\]\n]{1,60})\]\s*\[([^\]\n]+)\](?:\s*\[([^\]\n]+)\])?\s*:\s*(.+)$/;
const TYPE_TAG = /^(main|side|extra|action|thought|react|whisper(:.*)?)$/i;
const SPOKEN_FETCH_GAP_MS = 1500;
// The expression tags the Game Master is told to use by default (suggested in the emotion name field).
const DEFAULT_EXPRESSIONS = [
  "neutral", "happy", "sad", "angry", "surprised", "smirk", "worried", "amused", "disgusted", "flirty",
  "bored", "scared", "determined", "mischievous", "cold", "tender", "thinking", "eye_roll", "deadpan",
];

const DEFAULT_SETTINGS = { auto: true, sprite: true, side: "right", height: 70, button: "top-left" };

// Casts are kept in sets (one per setting/world); each chat remembers its set, and `cast` is the open set's list.
let sets = [];
let chatSets = {};
let lastSet = "";
let currentSetId = "";
let cast = [];
let settings = { ...DEFAULT_SETTINGS };
let applied = {};
let disposed = false;

// ── API ──

function headers(json = true) {
  const out = { "x-marinara-csrf": "1" };
  if (json) out["Content-Type"] = "application/json";
  try {
    const secret = localStorage.getItem("marinara_admin_secret")?.trim();
    if (secret) out["X-Admin-Secret"] = secret;
  } catch {}
  return out;
}

async function api(path, init = {}) {
  const method = init.method ?? "GET";
  const response = await marinara.fetch(`/api${path}`, {
    ...init,
    headers: method === "GET" ? headers(false) : headers(),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json()).error ?? "";
    } catch {}
    throw new Error(`${method} ${path} → ${response.status} ${detail}`.trim());
  }
  return response.status === 204 ? null : response.json();
}

function assetUrl(path) {
  return `/api/game-assets/file/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function assetAsDataUrl(path) {
  const response = await marinara.fetch(assetUrl(path));
  if (!response.ok) throw new Error(`이미지를 읽지 못했습니다: ${path}`);
  return readFileAsDataUrl(await response.blob());
}

async function uploadAsset(file, entryId, kind) {
  const ext = (file.name.match(/\.(png|jpe?g|webp|gif|avif)$/i)?.[1] ?? "png").toLowerCase();
  return uploadDataUrl(await readFileAsDataUrl(file), entryId, kind, ext);
}

async function uploadDataUrl(data, entryId, kind, ext = "png") {
  const result = await api("/game-assets/upload", {
    method: "POST",
    body: JSON.stringify({
      category: "sprites",
      subcategory: ASSET_DIR,
      filename: `${entryId}-${kind}-${Date.now().toString(36)}.${ext}`,
      data,
    }),
  });
  return result.path;
}

// A file another set still uses (a JSON imported without images keeps the same paths) is left alone.
async function deleteAssets(paths) {
  const used = new Set(sets.flatMap((set) => (set.id === currentSetId ? cast : set.cast)).flatMap(assetsOf));
  const list = paths.filter((path) => path && !used.has(path));
  if (!list.length) return;
  try {
    await api("/game-assets/delete-bulk", { method: "POST", body: JSON.stringify({ paths: list }) });
  } catch (error) {
    marinara.log.warn("old image not removed", error);
  }
}

function activeChatId() {
  try {
    return localStorage.getItem(ACTIVE_CHAT_KEY) || null;
  } catch {
    return null;
  }
}

// ── Name matching ──

function norm(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s'"`·・.,_\-「」『』]/g, "");
}

function aliasesOf(entry) {
  return entry.names
    .split(/[,，\n]/)
    .map(norm)
    .filter(Boolean);
}

// "세이버 (네로)" or "세이버/네로" also count as each of their parts.
function nameTokens(name) {
  const tokens = new Set([norm(name)]);
  for (const part of String(name ?? "").split(/[/()（）\[\]|]/)) {
    const token = norm(part);
    if (token) tokens.add(token);
  }
  tokens.delete("");
  return tokens;
}

function findEntry(name) {
  if (!name) return null;
  const tokens = nameTokens(name);
  for (const entry of cast) {
    if (aliasesOf(entry).some((alias) => tokens.has(alias))) return entry;
  }
  return null;
}

// ── Expression matching ──

function emotionKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

// An exact tag wins; otherwise a part of a compound tag ("happy_tears" → "happy") is enough.
function emotionFor(entry, expression) {
  const want = emotionKey(expression);
  if (!want || !entry.emotions.length) return null;
  const parts = want.split("_").filter(Boolean);
  let partial = null;
  for (const emotion of entry.emotions) {
    const keys = emotion.key.split(/[,，]/).map(emotionKey).filter(Boolean);
    if (keys.includes(want)) return emotion;
    if (!partial && keys.some((key) => parts.includes(key))) partial = emotion;
  }
  return partial;
}

function lookFor(entry, expression) {
  const emotion = emotionFor(entry, expression);
  return {
    face: emotion?.face || entry.face,
    emotionFace: emotion?.face || "",
    full: emotion?.full || entry.full,
  };
}

// ── Storage ──

async function load() {
  const stored = await marinara.storage.get();
  const entries = (list) =>
    (Array.isArray(list) ? list : []).map((entry) => ({
      ...entry,
      emotions: Array.isArray(entry.emotions) ? entry.emotions : [],
      scale: Number(entry.scale) || 100,
    }));
  // 1.1 and earlier had one list (`cast`); it becomes the first set.
  sets = Array.isArray(stored.sets) && stored.sets.length
    ? stored.sets.map((set) => ({ id: String(set.id), name: String(set.name || "이름 없음"), cast: entries(set.cast) }))
    : [{ id: "default", name: "기본", cast: entries(stored.cast) }];
  chatSets = stored.chatSets && typeof stored.chatSets === "object" ? stored.chatSets : {};
  lastSet = sets.some((set) => set.id === stored.lastSet) ? stored.lastSet : sets[0].id;
  const open = setFor(activeChatId());
  currentSetId = open.id;
  cast = open.cast;
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
  applied = stored.applied && typeof stored.applied === "object" ? stored.applied : {};
}

// A chat not tied to a set yet opens the set picked last.
function setFor(chatId) {
  const id = (chatId && chatSets[chatId]) || lastSet;
  return sets.find((set) => set.id === id) ?? sets[0];
}

function currentSet() {
  return sets.find((set) => set.id === currentSetId) ?? sets[0];
}

function openSet(set) {
  currentSet().cast = cast;
  currentSetId = set.id;
  cast = set.cast;
}

// Follows the open chat to its set. Returns true when the set changed.
function syncSet() {
  const want = setFor(activeChatId());
  if (want.id === currentSetId) return false;
  openSet(want);
  renderSetBar();
  if (listEl?.childElementCount) renderList();
  return true;
}

let saveTimer = null;
function save(now = false) {
  if (saveTimer) marinara.clearTimeout(saveTimer);
  const write = () => {
    saveTimer = null;
    currentSet().cast = cast;
    marinara.storage
      .patch({ sets, chatSets, lastSet, settings, applied })
      .catch((error) => setStatus(`저장 실패: ${error.message}`));
  };
  if (now) write();
  else saveTimer = marinara.setTimeout(write, 500);
}

// ── Applying to a game chat ──

function parseMetadata(chat) {
  if (!chat?.metadata) return {};
  if (typeof chat.metadata === "string") {
    try {
      return JSON.parse(chat.metadata);
    } catch {
      return {};
    }
  }
  return chat.metadata;
}

function newNpcId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/(^-|-$)/g, "");
  return `npc-${slug || "cast"}-${Math.random().toString(36).slice(2, 8)}`;
}

function speakersIn(messages) {
  const names = new Set();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content !== "string") continue;
    for (const match of message.content.matchAll(SPEAKER_LINE)) names.add(match[1].trim());
  }
  return names;
}

// The player's own persona is not an NPC: a game NPC record would take over its portrait.
const personaNames = new Map();
async function personaNameOf(chat) {
  const key = chat.personaCharacterId ? `c:${chat.personaCharacterId}` : chat.personaId ? `p:${chat.personaId}` : "";
  if (!key) return "";
  if (!personaNames.has(key)) {
    let name = "";
    try {
      if (chat.personaCharacterId) {
        const row = await api(`/characters/${encodeURIComponent(chat.personaCharacterId)}`);
        const data = typeof row?.data === "string" ? JSON.parse(row.data) : row?.data;
        name = data?.name ?? "";
      } else {
        name = (await api(`/characters/personas/${encodeURIComponent(chat.personaId)}`))?.name ?? "";
      }
    } catch {
      return "";
    }
    personaNames.set(key, name);
  }
  return personaNames.get(key);
}

let applying = false;

async function applyToChat(chatId, { force = false } = {}) {
  if (applying || !chatId || !cast.length) return null;
  applying = true;
  try {
    const chat = await api(`/chats/${encodeURIComponent(chatId)}`);
    if (chat?.mode !== "game") return null;
    const meta = parseMetadata(chat);
    const npcs = Array.isArray(meta.gameNpcs) ? meta.gameNpcs : [];
    const persona = norm(await personaNameOf(chat));
    const marks = applied[chatId] ?? {};
    const doneMarks = {};
    const changes = new Map();
    const created = [];

    // A speaker the game has not tracked yet still gets a record, so its portrait and tags exist from its first line.
    const messages = await api(`/chats/${encodeURIComponent(chatId)}/messages?limit=30`);
    const known = new Set(npcs.map((npc) => norm(npc.name)));
    if (persona) known.add(persona);
    for (const speaker of speakersIn(Array.isArray(messages) ? messages : (messages?.messages ?? []))) {
      if (known.has(norm(speaker)) || !findEntry(speaker)) continue;
      known.add(norm(speaker));
      created.push({
        id: newNpcId(speaker),
        name: speaker,
        emoji: "👤",
        description: "",
        descriptionSource: "user",
        gender: null,
        pronouns: null,
        location: "",
        reputation: 0,
        notes: [],
      });
    }

    for (const npc of [...npcs, ...created]) {
      const entry = norm(npc.name) === persona ? null : findEntry(npc.name);
      if (!entry) continue;
      const patch = {};
      const tags = entry.tags.trim();
      if (tags && (npc.description !== tags || npc.descriptionSource !== "user")) {
        patch.description = tags;
        patch.descriptionSource = "user";
      }
      const mark = `${entry.id}:${entry.face}`;
      if (entry.face && (force || !npc.avatarUrl || marks[npc.id] !== mark)) {
        const result = await api(`/avatars/npc/${encodeURIComponent(chatId)}`, {
          method: "POST",
          body: JSON.stringify({ name: npc.name, avatar: await assetAsDataUrl(entry.face) }),
        });
        patch.avatarUrl = result.avatarPath;
        doneMarks[npc.id] = mark;
      }
      if (Object.keys(patch).length) changes.set(npc.id, patch);
    }

    if (!changes.size && !created.length) return 0;

    // Re-read right before writing, so an NPC the game added meanwhile is kept.
    const fresh = parseMetadata(await api(`/chats/${encodeURIComponent(chatId)}`));
    const freshNpcs = Array.isArray(fresh.gameNpcs) ? fresh.gameNpcs : [];
    const freshNames = new Set(freshNpcs.map((npc) => norm(npc.name)));
    const next = freshNpcs.map((npc) => (changes.has(npc.id) ? { ...npc, ...changes.get(npc.id) } : npc));
    for (const npc of created) {
      if (!freshNames.has(norm(npc.name))) next.push({ ...npc, ...(changes.get(npc.id) ?? {}) });
    }
    await api(`/chats/${encodeURIComponent(chatId)}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({ gameNpcs: next }),
    });
    applied[chatId] = { ...marks, ...doneMarks };
    save();
    return new Set([...changes.keys(), ...created.map((npc) => npc.id)]).size;
  } finally {
    applying = false;
  }
}

// ── Auto mode: apply once the chat has stopped changing ──

let lastChatId = null;
let lastSignature = null;
let stableTicks = 0;
let doneSignature = null;

async function poll() {
  if (disposed || !settings.auto || document.hidden) return;
  syncSet();
  if (!cast.length) return;
  const chatId = activeChatId();
  if (!chatId) return;
  if (chatId !== lastChatId) {
    lastChatId = chatId;
    lastSignature = null;
    doneSignature = null;
  }
  let messages;
  try {
    messages = await api(`/chats/${encodeURIComponent(chatId)}/messages?limit=1`);
  } catch {
    return;
  }
  const list = Array.isArray(messages) ? messages : (messages?.messages ?? []);
  const last = list[list.length - 1];
  const signature = last ? `${last.id}:${last.content?.length ?? 0}:${last.updatedAt ?? ""}` : "empty";
  if (signature !== lastSignature) {
    lastSignature = signature;
    stableTicks = 0;
    return;
  }
  stableTicks += 1;
  if (stableTicks < 1 || signature === doneSignature) return;
  doneSignature = signature;
  try {
    const count = await applyToChat(chatId);
    if (count) {
      setStatus(`${count}명 적용됨. 다음 응답부터 보이고, 바로 보려면 새로고침하세요.`);
      showReloadHint(true);
    }
  } catch (error) {
    marinara.log.warn("auto apply failed", error);
  }
}

// ── On-screen: portrait fallback and full-body sprite ──

let sprite = null;

function activePanel() {
  return document.querySelector('[data-component="GameNarration.ActivePanel"]');
}

// The narration sits on its own positioned layer inside the game viewport; the sprite goes into that
// viewport just beneath the layer, so it stands over the background and behind the dialogue box.
function spriteHost(panel) {
  for (let node = panel; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.position === "absolute" && Number(style.zIndex) >= 1) return node.parentElement;
  }
  return null;
}

function dockSprite(panel) {
  const host = spriteHost(panel);
  if (host && sprite.parentElement !== host) {
    host.append(sprite);
    sprite.classList.add("is-docked");
  } else if (!host && sprite.parentElement !== document.body) {
    document.body.append(sprite);
    sprite.classList.remove("is-docked");
  }
}

// When the HTML 위젯 extension is running it keeps a tool row in the HUD; the toggle joins it there.
// drawer: 확장 서랍 only collects buttons that sit directly in <body>, so while the drawer is installed the toggle
// waits there for it, and stays there once the drawer holds it. If the drawer has not taken it after a few seconds
// (left out of the drawer, or auto collection off), it joins the HUD row as before. While the drawer is picking
// (직접 담기) it comes back to <body> so it can be picked.
let offeredAt = 0;

function keepForDrawer() {
  if (!document.getElementById(DRAWER_ROOT_ID)) return false;
  if (document.querySelector(DRAWER_PICK_SELECTOR)) return true;
  if (getComputedStyle(toggleEl).display === "none") return true; // the drawer holds it
  if (toggleEl.parentElement !== document.body) return false; // already back in the HUD row
  if (document.hidden) {
    offeredAt = 0;
    return true;
  }
  if (!offeredAt) {
    offeredAt = Date.now();
    marinara.setTimeout(scheduleRefresh, DRAWER_GRACE_MS + 100);
  }
  return Date.now() - offeredAt < DRAWER_GRACE_MS;
}

function dockToggle() {
  const slot = document.getElementById("malu-hud-tools");
  const keep = keepForDrawer();
  const target = slot && !keep ? slot : document.body;
  if (toggleEl.parentElement !== target) target.append(toggleEl);
}

// The dialogue box shows the speaker and text but not the expression tag, so the latest GM lines are read
// from the chat and the shown text is matched back to its line.
let spoken = [];
let spokenChatId = null;
let spokenMiss = "";
let spokenFetchAt = 0;
let spokenFetching = false;
let spokenRetry = 0;

function textKey(value) {
  return String(value ?? "")
    .replace(/\[[^\]]*\]|<[^>]*>/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function parseSpoken(messages) {
  const lines = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content !== "string") continue;
    for (const line of message.content.split(/\r?\n/)) {
      const match = line.match(DIALOGUE_LINE);
      if (!match) continue;
      const expression = TYPE_TAG.test(match[2].trim()) ? match[3] : (match[3] ?? match[2]);
      lines.push({ speaker: match[1].trim(), expression: expression?.trim() ?? "", text: textKey(match[4]) });
    }
  }
  return lines;
}

async function fetchSpoken(chatId) {
  if (spokenFetching) return;
  spokenFetching = true;
  spokenFetchAt = Date.now();
  try {
    const messages = await api(`/chats/${encodeURIComponent(chatId)}/messages?limit=4`);
    spoken = parseSpoken(Array.isArray(messages) ? messages : (messages?.messages ?? []));
    spokenChatId = chatId;
    scheduleRefresh();
  } catch (error) {
    marinara.log.warn("could not read lines for expressions", error);
  } finally {
    spokenFetching = false;
  }
}

function currentExpression(entry, speaker, shown) {
  const chatId = activeChatId();
  if (!chatId) return "";
  if (chatId !== spokenChatId) {
    spoken = [];
    spokenMiss = "";
  }
  const key = textKey(shown).slice(0, 40);
  const mine = spoken.filter((line) => findEntry(line.speaker) === entry);
  if (key.length >= 4) {
    for (let i = mine.length - 1; i >= 0; i -= 1) {
      const text = mine[i].text;
      if (text && (text.startsWith(key) || key.startsWith(text.slice(0, 40)))) return mine[i].expression;
    }
  }
  // Not found yet (a new reply, or a line still typing out): read the chat again, once per line.
  const miss = `${chatId}|${norm(speaker)}|${key.slice(0, 12)}`;
  if (miss !== spokenMiss) {
    const wait = SPOKEN_FETCH_GAP_MS - (Date.now() - spokenFetchAt);
    if (wait <= 0 && !spokenFetching) {
      spokenMiss = miss;
      void fetchSpoken(chatId);
    } else if (!spokenRetry) {
      spokenRetry = marinara.setTimeout(() => {
        spokenRetry = 0;
        scheduleRefresh();
      }, Math.max(wait, 200));
    }
  }
  return mine.length ? mine[mine.length - 1].expression : "";
}

// What the game itself put in the avatar, remembered across our own swaps.
function gameSrc(img) {
  const current = img.getAttribute("src") ?? "";
  if (img.dataset.maluCastSrc !== current) {
    img.dataset.maluCastOrig = current;
    delete img.dataset.maluCastSrc;
  }
  return img.dataset.maluCastOrig ?? "";
}

function setAvatar(img, want) {
  const original = gameSrc(img);
  const target = want || original;
  if (img.getAttribute("src") !== target) img.setAttribute("src", target);
  if (target !== original) img.dataset.maluCastSrc = target;
  else delete img.dataset.maluCastSrc;
  // The game's crop (a persona's avatarCrop) belongs to its own picture, not to ours.
  img.classList.toggle("malu-cast-own", target !== original);
}

function refreshScreen() {
  if (disposed) return;
  syncSet();
  if (toggleEl) dockToggle();
  const panel = activePanel();
  const speaker = panel?.querySelector(".experience-dialogue-speaker > span")?.textContent?.trim() ?? "";
  const entry = speaker ? findEntry(speaker) : null;
  const shown = panel?.querySelector(".game-narration-prose")?.textContent ?? "";
  const look = entry ? lookFor(entry, entry.emotions.length ? currentExpression(entry, speaker, shown) : "") : null;

  // The cast face (or this line's emotion face) always wins over whatever the game put there:
  // a silhouette, or a persona avatar cut out of its full-body picture.
  if (panel) {
    for (const img of panel.querySelectorAll(".experience-dialogue-avatar img")) {
      const face = look?.emotionFace || look?.face;
      setAvatar(img, face ? assetUrl(face) : "");
    }
  }

  const showSprite = Boolean(settings.sprite && panel && look?.full && panel.getClientRects().length);
  if (!sprite) return;
  if (!showSprite) {
    sprite.classList.remove("is-visible");
    return;
  }
  dockSprite(panel);
  const src = assetUrl(look.full);
  if (sprite.dataset.src !== src) {
    sprite.dataset.src = src;
    sprite.src = src;
  }
  sprite.dataset.side = settings.side;
  sprite.style.setProperty("--malu-cast-height", `${(settings.height * entry.scale) / 100}vh`);
  sprite.alt = speaker;
  sprite.classList.add("is-visible");
}

let refreshTimer = 0;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = marinara.setTimeout(() => {
    refreshTimer = 0;
    refreshScreen();
  }, 60);
}

// ── Panel UI ──

let root = null;
let toggleEl = null;
let panelEl = null;
let statusEl = null;
let reloadEl = null;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function showReloadHint(show) {
  if (reloadEl) reloadEl.hidden = !show;
}

// `owner` is a cast entry or one of its emotions; `fileId` names the uploaded file.
function imageSlot(owner, kind, label, fileId = owner.id) {
  const path = owner[kind];
  const input = el("input", { type: "file", accept: "image/*", hidden: true });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    setStatus(`${label} 올리는 중…`);
    try {
      const old = owner[kind];
      owner[kind] = await uploadAsset(file, fileId, kind);
      save(true);
      await deleteAssets([old]);
      setStatus(`${label} 저장됨.`);
      renderList();
      scheduleRefresh();
    } catch (error) {
      setStatus(`${label} 저장 실패: ${error.message}`);
    }
  });
  const preview = path
    ? el("img", { class: "malu-cast-thumb", src: assetUrl(path), alt: label, loading: "lazy" })
    : el("div", { class: "malu-cast-thumb is-empty", text: "없음" });
  return el("div", { class: "malu-cast-slot" }, [
    el("span", { class: "malu-cast-label", text: label }),
    preview,
    el("div", { class: "malu-cast-slot-buttons" }, [
      el("button", { type: "button", text: path ? "바꾸기" : "올리기", onclick: () => input.click() }),
      path &&
        el("button", {
          type: "button",
          text: "지우기",
          onclick: async () => {
            const old = owner[kind];
            owner[kind] = "";
            save(true);
            await deleteAssets([old]);
            renderList();
            scheduleRefresh();
          },
        }),
    ]),
    input,
  ]);
}

function emotionRow(entry, emotion) {
  const key = el("input", {
    type: "text",
    value: emotion.key,
    list: "malu-cast-expressions",
    placeholder: "happy, smile",
  });
  key.addEventListener("input", () => {
    emotion.key = key.value;
    save();
    scheduleRefresh();
  });
  const fileId = `${entry.id}-${emotion.id}`;
  return el("div", { class: "malu-cast-emotion" }, [
    el("div", { class: "malu-cast-emotion-head" }, [
      key,
      el("button", {
        type: "button",
        class: "malu-cast-emotion-remove",
        title: "이 감정 삭제",
        "aria-label": "이 감정 삭제",
        text: "✕",
        onclick: async () => {
          entry.emotions = entry.emotions.filter((item) => item !== emotion);
          save(true);
          await deleteAssets([emotion.face, emotion.full]);
          renderList();
          scheduleRefresh();
        },
      }),
    ]),
    el("div", { class: "malu-cast-slots" }, [
      imageSlot(emotion, "face", "얼굴", fileId),
      imageSlot(emotion, "full", "전신", fileId),
    ]),
  ]);
}

// A button on the row header: it must not also fold or unfold the card.
function rowButton(text, label, disabled, action) {
  return el("button", {
    type: "button",
    class: "malu-cast-tool",
    title: label,
    "aria-label": label,
    disabled,
    text,
    onclick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    },
  });
}

// Order matters: when two entries share a name, the one higher up wins.
function moveEntry(entry, step) {
  const from = cast.indexOf(entry);
  const to = from + step;
  if (from < 0 || to < 0 || to >= cast.length) return;
  cast.splice(from, 1);
  cast.splice(to, 0, entry);
  save();
  renderList();
  scheduleRefresh();
}

async function removeEntry(entry) {
  if (!confirm(`'${entry.names || "이름 없음"}'을(를) 목록에서 지울까요? 올린 이미지도 지워집니다.`)) return;
  cast = cast.filter((item) => item !== entry);
  save(true);
  await deleteAssets(assetsOf(entry));
  renderList();
  scheduleRefresh();
}

function displayName(entry) {
  return entry.names.split(/[,，\n]/)[0]?.trim() || "이름 없음";
}

function entryCard(entry) {
  const title = el("span", { class: "malu-cast-card-name", text: displayName(entry) });
  const names = el("input", {
    type: "text",
    value: entry.names,
    placeholder: "세이버, 네로, 네로 클라우디우스",
  });
  names.addEventListener("input", () => {
    entry.names = names.value;
    title.textContent = displayName(entry);
    save();
    scheduleRefresh();
  });
  const tags = el("textarea", {
    rows: 3,
    placeholder: "1girl, blonde hair, green eyes, ahoge, red dress, ...",
  });
  tags.value = entry.tags;
  tags.addEventListener("input", () => {
    entry.tags = tags.value;
    save();
  });
  const scaleValue = el("span", { class: "malu-cast-value", text: `${entry.scale}%` });
  const scale = el("input", { type: "range", min: 30, max: 200, step: 5, value: entry.scale });
  scale.addEventListener("input", () => {
    entry.scale = Number(scale.value);
    scaleValue.textContent = `${entry.scale}%`;
    save();
    scheduleRefresh();
  });

  const card = el("details", { class: "malu-cast-card", open: Boolean(entry.open) }, [
    el("summary", { class: "malu-cast-card-head" }, [
      entry.face
        ? el("img", { class: "malu-cast-mini", src: assetUrl(entry.face), alt: "", loading: "lazy" })
        : el("span", { class: "malu-cast-mini is-empty", text: "👤" }),
      title,
      entry.emotions.length > 0 && el("span", { class: "malu-cast-badge", text: `감정 ${entry.emotions.length}` }),
      el("span", { class: "malu-cast-tools-space" }),
    ]),
    el("div", { class: "malu-cast-card-body" }, [
      el("label", { class: "malu-cast-field" }, [el("span", { class: "malu-cast-label", text: "이름 (쉼표로 여럿)" }), names]),
      el("label", { class: "malu-cast-field" }, [el("span", { class: "malu-cast-label", text: "외형 태그" }), tags]),
      el("span", { class: "malu-cast-label", text: "기본 이미지" }),
      el("div", { class: "malu-cast-slots" }, [imageSlot(entry, "face", "얼굴"), imageSlot(entry, "full", "전신")]),
      el("label", { class: "malu-cast-row" }, [
        el("span", { class: "malu-cast-label", text: "전신 크기" }),
        el("span", { class: "malu-cast-range" }, [scale, scaleValue]),
      ]),
      el("div", { class: "malu-cast-emotions" }, [
        el("span", { class: "malu-cast-label", text: "감정별 이미지" }),
        entry.emotions.length > 0 &&
          el("p", {
            class: "malu-cast-hint",
            text: "GM이 대사에 붙인 표정 태그와 이름이 맞으면 그 줄 동안 이 이미지로 바뀝니다. 비워 둔 칸은 기본 이미지를 씁니다.",
          }),
        ...entry.emotions.map((emotion) => emotionRow(entry, emotion)),
        el("button", {
          type: "button",
          class: "malu-cast-emotion-add",
          text: "+ 감정 추가",
          onclick: () => {
            entry.emotions.push({ id: Math.random().toString(36).slice(2, 8), key: "", face: "", full: "" });
            save();
            renderList();
          },
        }),
      ]),
      el("button", {
        type: "button",
        class: "malu-cast-remove",
        text: "이 인물 삭제",
        onclick: () => removeEntry(entry),
      }),
    ]),
  ]);
  card.addEventListener("toggle", () => {
    if (entry.open === card.open) return;
    entry.open = card.open;
    save();
    updateFoldAll();
  });
  // Buttons inside <summary> are not reachable by keyboard, so the row tools sit beside it, over the head row.
  return el("div", { class: "malu-cast-entry" }, [
    card,
    el("span", { class: "malu-cast-tools" }, [
      rowButton("▲", "위로", cast.indexOf(entry) === 0, () => moveEntry(entry, -1)),
      rowButton("▼", "아래로", cast.indexOf(entry) === cast.length - 1, () => moveEntry(entry, 1)),
      rowButton("✕", "이 인물 삭제", false, () => removeEntry(entry)),
    ]),
  ]);
}

// ── JSON export / import ──

function assetsOf(entry) {
  return [entry.face, entry.full, ...entry.emotions.flatMap((emotion) => [emotion.face, emotion.full])].filter(Boolean);
}

function sharesName(a, b) {
  const names = new Set(aliasesOf(a));
  return aliasesOf(b).some((alias) => names.has(alias));
}

// With images, each image is embedded as a data URL so the file works on another server; without, it keeps the
// asset paths, which only resolve on this server.
async function exportJson(withImages) {
  const image = async (path) => {
    if (!path || !withImages) return path || "";
    try {
      return await assetAsDataUrl(path);
    } catch {
      return "";
    }
  };
  const list = [];
  for (const entry of cast) {
    const emotions = [];
    for (const emotion of entry.emotions) {
      emotions.push({ key: emotion.key, face: await image(emotion.face), full: await image(emotion.full) });
    }
    list.push({
      names: entry.names,
      tags: entry.tags,
      scale: entry.scale,
      face: await image(entry.face),
      full: await image(entry.full),
      emotions,
    });
  }
  return JSON.stringify({ kind: "malu-cast", version: 1, name: currentSet().name, cast: list }, null, withImages ? 0 : 2);
}

function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSON 형식이 아닙니다.");
  }
  const list = Array.isArray(data) ? data : data?.cast;
  if (!Array.isArray(list)) throw new Error("출연진 목록(cast)이 없습니다.");
  return { list: list.filter((item) => item && typeof item === "object"), name: String(data?.name ?? "").trim() };
}

async function importCast(list, replaceAll) {
  const uploaded = [];
  const image = async (value, fileId, kind) => {
    if (typeof value !== "string" || !value) return "";
    const match = value.match(/^data:image\/(png|jpe?g|webp|gif|avif)[;,]/i);
    if (match) {
      const path = await uploadDataUrl(value, fileId, kind, match[1].toLowerCase().replace("jpeg", "jpg"));
      uploaded.push(path);
      return path;
    }
    return value.startsWith("data:") ? "" : value;
  };
  const incoming = [];
  try {
    for (const [index, item] of list.entries()) {
      setStatus(`가져오는 중… ${index + 1} / ${list.length}`);
      const id = Math.random().toString(36).slice(2, 10);
      const entry = {
        id,
        names: String(item.names ?? ""),
        tags: String(item.tags ?? ""),
        face: await image(item.face, id, "face"),
        full: await image(item.full, id, "full"),
        emotions: [],
        scale: Math.min(200, Math.max(30, Number(item.scale) || 100)),
        open: false,
      };
      for (const emotion of Array.isArray(item.emotions) ? item.emotions : []) {
        const emotionId = Math.random().toString(36).slice(2, 8);
        entry.emotions.push({
          id: emotionId,
          key: String(emotion?.key ?? ""),
          face: await image(emotion?.face, `${id}-${emotionId}`, "face"),
          full: await image(emotion?.full, `${id}-${emotionId}`, "full"),
        });
      }
      incoming.push(entry);
    }
  } catch (error) {
    await deleteAssets(uploaded);
    throw error;
  }

  // An imported entry that shares a name with one already listed takes its place.
  const removed = replaceAll ? [...cast] : [];
  const next = replaceAll ? [] : [...cast];
  for (const entry of incoming) {
    const at = next.findIndex((old) => sharesName(old, entry));
    if (at >= 0) {
      removed.push(next[at]);
      next[at] = entry;
    } else next.push(entry);
  }
  cast = next;
  save(true);
  const kept = new Set(cast.flatMap(assetsOf));
  await deleteAssets(removed.flatMap(assetsOf).filter((path) => !kept.has(path)));
  return { added: incoming.length - (replaceAll ? 0 : removed.length), replaced: replaceAll ? 0 : removed.length };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // Plain http (a personal server on the LAN) has no clipboard API.
  const area = el("textarea", { style: "position:fixed;left:-9999px;opacity:0" });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  area.remove();
  return ok;
}

function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  marinara.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sizeOf(text) {
  const bytes = new Blob([text]).size;
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function ioBlock() {
  let busy = false;
  const run = async (task) => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (error) {
      setStatus(error.message);
    } finally {
      busy = false;
    }
  };
  const withImages = el("input", { type: "checkbox" });
  withImages.checked = true;
  const exported = async () => {
    if (!cast.length) throw new Error("내보낼 인물이 없습니다.");
    setStatus("JSON을 만드는 중…");
    return exportJson(withImages.checked);
  };
  const area = el("textarea", { rows: 4, class: "malu-cast-io-text", placeholder: "내보낸 JSON을 붙여 넣거나 파일을 여세요." });
  const mode = el("select", {}, [
    el("option", { value: "merge", text: "기존 목록에 더하기 (같은 이름은 바꾸기)" }),
    el("option", { value: "replace", text: "기존 목록을 지우고 바꾸기" }),
    el("option", { value: "new", text: "새 세트로 가져오기" }),
  ]);
  const file = el("input", { type: "file", accept: "application/json,.json", hidden: true });
  file.addEventListener("change", async () => {
    const picked = file.files?.[0];
    file.value = "";
    if (!picked) return;
    area.value = await picked.text();
    setStatus(`${picked.name}을(를) 읽었습니다. 가져오기를 누르세요.`);
  });
  return el("details", { class: "malu-cast-io" }, [
    el("summary", { text: "JSON 내보내기 · 가져오기" }),
    el("div", { class: "malu-cast-io-body" }, [
      el("label", { class: "malu-cast-check" }, [withImages, el("span", { text: "이미지도 넣기 (다른 서버·기기로 옮길 때)" })]),
      el("div", { class: "malu-cast-actions" }, [
        el("button", {
          type: "button",
          text: "JSON 복사",
          onclick: () =>
            run(async () => {
              const text = await exported();
              setStatus((await copyText(text)) ? `${cast.length}명 복사됨 (${sizeOf(text)}).` : "복사하지 못했습니다. 파일로 저장을 쓰세요.");
            }),
        }),
        el("button", {
          type: "button",
          text: "파일로 저장",
          onclick: () =>
            run(async () => {
              const text = await exported();
              downloadText(text, `출연진-${new Date().toISOString().slice(0, 10)}.json`);
              setStatus(`${cast.length}명 저장됨 (${sizeOf(text)}).`);
            }),
        }),
      ]),
      area,
      mode,
      el("div", { class: "malu-cast-actions" }, [
        el("button", { type: "button", text: "파일 열기", onclick: () => file.click() }),
        el("button", {
          type: "button",
          class: "malu-cast-apply",
          text: "가져오기",
          onclick: () =>
            run(async () => {
              const { list, name } = parseImport(area.value.trim());
              if (!list.length) throw new Error("가져올 인물이 없습니다.");
              if (mode.value === "new") {
                const setName = prompt("새 세트 이름", name || "가져온 세트")?.trim();
                if (!setName) return;
                addSet(setName);
              }
              const replaceAll = mode.value !== "merge";
              if (mode.value === "replace" && cast.length && !confirm(`지금 목록 ${cast.length}명을 지우고 ${list.length}명으로 바꿀까요?`)) return;
              const { added, replaced } = await importCast(list, replaceAll);
              area.value = "";
              renderList();
              scheduleRefresh();
              setStatus(`가져옴: 새로 ${added}명${replaced ? `, 바꿈 ${replaced}명` : ""}.`);
            }),
        }),
      ]),
      file,
    ]),
  ]);
}

// ── Cast sets ──

let setSelectEl = null;
let setNoteEl = null;

function renderSetBar() {
  if (!setSelectEl) return;
  setSelectEl.replaceChildren(
    ...sets.map((set) => el("option", { value: set.id, text: `${set.name} (${set.id === currentSetId ? cast.length : set.cast.length}명)` })),
  );
  setSelectEl.value = currentSetId;
  const chatId = activeChatId();
  setNoteEl.textContent = !chatId
    ? "열린 채팅이 없어서 마지막으로 고른 세트를 보여 줍니다."
    : chatSets[chatId]
      ? "이 채팅은 이 세트를 씁니다."
      : "이 채팅은 아직 세트를 고르지 않아 마지막으로 고른 세트를 씁니다. 다른 세계관이면 세트를 바꾸세요.";
}

// Picking a set ties the open chat to it, and new chats start from it.
function pickSet(set) {
  openSet(set);
  lastSet = set.id;
  const chatId = activeChatId();
  if (chatId) chatSets[chatId] = set.id;
  save(true);
  renderSetBar();
  renderList();
  scheduleRefresh();
}

function addSet(name) {
  const set = { id: Math.random().toString(36).slice(2, 10), name, cast: [] };
  sets.push(set);
  pickSet(set);
  return set;
}

// The copy shares the original's image files; deleteAssets keeps a file while any set still uses it, so either
// set can change or drop its images without breaking the other.
function copySet(name, entries) {
  const set = addSet(name);
  cast = entries.map((entry) => ({
    ...entry,
    id: Math.random().toString(36).slice(2, 10),
    open: false,
    emotions: entry.emotions.map((emotion) => ({ ...emotion, id: Math.random().toString(36).slice(2, 8) })),
  }));
  set.cast = cast;
  save(true);
  renderList();
  scheduleRefresh();
  setStatus(`'${name}' 세트를 만들었습니다 (${cast.length}명).`);
}

function setBar() {
  setSelectEl = el("select", { class: "malu-cast-set-select", "aria-label": "세트" });
  setSelectEl.addEventListener("change", () => {
    const set = sets.find((item) => item.id === setSelectEl.value);
    if (set) pickSet(set);
  });
  setNoteEl = el("p", { class: "malu-cast-hint" });
  return el("div", { class: "malu-cast-sets" }, [
    el("div", { class: "malu-cast-set-row" }, [
      el("span", { class: "malu-cast-label", text: "세트" }),
      setSelectEl,
    ]),
    el("div", { class: "malu-cast-actions" }, [
      el("button", {
        type: "button",
        text: "+ 새 세트",
        onclick: () => {
          const name = prompt("새 세트 이름 (예: 세계관 이름)", "")?.trim();
          if (name) addSet(name);
        },
      }),
      el("button", {
        type: "button",
        text: "세트 복사",
        onclick: () => {
          const from = currentSet();
          const name = prompt("복사한 세트 이름", `${from.name} 사본`)?.trim();
          if (name) copySet(name, cast);
        },
      }),
      el("button", {
        type: "button",
        text: "이름 바꾸기",
        onclick: () => {
          const set = currentSet();
          const name = prompt("세트 이름", set.name)?.trim();
          if (!name) return;
          set.name = name;
          save();
          renderSetBar();
        },
      }),
      el("button", {
        type: "button",
        text: "세트 삭제",
        onclick: async () => {
          if (sets.length < 2) return setStatus("세트가 하나뿐이라 지울 수 없습니다.");
          const set = currentSet();
          if (!confirm(`'${set.name}' 세트와 그 안의 인물 ${cast.length}명, 올린 이미지를 지울까요?`)) return;
          const gone = cast.flatMap(assetsOf);
          sets = sets.filter((item) => item !== set);
          for (const [chatId, id] of Object.entries(chatSets)) if (id === set.id) delete chatSets[chatId];
          if (lastSet === set.id) lastSet = sets[0].id;
          currentSetId = sets[0].id;
          cast = sets[0].cast;
          pickSet(setFor(activeChatId()));
          await deleteAssets(gone);
        },
      }),
    ]),
    setNoteEl,
  ]);
}

let listEl = null;
let foldAllEl = null;

function updateFoldAll() {
  if (!foldAllEl) return;
  foldAllEl.hidden = cast.length < 2;
  foldAllEl.textContent = cast.some((entry) => entry.open) ? "모두 접기" : "모두 펼치기";
}

function renderList() {
  if (!listEl) return;
  listEl.replaceChildren(
    ...(cast.length ? cast.map(entryCard) : [el("p", { class: "malu-cast-empty", text: "아직 등록한 인물이 없습니다." })]),
  );
  updateFoldAll();
  renderSetBar();
}

function settingsBlock() {
  const check = (key, label) => {
    const input = el("input", { type: "checkbox" });
    input.checked = Boolean(settings[key]);
    input.addEventListener("change", () => {
      settings[key] = input.checked;
      save();
      scheduleRefresh();
    });
    return el("label", { class: "malu-cast-check" }, [input, el("span", { text: label })]);
  };
  const side = el("select", {}, [
    el("option", { value: "left", text: "왼쪽" }),
    el("option", { value: "center", text: "가운데" }),
    el("option", { value: "right", text: "오른쪽" }),
  ]);
  side.value = settings.side;
  side.addEventListener("change", () => {
    settings.side = side.value;
    save();
    scheduleRefresh();
  });
  const heightValue = el("span", { class: "malu-cast-value", text: `${settings.height}%` });
  const height = el("input", { type: "range", min: 30, max: 100, step: 5, value: settings.height });
  height.addEventListener("input", () => {
    settings.height = Number(height.value);
    heightValue.textContent = `${settings.height}%`;
    save();
    scheduleRefresh();
  });
  const corner = el("select", {}, [
    el("option", { value: "bottom-left", text: "왼쪽 아래" }),
    el("option", { value: "bottom-right", text: "오른쪽 아래" }),
    el("option", { value: "top-left", text: "왼쪽 위" }),
    el("option", { value: "top-right", text: "오른쪽 위" }),
  ]);
  corner.value = settings.button;
  corner.addEventListener("change", () => {
    settings.button = corner.value;
    toggleEl.dataset.corner = corner.value; // drawer: the corner now places the toggle itself
    save();
  });
  return el("div", { class: "malu-cast-settings" }, [
    check("auto", "응답이 끝나면 자동으로 적용"),
    check("sprite", "말하는 인물의 전신 이미지 표시"),
    el("label", { class: "malu-cast-row" }, [el("span", { text: "전신 위치" }), side]),
    el("label", { class: "malu-cast-row" }, [
      el("span", { text: "전신 높이 (화면 대비, 모두)" }),
      el("span", { class: "malu-cast-range" }, [height, heightValue]),
    ]),
    el("label", { class: "malu-cast-row" }, [el("span", { text: "버튼 위치" }), corner]),
  ]);
}

function buildUi() {
  root = el("div", { id: ROOT_ID });
  // drawer: a stable id and data-drawer-launcher, and the toggle no longer sits inside the panel root
  // (a drawer hiding the old root hid the panel with it).
  const toggle = (toggleEl = el("button", {
    type: "button",
    id: LAUNCHER_ID,
    class: "malu-cast-toggle",
    "data-corner": settings.button,
    "data-drawer-launcher": true,
    "aria-label": "출연진 초상화 열기",
    title: "출연진 초상화",
    text: "🎭",
    onclick: () => {
      panelEl.hidden = !panelEl.hidden;
      // The cards (and their images) are built on first open, not at page load.
      if (!panelEl.hidden) renderList();
    },
  }));
  statusEl = el("p", { class: "malu-cast-status", role: "status" });
  reloadEl = el("button", { type: "button", text: "새로고침", hidden: true, onclick: () => location.reload() });
  listEl = el("div", { class: "malu-cast-list" });
  foldAllEl = el("button", {
    type: "button",
    class: "malu-cast-fold",
    onclick: () => {
      const open = !cast.some((entry) => entry.open);
      for (const entry of cast) entry.open = open;
      save();
      renderList();
    },
  });
  // The header stays put while the body scrolls, so ✕ is always in reach.
  panelEl = el("section", { class: "malu-cast-panel", hidden: true }, [
    el("header", { class: "malu-cast-header" }, [
      el("h2", { text: "출연진 초상화" }),
      foldAllEl,
      el("button", {
        type: "button",
        class: "malu-cast-close",
        "aria-label": "닫기",
        text: "✕",
        onclick: () => (panelEl.hidden = true),
      }),
    ]),
    el("div", { class: "malu-cast-body" }, [
      setBar(),
      el("p", {
        class: "malu-cast-help",
        text: "이름이 맞는 NPC에 얼굴 이미지와 외형 태그를 고정합니다. 클래스명과 진명을 모두 적어 두면 진명이 밝혀진 뒤에도 이어집니다.",
      }),
      el("datalist", { id: "malu-cast-expressions" }, DEFAULT_EXPRESSIONS.map((value) => el("option", { value }))),
      listEl,
      el("button", {
        type: "button",
        class: "malu-cast-add",
        text: "+ 인물 추가",
        onclick: () => {
          cast.push({
            id: Math.random().toString(36).slice(2, 10),
            names: "",
            tags: "",
            face: "",
            full: "",
            emotions: [],
            scale: 100,
            open: true,
          });
          save();
          renderList();
        },
      }),
      settingsBlock(),
      ioBlock(),
      el("div", { class: "malu-cast-actions" }, [
        el("button", {
          type: "button",
          class: "malu-cast-apply",
          text: "지금 이 게임에 적용",
          onclick: async () => {
            const chatId = activeChatId();
            if (!chatId) return setStatus("열려 있는 채팅이 없습니다.");
            syncSet();
            setStatus("적용하는 중…");
            try {
              const count = await applyToChat(chatId, { force: true });
              if (count === null) setStatus("게임 모드 채팅에서만 적용됩니다.");
              else if (count === 0) setStatus("맞는 NPC가 없거나 이미 적용되어 있습니다.");
              else {
                setStatus(`${count}명 적용됨. 다음 응답부터 보이고, 바로 보려면 새로고침하세요.`);
                showReloadHint(true);
              }
            } catch (error) {
              setStatus(`적용 실패: ${error.message}`);
            }
          },
        }),
        reloadEl,
      ]),
      statusEl,
    ]),
  ]);
  root.append(panelEl);
  document.body.append(root, toggle);

  sprite = el("img", { class: "malu-cast-sprite", alt: "", "aria-hidden": "true" });
  document.body.append(sprite);
}

// ── Start ──

await load();
buildUi();

const observer = new MutationObserver(scheduleRefresh);
observer.observe(document.body, { childList: true, subtree: true, characterData: true });
const pollTimer = marinara.setInterval(() => void poll(), POLL_MS);
scheduleRefresh();

// drawer: Escape closes the panel too (opened from a drawer tile, the 🎭 button itself is hidden).
const onKeydown = (event) => {
  if (event.key === "Escape" && panelEl && !panelEl.hidden) panelEl.hidden = true;
};
document.addEventListener("keydown", onKeydown);

marinara.onCleanup(() => {
  disposed = true;
  observer.disconnect();
  document.removeEventListener("keydown", onKeydown);
  marinara.clearInterval(pollTimer);
  if (refreshTimer) marinara.clearTimeout(refreshTimer);
  if (spokenRetry) marinara.clearTimeout(spokenRetry);
  for (const img of document.querySelectorAll("img[data-malu-cast-src]")) {
    img.setAttribute("src", img.dataset.maluCastOrig ?? "");
  }
  root?.remove();
  sprite?.remove();
  toggleEl?.remove();
});
