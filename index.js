/* RisuAI Dungeon Keeper full dynamic runtime for SillyTavern */
const ACCESS = 'dk-runtime-access';
const EXTENSION_NAME = 'RisuDKRuntime';

const FALLBACK_EVENTS = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_CREATED: 'chat_created',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPED: 'message_swiped',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    GENERATION_ENDED: 'generation_ended',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
    WORLD_INFO_ACTIVATED: 'world_info_activated',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
};

let contextGetter = null;
let St = null;
let StMessageFormatter = null;
let runtime = null;
let runtimePromise = null;
let runtimeData = null;
let initialized = false;
let observer = null;
let rendering = false;
let renderTimer = null;
let saveStateTimer = null;
let saveChatTimer = null;
let suppressChatChanged = false;
let lastChatId = null;
let lastStartedChatId = null;
let lastInputSignature = null;
let lastOutputSignature = null;
let stopSending = false;
let reloadCount = 0;

let state = new Map();
let defaultVars = new Map();
let localLorebooks = new Map();
let assetNames = [];
let assetByName = new Map();
let assetUrlBase = '';
let luaQueue = Promise.resolve();

function withLua(fn) {
    const run = luaQueue.then(fn, fn);
    luaQueue = run.catch(() => undefined);
    return run;
}

async function ensureContextGetter() {
    if (contextGetter) return contextGetter;
    try {
        const module = await import('../../extensions.js');
        if (typeof module.getContext === 'function') {
            contextGetter = module.getContext;
            return contextGetter;
        }
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] getContext import from extensions.js failed`, error);
    }
    try {
        const module = await import('../../../script.js');
        St = module;
        if (typeof module.getContext === 'function') {
            contextGetter = module.getContext;
            return contextGetter;
        }
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] getContext import from script.js failed`, error);
    }
    if (typeof globalThis.SillyTavern?.getContext === 'function') {
        contextGetter = globalThis.SillyTavern.getContext;
    } else {
        contextGetter = () => ({});
    }
    return contextGetter;
}

async function ensureStModule() {
    if (St) return St;
    try {
        St = await import('../../../script.js');
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] script.js dynamic import unavailable`, error);
        St = {};
    }
    return St;
}

async function ensureMessageFormatterModule() {
    if (StMessageFormatter) return StMessageFormatter;
    try {
        const module = await import('../../message-formatter.js');
        StMessageFormatter = module.MessageFormatter ?? module.default ?? null;
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] message-formatter.js dynamic import unavailable`, error);
        StMessageFormatter = null;
    }
    return StMessageFormatter;
}

function getCtx() {
    try {
        return contextGetter ? contextGetter() : {};
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] getContext failed`, error);
        return {};
    }
}

function getChatArray() {
    const ctx = getCtx();
    return ctx.chat ?? St?.chat ?? [];
}

function getCharacters() {
    const ctx = getCtx();
    return ctx.characters ?? St?.characters ?? [];
}

function getCharacterId() {
    const ctx = getCtx();
    return ctx.characterId ?? St?.this_chid ?? -1;
}

function getCharacter() {
    return getCharacters()[getCharacterId()] ?? null;
}

function getCardData() {
    const character = getCharacter();
    return character?.data ?? character ?? {};
}

function getChatId() {
    const ctx = getCtx();
    try {
        return String(ctx.chatId ?? ctx.getCurrentChatId?.() ?? '');
    } catch {
        return '';
    }
}

function getMetadata() {
    const ctx = getCtx();
    return ctx.chatMetadata ?? St?.chat_metadata ?? {};
}

function isActive() {
    try {
        const ctx = getCtx();
        if (ctx.groupId || ctx.selected_group) return false;
        const data = getCardData();
        return Boolean(data?.extensions?.dk_runtime?.enabled || data?.extensions?.risuai?.defaultVariables);
    } catch {
        return false;
    }
}

function canonName(name) {
    return String(name ?? '').toLowerCase().replace(/\\/g, '/').split('/').pop()
        .replace(/\.(webp|png|jpe?g|gif|avif)$/i, '')
        .trim().replace(/[\s-]+/g, '_');
}

function getChatVarRaw(key) {
    const stateKey = '$' + String(key);
    if (state.has(stateKey)) return state.get(stateKey);
    if (defaultVars.has(key)) return defaultVars.get(key);
    return 'null';
}

function setChatVarRaw(key, value) {
    const stateKey = '$' + String(key);
    const old = state.has(stateKey)
        ? state.get(stateKey)
        : (defaultVars.has(key) ? defaultVars.get(key) : 'null');
    const next = String(value ?? '');
    if (old === next) return false;
    state.set(stateKey, next);
    scheduleSaveState();
    return true;
}

function scheduleSaveState() {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
        saveStateTimer = null;
        void saveState();
    }, 120);
}

async function saveState() {
    const meta = getMetadata();
    if (!meta || typeof meta !== 'object') return;
    meta.dkRisuState = Object.fromEntries(state);
    meta.dkRisuLocalLore = Object.fromEntries(localLorebooks);
    const ctx = getCtx();
    const fn = ctx.saveMetadata ?? ctx.saveMetadataDebounced ?? St?.saveMetadata ?? St?.saveMetadataDebounced;
    try {
        if (typeof fn === 'function') await fn.call(ctx);
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] saveMetadata failed`, error);
    }
}

