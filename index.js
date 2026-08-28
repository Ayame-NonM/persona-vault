const MODULE = 'persona_vault';
const VERSION = '0.1.3';

let personas = [];
let filtered = [];
let selected = new Set();
let mounted = false;

function ctx() {
    return SillyTavern.getContext();
}

function requestHeaders() {
    if (typeof window.getRequestHeaders === 'function') return window.getRequestHeaders();
    const c = ctx();
    if (typeof c.getRequestHeaders === 'function') return c.getRequestHeaders();
    return { 'Content-Type': 'application/json' };
}

async function postJson(url, body = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
}

async function getPowerUser() {
    // Personas are already available in the live SillyTavern context.
    // Reading them directly is faster and avoids depending on the settings API shape.
    return ctx().powerUserSettings || {};
}

function normalizePersona(avatar, name, rawDescription) {
    const meta = rawDescription && typeof rawDescription === 'object'
        ? rawDescription
        : {};
    const description = typeof rawDescription === 'string'
        ? rawDescription
        : String(meta.description || '');

    return {
        avatar,
        name: String(name || 'Без имени'),
        description,
        title: String(meta.title || ''),
        position: meta.position ?? null,
        depth: meta.depth ?? null,
        role: meta.role ?? null,
    };
}

async function loadPersonas() {
    const powerUser = await getPowerUser();
    const names = powerUser?.personas && typeof powerUser.personas === 'object'
        ? powerUser.personas
        : {};
    const descriptions = powerUser?.persona_descriptions && typeof powerUser.persona_descriptions === 'object'
        ? powerUser.persona_descriptions
        : {};

    personas = Object.entries(names)
        .map(([avatar, name]) => normalizePersona(avatar, name, descriptions[avatar]))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    filtered = personas.slice();
    selected.clear();
    renderGrid();
    setStatus(`Найдено персон: ${personas.length}`);
}

function avatarUrl(filename) {
    return `/User Avatars/${encodeURIComponent(filename).replaceAll('%2F', '/')}`;
}

function safeFileName(value) {
    const cleaned = String(value || 'persona')
        .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '')
        .trim();
    return (cleaned || 'persona').slice(0, 100);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(binary);
}

function cardPayload(persona) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: persona.name,
            description: persona.description,
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: 'SillyTavern Persona backup. Import this PNG as a Character, then use Convert to Persona. The Description is the original persona text; keep its macros unchanged when restoring.',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['persona-backup'],
            creator: 'Persona Vault',
            character_version: '1.0',
            extensions: {
                persona_vault: {
                    backup: true,
                    source_avatar: persona.avatar,
                    exporter_version: VERSION,
                    title: persona.title,
                    position: persona.position,
                    depth: persona.depth,
                    role: persona.role,
                    exported_at: new Date().toISOString(),
                    extension_version: VERSION,
                },
            },
        },
    };
}