function loadState() {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
        saveStateTimer = null;
    }
    const meta = getMetadata();
    state = new Map(Object.entries(meta?.dkRisuState ?? {}));
    localLorebooks = new Map(Object.entries(meta?.dkRisuLocalLore ?? {}));
}

function scheduleSaveChat() {
    if (saveChatTimer) clearTimeout(saveChatTimer);
    saveChatTimer = setTimeout(() => {
        saveChatTimer = null;
        void saveChat();
    }, 120);
}

async function saveChat() {
    const ctx = getCtx();
    const fn = ctx.saveChat ?? ctx.saveChatConditional ?? St?.saveChatConditional;
    try {
        if (typeof fn === 'function') await fn();
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] saveChat failed`, error);
    }
}

async function reloadChatDom() {
    await saveChat();
    const ctx = getCtx();
    const fn = ctx.reloadCurrentChat ?? St?.reloadCurrentChat;
    if (typeof fn !== 'function') {
        scheduleRender(40);
        return;
    }
    suppressChatChanged = true;
    try {
        await fn();
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] reloadCurrentChat failed`, error);
    } finally {
        setTimeout(() => { suppressChatChanged = false; }, 0);
    }
    scheduleRender(40);
}

function expandSimpleMacros(text) {
    let out = String(text ?? '');
    out = out.replace(/^@@\w+[^\n]*$/gm, '');
    out = out.replace(/\{\{assetlist\}\}/gi, () => JSON.stringify(assetNames));
    out = out.replace(/\{\{setvar::([^}:]+)::([^}]*)\}\}/gi, (_, key, value) => {
        setChatVarRaw(key.trim(), value);
        return '';
    });
    out = out.replace(/\{\{getvar::([^}]+)\}\}/gi, (_, key) => {
        const value = getChatVarRaw(key.trim());
        return value === 'null' ? '' : value;
    });
    out = out.replace(/\{\{user\}\}/gi, getCtx().name1 ?? '地下城主');
    out = out.replace(/\{\{char\}\}/gi, getCtx().name2 ?? getCardData()?.name ?? runtimeData?.card?.name ?? '');
    out = out.replace(/\{\{random::([^}]+)\}\}/gi, (_, choices) => {
        const parts = String(choices).split('::');
        return parts[Math.floor(Math.random() * parts.length)] ?? '';
    });
    out = out.replace(/\{\{raw::([^}]+)\}\}/gi, (_, name) => {
        const key = canonName(name);
        const asset = assetByName.get(key);
        return asset ? `${assetUrlBase}/${asset.st_name}.${asset.ext}` : '';
    });
    return out;
}

function evalWhen(expr) {
    const parts = String(expr ?? '').split('::');
    if (parts.length < 3) return false;
    const key = parts[0];
    const op = parts[1];
    const expected = parts.slice(2).join('::');
    const actual = getChatVarRaw(key);
    if (op === 'vis') return actual === expected;
    if (op === 'visnot') return actual !== expected;
    return false;
}

function parseConditionals(text) {
    const tokens = /\{\{#when::([^}]+)\}\}|\{\{:else\}\}|\{\{\/when\}\}/g;
    const root = { parts: [], condition: null, trueParts: [], falseParts: [], inElse: false };
    let frame = root;
    let last = 0;
    let match;
    const stack = [];
    const append = (value) => {
        if (frame.inElse) frame.falseParts.push(value);
        else frame.trueParts.push(value);
    };
    while ((match = tokens.exec(text)) !== null) {
        append(text.slice(last, match.index));
        last = tokens.lastIndex;
        if (match[1] !== undefined) {
            const child = {
                parts: [],
                condition: match[1],
                trueParts: [],
                falseParts: [],
                inElse: false,
            };
            append(child);
            stack.push(frame);
            frame = child;
        } else if (match[0] === '{{:else}}') {
            frame.inElse = true;
        } else if (match[0] === '{{/when}}') {
            frame.parts = evalWhen(frame.condition) ? frame.trueParts : frame.falseParts;
            frame = stack.pop() ?? root;
        }
    }
    append(text.slice(last));
    const render = (node) => {
        const parts = node.condition === null ? node.trueParts : node.parts;
        return parts.map(part => typeof part === 'string' ? part : render(part)).join('');
    };
    return render(root).replace(/\{\{#when[^}]*\}\}|\{\{:else\}\}|\{\{\/when\}\}/g, '');
}

function cbs(text) {
    return expandSimpleMacros(parseConditionals(String(text ?? '')));
}

function hexToUtf8(hex) {
    const clean = String(hex ?? '').replace(/\s+/g, '');
    if (!clean || clean.length % 2 !== 0) return '';
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    try {
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return '';
    }
}

function decodeRisuStyle(html) {
    return String(html ?? '').replace(/<risu-style>([0-9a-fA-F\s]+)<\/risu-style>/g, (_, hex) => {
        const css = hexToUtf8(hex);
        return css ? `<style>${css}</style>` : '';
    });
}

function sanitizeRisuHtml(html) {
    const source = String(html ?? '');
    if (typeof DOMParser === 'undefined') {
        return source.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, '');
    }
    try {
        const doc = new DOMParser().parseFromString(source, 'text/html');
        doc.querySelectorAll('script, iframe, object, embed').forEach(node => node.remove());
        doc.querySelectorAll('*').forEach(node => {
            for (const attr of Array.from(node.attributes || [])) {
                if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) {
                    node.removeAttribute(attr.name);
                }
            }
        });
        return doc.body.innerHTML;
    } catch {
        return source;
    }
}

function postProcessDisplay(html) {
    let out = String(html ?? '');
    out = cbs(out);
    out = decodeRisuStyle(out);
    out = sanitizeRisuHtml(out);
    return out;
}

function hashString(text) {
    let hash = 2166136261;
    const value = String(text ?? '');
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function sanitizerOverrides() {
    return {
        ADD_TAGS: ['custom-style', 'style', 'risu-style'],
        ADD_ATTR: [
            'risu-btn', 'risu-form', 'risu-trigger', 'risu-id', 'risu-ctrl', 'risu-mark',
            'loading', 'decoding', 'alt', 'src', 'class',
        ],
    };
}

function formatForDisplay(html, message, messageId) {
    const ctx = getCtx();
    const formatter = ctx.messageFormatter?.format
        ? ctx.messageFormatter.format.bind(ctx.messageFormatter)
        : (StMessageFormatter?.format
            ? StMessageFormatter.format.bind(StMessageFormatter)
            : (typeof St?.messageFormatting === 'function' ? St.messageFormatting : null));
    if (!formatter) return html;
    try {
        return formatter(
            html,
            message?.name ?? '',
            Boolean(message?.is_system),
            Boolean(message?.is_user),
            Number(messageId),
            sanitizerOverrides(),
            false,
        );
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] message formatting failed`, error);
        return sanitizeRisuHtml(html);
    }
}

function getRisuMessage(index) {
    const chat = getChatArray();
    const message = chat.at(Number(index));
    if (!message) return null;
    return {
        role: message.is_user ? 'user' : 'char',
        data: String(message.mes ?? ''),
        time: Number(message.send_date ?? 0),
    };
}

function toStMessage(role, data, old = {}) {
    const ctx = getCtx();
    const isUser = role === 'user';
    const mes = String(data ?? '');
    return {
        ...old,
        name: old.name ?? (isUser ? (ctx.name1 ?? 'User') : (ctx.name2 ?? getCardData()?.name ?? 'Assistant')),
        is_user: isUser,
        is_system: Boolean(old.is_system),
        mes,
        send_date: old.send_date ?? Date.now(),
        extra: old.extra ?? {},
        swipes: Array.isArray(old.swipes) ? old.swipes : [mes],
        swipe_id: old.swipe_id ?? 0,
    };
}

function loadClassicScript(url) {
    return new Promise((resolve, reject) => {
        if (globalThis.wasmoon?.LuaFactory) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${url}`));
        document.head.appendChild(script);
    });
}