async function fetchAvatarBlob(persona) {
    const response = await fetch(avatarUrl(persona.avatar), { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Не удалось загрузить аватар: HTTP ${response.status}`);
    return response.blob();
}

async function toPngBytes(blob) {
    const source = new Uint8Array(await blob.arrayBuffer());
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (pngSignature.every((byte, index) => source[index] === byte)) return source;

    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();

    const pngBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('Не удалось конвертировать аватар в PNG')), 'image/png');
    });
    return new Uint8Array(await pngBlob.arrayBuffer());
}

let crcTable;
function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u32be(value) {
    return new Uint8Array([
        (value >>> 24) & 0xFF,
        (value >>> 16) & 0xFF,
        (value >>> 8) & 0xFF,
        value & 0xFF,
    ]);
}

function concatBytes(...parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function pngChunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    const crcInput = concatBytes(typeBytes, data);
    return concatBytes(u32be(data.length), typeBytes, data, u32be(crc32(crcInput)));
}

function readU32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function typeAt(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function isCardTextChunk(type, data) {
    if (type !== 'tEXt') return false;
    const zero = data.indexOf(0);
    if (zero < 0) return false;
    const key = new TextDecoder('latin1').decode(data.subarray(0, zero)).toLowerCase();
    return key === 'chara' || key === 'ccv3';
}

function embedCharacterCard(pngBytes, payload) {
    const signature = pngBytes.slice(0, 8);
    const chunks = [];
    let offset = 8;

    while (offset + 12 <= pngBytes.length) {
        const length = readU32(pngBytes, offset);
        const type = typeAt(pngBytes, offset + 4);
        const end = offset + 12 + length;
        if (end > pngBytes.length) throw new Error('Повреждённый PNG');

        const data = pngBytes.slice(offset + 8, offset + 8 + length);
        const wholeChunk = pngBytes.slice(offset, end);

        if (type === 'IEND') {
            const encoded = utf8ToBase64(JSON.stringify(payload));
            const textData = concatBytes(
                new TextEncoder().encode('chara'),
                new Uint8Array([0]),
                new TextEncoder().encode(encoded),
            );
            chunks.push(pngChunk('tEXt', textData));
            chunks.push(wholeChunk);
            return concatBytes(signature, ...chunks);
        }

        if (!isCardTextChunk(type, data)) chunks.push(wholeChunk);
        offset = end;
    }

    throw new Error('PNG не содержит IEND');
}

async function buildPersonaPng(persona) {
    const avatarBlob = await fetchAvatarBlob(persona);
    const pngBytes = await toPngBytes(avatarBlob);
    const output = embedCharacterCard(pngBytes, cardPayload(persona));
    return new Blob([output], { type: 'image/png' });
}

async function exportPng(persona) {
    try {
        setStatus(`Собираю PNG: ${persona.name}…`);
        const blob = await buildPersonaPng(persona);
        downloadBlob(blob, `${safeFileName(persona.name)}.persona.png`);
        setStatus(`PNG готов: ${persona.name}`);
    } catch (error) {
        showError(error);
    }
}

function exportTxt(persona) {
    const blob = new Blob([persona.description], { type: 'text/plain;charset=utf-8' });
    downloadBlob(blob, `${safeFileName(persona.name)}.persona.txt`);
    setStatus(`TXT готов: ${persona.name}`);
}

let zipReady = false;
async function ensureZip() {
    if (window.JSZip) return true;
    if (zipReady) return Boolean(window.JSZip);
    zipReady = true;
    return new Promise(resolve => {
        const script = document.createElement('script');
        script.src = '/lib/jszip.min.js';
        script.onload = () => resolve(Boolean(window.JSZip));
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
}

function uniqueZipFileName(persona, usedNames) {
    const base = safeFileName(persona.name);
    const avatarStem = safeFileName(String(persona.avatar || 'avatar').replace(/\.[^.]+$/, ''));
    const uniqueId = avatarStem.slice(-18) || 'avatar';
    let candidate = `${base} [${uniqueId}].persona.png`;
    let index = 2;

    while (usedNames.has(candidate.toLocaleLowerCase())) {
        candidate = `${base} [${uniqueId}-${index}].persona.png`;
        index += 1;
    }

    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
}

async function exportSelectedZip() {
    const items = personas.filter(persona => selected.has(persona.avatar));
    if (!items.length) return setStatus('Сначала выбери хотя бы одну персону.');

    try {
        if (!(await ensureZip())) throw new Error('JSZip не найден в SillyTavern');
        const zip = new JSZip();
        const usedNames = new Set();

        for (let i = 0; i < items.length; i++) {
            const persona = items[i];
            setStatus(`PNG ${i + 1}/${items.length}: ${persona.name}`);
            const blob = await buildPersonaPng(persona);
            const filename = uniqueZipFileName(persona, usedNames);
            zip.file(filename, await blob.arrayBuffer());
        }

        const entryCount = Object.values(zip.files).filter(entry => !entry.dir).length;
        if (entryCount !== items.length) {
            throw new Error(`ZIP содержит ${entryCount} из ${items.length} подготовленных файлов`);
        }

        setStatus(`Упаковываю ZIP · ${entryCount}/${items.length}…`);
        const archive = await zip.generateAsync({ type: 'blob' });
        const stamp = new Date().toISOString().slice(0, 10);
        downloadBlob(archive, `persona-vault-${stamp}.zip`);
        setStatus(`Готово: ${items.length} PNG в ZIP.`);
    } catch (error) {
        showError(error);
    }
}

function showError(error) {
    console.error(`[${MODULE}]`, error);
    setStatus(`Ошибка: ${error?.message || error}`, true);
    window.toastr?.error?.(error?.message || String(error), 'Persona Vault');
}

function setStatus(text, isError = false) {
    const element = document.querySelector('#pv-status');
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('is-error', isError);
}

function updateSelectionUi() {
    document.querySelector('#pv-selected-count')?.replaceChildren(document.createTextNode(String(selected.size)));
    document.querySelectorAll('.pv-card').forEach(card => {
        card.classList.toggle('is-selected', selected.has(card.dataset.avatar));
        const input = card.querySelector('.pv-check');
        if (input) input.checked = selected.has(card.dataset.avatar);
    });
}

function makeButton(label, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', event => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

function buildCard(persona) {
    const card = document.createElement('article');
    card.className = 'pv-card';
    card.dataset.avatar = persona.avatar;

    const imageWrap = document.createElement('div');
    imageWrap.className = 'pv-image-wrap';

    const image = document.createElement('img');
    image.className = 'pv-image';
    image.src = avatarUrl(persona.avatar);
    image.alt = persona.name;
    image.loading = 'lazy';
    imageWrap.appendChild(image);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pv-check';
    check.setAttribute('aria-label', `Выбрать ${persona.name}`);
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => {
        check.checked ? selected.add(persona.avatar) : selected.delete(persona.avatar);
        updateSelectionUi();
    });
    imageWrap.appendChild(check);

    const body = document.createElement('div');
    body.className = 'pv-card-body';

    const name = document.createElement('h3');
    name.className = 'pv-name';
    name.textContent = persona.name;

    const preview = document.createElement('p');
    preview.className = 'pv-description';
    preview.textContent = persona.description || 'Описание пустое';

    const actions = document.createElement('div');
    actions.className = 'pv-card-actions';
    actions.append(
        makeButton('PNG', 'pv-btn pv-btn-primary', () => exportPng(persona)),
        makeButton('TXT', 'pv-btn', () => exportTxt(persona)),
    );

    body.append(name, preview, actions);
    card.append(imageWrap, body);

    card.addEventListener('click', () => {
        selected.has(persona.avatar) ? selected.delete(persona.avatar) : selected.add(persona.avatar);
        updateSelectionUi();
    });

    return card;
}

function renderGrid() {
    const grid = document.querySelector('#pv-grid');
    if (!grid) return;
    grid.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'pv-empty';
        empty.textContent = personas.length ? 'Ничего не найдено.' : 'Персоны не найдены.';
        grid.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach(persona => fragment.appendChild(buildCard(persona)));
    grid.appendChild(fragment);
    updateSelectionUi();
}

function filterBy(query) {
    const value = String(query || '').trim().toLocaleLowerCase('ru');
    filtered = value
        ? personas.filter(p => `${p.name}\n${p.description}`.toLocaleLowerCase('ru').includes(value))
        : personas.slice();
    renderGrid();
}

function openVault() {
    document.querySelector('#pv-modal')?.classList.add('is-open');
    document.body.classList.add('pv-lock-scroll');
    loadPersonas().catch(showError);
}

function closeVault() {
    document.querySelector('#pv-modal')?.classList.remove('is-open');
    document.body.classList.remove('pv-lock-scroll');
}

function mountModal() {
    if (document.querySelector('#pv-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'pv-modal';
    modal.className = 'pv-modal';
    modal.innerHTML = `
        <div class="pv-backdrop" data-pv-close></div>
        <section class="pv-window" role="dialog" aria-modal="true" aria-label="Persona Vault">
            <header class="pv-window-head">
                <div>
                    <div class="pv-kicker">✦ ARCANE ARCHIVE ✦</div>
                    <h2>Persona Vault <small style="opacity:.55;font-size:.45em">v${VERSION}</small></h2>
                    <p>Персоны → переносимые PNG-карточки или чистый TXT.</p>
                </div>
                <button type="button" class="pv-close" data-pv-close aria-label="Закрыть">×</button>
            </header>

            <div class="pv-toolbar">
                <input id="pv-search" class="pv-search" type="search" placeholder="Поиск по персонам…" autocomplete="off">
                <button type="button" id="pv-select-all" class="pv-btn">Выбрать все</button>
                <button type="button" id="pv-clear" class="pv-btn">Снять</button>
                <button type="button" id="pv-download-selected" class="pv-btn pv-btn-primary">PNG ZIP · <span id="pv-selected-count">0</span></button>
                <button type="button" id="pv-refresh" class="pv-btn pv-icon-btn" title="Обновить">↻</button>
            </div>

            <div id="pv-status" class="pv-status">Готово к загрузке.</div>
            <div id="pv-grid" class="pv-grid"></div>
        </section>
    `;

    document.body.appendChild(modal);

    modal.querySelectorAll('[data-pv-close]').forEach(node => node.addEventListener('click', closeVault));
    modal.querySelector('#pv-search').addEventListener('input', event => filterBy(event.target.value));
    modal.querySelector('#pv-refresh').addEventListener('click', () => loadPersonas().catch(showError));
    modal.querySelector('#pv-download-selected').addEventListener('click', exportSelectedZip);
    modal.querySelector('#pv-select-all').addEventListener('click', () => {
        filtered.forEach(persona => selected.add(persona.avatar));
        updateSelectionUi();
    });
    modal.querySelector('#pv-clear').addEventListener('click', () => {
        selected.clear();
        updateSelectionUi();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeVault();
    });
}

function mountSettingsEntry() {
    if (document.querySelector('#pv-settings')) return;
    const host = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
    if (!host) return false;

    const root = document.createElement('div');
    root.id = 'pv-settings';
    root.className = 'pv-settings';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>✦ Persona Vault ✦ <small style="opacity:.55">v${VERSION}</small></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p class="pv-settings-copy">Резервные PNG-карточки и TXT для ваших персон.</p>
                <button type="button" id="pv-open" class="menu_button">Открыть хранилище персон</button>
            </div>
        </div>
    `;
    host.appendChild(root);
    root.querySelector('#pv-open').addEventListener('click', openVault);
    return true;
}

function mount() {
    if (mounted) return;
    mountModal();

    if (mountSettingsEntry()) {
        mounted = true;
        console.log(`[${MODULE}] v${VERSION} loaded`);
        return;
    }

    const observer = new MutationObserver(() => {
        if (mountSettingsEntry()) {
            observer.disconnect();
            mounted = true;
            console.log(`[${MODULE}] v${VERSION} loaded`);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

let bootStarted = false;

function boot() {
    if (bootStarted) return;
    bootStarted = true;

    const start = () => {
        try {
            mount();
        } catch (error) {
            console.error(`[${MODULE}] failed to mount`, error);
            window.toastr?.error?.(error?.message || String(error), 'Persona Vault');
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        setTimeout(start, 0);
    }
}

export function init() {
    boot();
}

// Also self-start when the module is loaded. The manifest hook calls init() too,
// but this fallback keeps the extension working on ST builds/forks where lifecycle
// hooks behave differently.
boot();