async function loadText(file) {
    const response = await fetch(new URL(file, import.meta.url));
    if (!response.ok) throw new Error(`Failed to load ${file}: ${response.status}`);
    return await response.text();
}

async function loadJson(file) {
    const response = await fetch(new URL(file, import.meta.url));
    if (!response.ok) throw new Error(`Failed to load ${file}: ${response.status}`);
    return await response.json();
}


function getEmbeddedRuntimeData() {
    let payload = getCardData()?.extensions?.dk_runtime_payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { return null; }
    }
    return payload && typeof payload === 'object' ? payload : null;
}

function injectRuntimeCss(css) {
    if (!css || typeof document === 'undefined' || !document.head) return;
    let element = document.getElementById('dk-runtime-style');
    if (!element) {
        element = document.createElement('style');
        element.id = 'dk-runtime-style';
        document.head.appendChild(element);
    }
    element.textContent = String(css);
}

async function buildRuntime() {
    await ensureContextGetter();
    await ensureStModule();
    await ensureMessageFormatterModule();
    runtimeData = getEmbeddedRuntimeData();
    if (!runtimeData) {
        try {
            runtimeData = await loadJson('./runtime-data.json');
        } catch {
            throw new Error('RisuDKRuntime: dk_runtime_payload missing; import the GitHub-plugin-library card.');
        }
    }
    const wrapperLua = runtimeData.wrapperLua ?? await loadText('./lua_wrapper.lua');
    const moduleLua = runtimeData.luaCode ?? await loadText('./DungeonKeeper.lua');
    const jsonLua = runtimeData.jsonLua ?? await loadText('./json.lua');
    injectRuntimeCss(runtimeData.styleCss ?? '');
    const wasmoonScriptUrl = new URL('./wasmoon/index.js', import.meta.url).href;
    const wasmUrl = new URL('./wasmoon/glue.wasm', import.meta.url).href;
    await loadClassicScript(wasmoonScriptUrl);
    const LuaFactory = globalThis.wasmoon?.LuaFactory;
    if (!LuaFactory) throw new Error('Wasmoon LuaFactory unavailable');

    defaultVars = new Map();
    for (const line of String(runtimeData.defaultVariables ?? '').split(/\r?\n/)) {
        const index = line.indexOf('=');
        if (index > 0) defaultVars.set(line.slice(0, index), line.slice(index + 1));
    }
    assetNames = Array.isArray(runtimeData.assetNames) ? runtimeData.assetNames.slice() : [];
    assetByName = new Map((runtimeData.assets ?? []).map(asset => [asset.st_name, asset]));
    assetUrlBase = runtimeData.asset_base_url ?? '';
    loadState();

    const factory = new LuaFactory(wasmUrl);
    await factory.mountFile('json.lua', jsonLua);
    const lua = await factory.createEngine({ injectObjects: true, enableProxy: false });
    const g = lua.global;
    const declare = (name, fn) => g.set(name, fn);

    declare('getChatVar', (id, key) => getChatVarRaw(key));
    declare('setChatVar', (id, key, value) => { setChatVarRaw(key, value); });
    declare('setChatVarChanged', (id, key, value) => setChatVarRaw(key, value));
    declare('getGlobalVar', () => 'null');
    declare('stopChat', () => { stopSending = true; });
    declare('alertError', (id, value) => {
        console.error(`[${EXTENSION_NAME}] ${value}`);
        globalThis.toastr?.error?.(String(value ?? ''));
    });
    declare('alertNormal', (id, value) => {
        console.info(`[${EXTENSION_NAME}] ${value}`);
        globalThis.toastr?.info?.(String(value ?? ''));
    });
    declare('alertInput', (id, value) => Promise.resolve(globalThis.prompt?.(String(value ?? ''), '') ?? ''));
    declare('alertSelect', (id, choices) => {
        let list = [];
        try { list = Array.from(choices ?? []); } catch { list = Object.values(choices ?? {}); }
        const text = list.map((item, index) => `${index + 1}. ${item}`).join('\n');
        const answer = globalThis.prompt?.(`${text}\n输入序号：`, '1') ?? '';
        const number = Number.parseInt(String(answer), 10);
        return Promise.resolve(Number.isFinite(number) ? String(number - 1) : '');
    });
    declare('alertConfirm', (id, value) => Promise.resolve(Boolean(globalThis.confirm?.(String(value ?? '')))));
    declare('getChatMain', (id, index) => JSON.stringify(getRisuMessage(index)));
    declare('getChatData', (id, index) => getRisuMessage(index)?.data ?? '');
    declare('getChatRole', (id, index) => getRisuMessage(index)?.role ?? '');
    declare('getRecentChatsMain', (id, count) => {
        const chat = getChatArray();
        const safeCount = Math.max(0, Math.floor(Number(count) || 0));
        return JSON.stringify(chat.slice(Math.max(0, chat.length - safeCount)).map(message => ({
            role: message.is_user ? 'user' : 'char',
            data: String(message.mes ?? ''),
            time: Number(message.send_date ?? 0),
        })));
    });
    declare('setChat', (id, index, value) => {
        const chat = getChatArray();
        const message = chat.at(Number(index));
        if (message) message.mes = String(value ?? '');
        scheduleSaveChat();
        scheduleRender(120);
    });
    declare('setChatRole', (id, index, value) => {
        const chat = getChatArray();
        const message = chat.at(Number(index));
        if (message) message.is_user = value === 'user';
        scheduleSaveChat();
        scheduleRender(120);
    });
    declare('cutChat', (id, start, end) => {
        const chat = getChatArray();
        const replacement = chat.slice(Number(start), Number(end));
        chat.splice(0, chat.length, ...replacement);
        scheduleSaveChat();
        scheduleRender(120);
    });
    declare('removeChat', (id, index) => {
        const chat = getChatArray();
        chat.splice(Number(index), 1);
        scheduleSaveChat();
        scheduleRender(120);
    });
    declare('addChat', (id, role, value) => {
        const chat = getChatArray();
        chat.push(toStMessage(role, value));
        scheduleSaveChat();
        scheduleRender(120);
    });
    declare('insertChat', (id, index, role, value) => {
        const chat = getChatArray();
        chat.splice(Number(index), 0, toStMessage(role, value));
        scheduleSaveChat();
        scheduleRender(120);
    });
    declare('getTokens', (id, value) => Promise.resolve(Math.ceil(String(value ?? '').length / 4)));
    declare('getChatLength', () => getChatArray().length);
    declare('getFullChatMain', () => JSON.stringify(getChatArray().map(message => ({
        role: message.is_user ? 'user' : 'char',
        data: String(message.mes ?? ''),
        time: Number(message.send_date ?? 0),
    }))));
    declare('sleep', (id, time) => new Promise(resolve => setTimeout(() => resolve(true), Number(time) || 0)));
    declare('cbs', value => cbs(value));
    declare('setFullChatMain', (id, value) => {
        try {
            const parsed = JSON.parse(String(value ?? '[]'));
            const chat = getChatArray();
            const old = chat.slice();
            const replacement = parsed.map((message, index) => toStMessage(message?.role, message?.data, old[index] ?? {}));
            chat.splice(0, chat.length, ...replacement);
            scheduleSaveChat();
            scheduleRender(120);
        } catch (error) {
            console.debug(`[${EXTENSION_NAME}] setFullChatMain failed`, error);
        }
    });
    declare('logMain', value => console.log(`[${EXTENSION_NAME}]`, value));
    declare('reloadDisplay', () => { reloadCount++; scheduleRender(60); });
    declare('reloadChat', () => { reloadCount++; scheduleRender(60); });
    declare('similarity', () => Promise.resolve([]));
    declare('request', () => Promise.resolve(JSON.stringify({ status: 400, data: 'disabled in ST runtime' })));
    declare('generateImage', () => Promise.resolve(''));
    declare('getCharacterImageMain', () => Promise.resolve(''));
    declare('getPersonaImageMain', () => Promise.resolve(''));
    declare('hash', (id, value) => Promise.resolve(hashString(value)));
    declare('LLMMain', () => Promise.resolve(JSON.stringify({ success: false, result: 'LLM helper disabled in ST runtime' })));
    declare('axLLMMain', () => Promise.resolve(JSON.stringify({ success: false, result: 'axLLM helper disabled in ST runtime' })));
    declare('simpleLLM', () => Promise.resolve({ success: false, result: 'LLM helper disabled in ST runtime' }));
    declare('getName', () => getCtx().name2 ?? getCardData()?.name ?? runtimeData.card?.name ?? '');
    declare('setName', () => undefined);
    declare('getDescription', () => getCardData()?.description ?? runtimeData.card?.description ?? '');
    declare('setDescription', () => undefined);
    declare('getCharacterFirstMessage', () => getCardData()?.first_mes ?? runtimeData.card?.first_mes ?? '');
    declare('setCharacterFirstMessage', () => false);
    declare('getPersonaName', () => getCtx().name1 ?? '地下城主');
    declare('getPersonaDescription', () => '');
    declare('getAuthorsNote', () => getMetadata()?.note?.prompt ?? '');
    declare('getBackgroundEmbedding', () => runtimeData.backgroundHTML ?? '');
    declare('setBackgroundEmbedding', () => true);
    declare('getLoreBooksMain', (id, search) => {
        const all = [...localLorebooks.values(), ...(runtimeData.lorebooks ?? [])];
        return JSON.stringify(all
            .filter(book => (book?.comment ?? book?.name) === search)
            .map(book => ({ ...book, content: cbs(book?.content ?? '') })));
    });
    declare('upsertLocalLoreBook', (id, name, content, options) => {
        const opts = options && typeof options === 'object' ? options : {};
        localLorebooks.set(String(name), {
            comment: String(name),
            content: String(content ?? ''),
            key: opts.key ?? '',
            secondkey: opts.secondKey ?? '',
            insertorder: opts.insertOrder ?? 100,
            alwaysActive: opts.alwaysActive ?? false,
            selective: Boolean(opts.secondKey),
            useRegex: opts.regex ?? false,
            mode: 'normal',
        });
        scheduleSaveState();
    });
    declare('loadLoreBooksMain', () => Promise.resolve(JSON.stringify([])));
    declare('getCharacterLastMessage', () => {
        const chat = getChatArray();
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i]?.is_user) return String(chat[i]?.mes ?? '');
        }
        return getCardData()?.first_mes ?? runtimeData.card?.first_mes ?? '';
    });
    declare('getUserLastMessage', () => {
        const chat = getChatArray();
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) return String(chat[i]?.mes ?? '');
        }
        return '';
    });

    await lua.doString(`${wrapperLua}\n${moduleLua}`);
    runtime = { factory, lua, g };
    return runtime;
}

async function ensureRuntime() {
    if (runtime) return runtime;
    if (!runtimePromise) {
        runtimePromise = buildRuntime().then(value => {
            runtime = value;
            return value;
        }).catch(error => {
            runtimePromise = null;
            throw error;
        });
    }
    return runtimePromise;
}

async function callLua(name, ...args) {
    await ensureRuntime();
    return withLua(async () => {
        const fn = runtime.g.get(name);
        if (!fn) return undefined;
        return await fn(...args);
    });
}

async function maybeStart(force = false) {
    if (!isActive()) return;
    await ensureRuntime();
    const chatId = getChatId();
    if (!force && lastStartedChatId === chatId) return;
    loadState();
    await callLua('callListenMain', 'editDisplay', ACCESS, runtimeData.backgroundHTML ?? '', JSON.stringify({ index: -1 }));
    await callLua('onStart', ACCESS);
    lastStartedChatId = chatId;
    lastChatId = chatId;
    await saveState();
    await saveChat();
    scheduleRender(40);
}

function getLastUserSignature() {
    const chat = getChatArray();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user) return `${getChatId()}:${i}:${hashString(chat[i]?.mes ?? '')}`;
    }
    return `${getChatId()}:none`;
}

async function maybeInput(force = false) {
    if (!isActive()) return;
    await ensureRuntime();
    const signature = getLastUserSignature();
    if (!force && lastInputSignature === signature) return;
    await maybeStart();
    await callLua('onInput', ACCESS);
    lastInputSignature = signature;
    await saveState();
    await saveChat();
    scheduleRender(40);
}

async function processOutput(messageId) {
    if (!isActive()) return;
    await ensureRuntime();
    await maybeStart();
    const chat = getChatArray();
    const index = Number.isFinite(Number(messageId)) ? Number(messageId) : chat.length - 1;
    const raw = String(chat[index]?.mes ?? '');
    const signature = `${getChatId()}:${index}:${hashString(raw)}`;
    if (lastOutputSignature === signature) return;
    lastOutputSignature = signature;
    const before = chat.length;
    await callLua('onOutput', ACCESS);
    await saveState();
    await saveChat();
    if (getChatArray().length !== before) await reloadChatDom();
    else scheduleRender(30);
}

async function handleButtonClick(data) {
    if (!isActive()) return;
    await ensureRuntime();
    await maybeStart();
    const before = getChatArray().length;
    await callLua('onButtonClick', ACCESS, String(data ?? ''));
    await saveState();
    await saveChat();
    if (getChatArray().length !== before) await reloadChatDom();
    else scheduleRender(30);
}

function scheduleRender(delay = 80) {
    if (!isActive()) return;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
        renderTimer = null;
        void renderAllMessages();
    }, delay);
}

async function renderAllMessages() {
    if (rendering || !isActive()) return;
    await ensureContextGetter();
    await ensureRuntime();
    const nodes = Array.from(document.querySelectorAll('#chat .mes[mesid]'));
    if (!nodes.length) return;
    rendering = true;
    try {
        const chat = getChatArray();
        for (const node of nodes) {
            const index = Number(node.getAttribute('mesid'));
            const message = chat[index];
            if (!message) continue;
            let html = await callLua('callListenMain', 'editDisplay', ACCESS, String(message.mes ?? ''), JSON.stringify({ index }));
            html = postProcessDisplay(html);
            html = formatForDisplay(html, message, index);
            const hash = hashString(html);
            const textNode = node.querySelector('.mes_text');
            if (textNode && node.dataset.dkHash !== hash) {
                textNode.innerHTML = html;
                node.dataset.dkHash = hash;
            }
        }
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] render failed`, error);
    } finally {
        globalThis.requestAnimationFrame?.(() => { rendering = false; });
        if (!globalThis.requestAnimationFrame) rendering = false;
    }
}

async function generationInterceptor(coreChat, abort) {
    if (!isActive() || !Array.isArray(coreChat)) return;
    await ensureContextGetter();
    await ensureRuntime();
    await maybeStart();
    await maybeInput();
    const old = coreChat.slice();
    const request = coreChat.map(message => ({
        role: message?.is_user ? 'user' : 'assistant',
        content: cbs(String(message?.mes ?? '')),
    }));
    const edited = await callLua('callListenMain', 'editRequest', ACCESS, JSON.stringify(request), JSON.stringify({}));
    let parsed;
    try {
        parsed = JSON.parse(String(edited ?? '[]'));
    } catch {
        parsed = request;
    }
    if (!Array.isArray(parsed)) parsed = request;
    const replacement = parsed.map((message, index) => ({
        ...(old[index] ?? {}),
        mes: String(message?.content ?? ''),
        is_user: message?.role === 'user',
        is_system: Boolean(old[index]?.is_system),
    }));
    coreChat.splice(0, coreChat.length, ...replacement);
    await saveState();
    if (stopSending) {
        stopSending = false;
        if (typeof abort === 'function') abort(true);
    }
}

globalThis.dkRuntimeGenerationInterceptor = async function (coreChat, contextSize, abort, type) {
    try {
        await generationInterceptor(coreChat, abort);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] generation interceptor failed`, error);
    }
};

function registerEvents() {
    const ctx = getCtx();
    const eventSource = ctx.eventSource ?? St?.eventSource ?? globalThis.eventSource;
    const eventTypes = ctx.eventTypes ?? St?.event_types ?? {};
    if (!eventSource?.on) return;
    const eventName = key => eventTypes[key] ?? FALLBACK_EVENTS[key];
    const wrap = fn => (...args) => {
        Promise.resolve(fn(...args)).catch(error => console.error(`[${EXTENSION_NAME}] event handler failed`, error));
    };
    const on = (key, fn) => {
        const name = eventName(key);
        if (name) eventSource.on(name, wrap(fn));
    };

    on('APP_READY', async () => { await maybeStart(true); scheduleRender(100); });
    on('CHAT_CHANGED', async () => {
        if (suppressChatChanged) {
            scheduleRender(40);
            return;
        }
        lastInputSignature = null;
        lastOutputSignature = null;
        loadState();
        await maybeStart(true);
        scheduleRender(60);
    });
    on('CHAT_CREATED', async () => {
        lastStartedChatId = null;
        await maybeStart(true);
    });
    on('MESSAGE_SENT', async () => {
        await maybeInput(true);
    });
    on('USER_MESSAGE_RENDERED', async () => { scheduleRender(30); });
    on('CHARACTER_MESSAGE_RENDERED', async (messageId) => { await processOutput(messageId); });
    on('GENERATION_ENDED', async () => { await processOutput(getChatArray().length - 1); });
    on('MESSAGE_EDITED', async () => { scheduleRender(60); });
    on('MESSAGE_DELETED', async () => { scheduleRender(60); });
    on('MESSAGE_SWIPED', async () => { scheduleRender(60); });
    on('MORE_MESSAGES_LOADED', async () => { scheduleRender(120); });
    on('WORLDINFO_ENTRIES_LOADED', async (payload) => {
        if (!isActive()) return;
        await ensureRuntime();
        await maybeStart();
        for (const collection of [payload?.globalLore, payload?.characterLore, payload?.chatLore, payload?.personaLore]) {
            if (!Array.isArray(collection)) continue;
            for (const entry of collection) {
                if (entry && typeof entry.content === 'string') entry.content = cbs(entry.content);
            }
        }
    });
    on('WORLD_INFO_ACTIVATED', async (entries) => {
        if (!isActive() || !Array.isArray(entries)) return;
        await ensureRuntime();
        for (const entry of entries) {
            if (entry && typeof entry.content === 'string') entry.content = cbs(entry.content);
        }
    });
}

function setupDom() {
    document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('#chat [risu-btn]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        void handleButtonClick(button.getAttribute('risu-btn'));
    }, true);

    if (observer) return;
    const chatElement = document.getElementById('chat');
    if (!chatElement || typeof MutationObserver === 'undefined') {
        setTimeout(setupDom, 1000);
        return;
    }
    observer = new MutationObserver(() => {
        if (!rendering) scheduleRender(140);
    });
    observer.observe(chatElement, { childList: true, subtree: true, characterData: true });
}

async function init() {
    if (initialized) return;
    initialized = true;
    await ensureContextGetter();
    void ensureStModule();
    void ensureMessageFormatterModule();
    registerEvents();
    setupDom();
    setTimeout(setupDom, 1200);
    scheduleRender(200);
    console.info(`[${EXTENSION_NAME}] full dynamic runtime initialized`);
}

export function onActivate() {
    void init();
}

setTimeout(() => { void init(); }, 0);
