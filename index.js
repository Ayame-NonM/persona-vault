const MODULE = 'persona_vault';
const VERSION = '0.2.2';

const state = {
    personas: [],
    filtered: [],
    selected: new Set(),
    mounted: false,
    zipPromise: null,
};

function ctx() {
    return SillyTavern.getContext();
}

function powerUser() {
    return ctx().powerUserSettings || {};
}

function lower(value) {
    return String(value ?? '').trim().toLocaleLowerCase('ru');
}

function firstNonNull(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
}

function uniqueObjects(items) {
    const seen = new Set();
    return items.filter(item => {
        if (!item || typeof item !== 'object') return false;
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
    });
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
    return (cleaned || 'persona').slice(0, 110);
}

function splitKeys(value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeLoreRef(ref) {
    if (!ref) return null;
    if (typeof ref === 'string') return { name: ref };
    if (typeof ref === 'number') return { id: ref };
    if (typeof ref !== 'object') return null;

    return {
        name: firstNonNull(ref.name, ref.title, ref.world, ref.world_info, ref.filename, ref.file),
        id: firstNonNull(ref.id, ref.uid, ref.world_id, ref.world_info_uid),
        data: ref.entries || ref.data?.entries ? (ref.data || ref) : null,
    };
}

function resolvePersonaLoreBinding(avatar, rawMeta, settings) {
    const direct = firstNonNull(
        rawMeta?.persona_lore,
        rawMeta?.personaLore,
        rawMeta?.lorebook,
        rawMeta?.lore_book,
        rawMeta?.world_info,
        rawMeta?.worldInfo,
        settings?.persona_lore?.[avatar],
        settings?.personaLore?.[avatar],
        settings?.persona_lorebook?.[avatar],
        settings?.persona_lorebooks?.[avatar],
        settings?.persona_world_info?.[avatar],
        settings?.personaWorldInfo?.[avatar],
        settings?.persona_world?.[avatar],
        settings?.personaWorld?.[avatar],
        settings?.persona_metadata?.[avatar]?.persona_lore,
        settings?.persona_metadata?.[avatar]?.lorebook,
        settings?.persona_metadata?.[avatar]?.world_info,
        settings?.personaMetadata?.[avatar]?.persona_lore,
        settings?.personaMetadata?.[avatar]?.lorebook,
        settings?.personaMetadata?.[avatar]?.world_info,
    );

    return normalizeLoreRef(direct);
}

function looksLikeLorebook(value) {
    return Boolean(
        value && typeof value === 'object' &&
        (Array.isArray(value.entries) || (value.entries && typeof value.entries === 'object'))
    );
}

function lorebookNameOf(value) {
    return firstNonNull(value?.name, value?.title, value?.world_name, value?.worldName, value?.filename, value?.file);
}

function lorebookIdOf(value) {
    return firstNonNull(value?.id, value?.uid, value?.world_id, value?.worldInfoUid, value?.world_info_uid);
}

function gatherLoreStores(settings) {
    const c = ctx();
    return uniqueObjects([
        c.worldInfo,
        c.world_info,
        c.worldInfoCache,
        c.world_info_cache,
        c.worldNames,
        c.world_names,
        c.lorebooks,
        c.worlds,
        c.data?.worldInfo,
        c.data?.world_info,
        settings.worldInfo,
        settings.world_info,
        settings.worldInfoCache,
        settings.world_info_cache,
        settings.worlds,
        settings.world_names,
        settings.worldNames,
        window.worldInfo,
        window.world_info,
        window.worldInfoCache,
        window.world_names,
    ]);
}

function directLorebookLookup(store, binding) {
    if (!store || !binding) return null;

    const wantedName = lower(binding.name);
    const wantedId = String(binding.id ?? '').trim();

    const probe = candidate => {
        if (!candidate || typeof candidate !== 'object') return null;
        if (!looksLikeLorebook(candidate)) return null;

        const candidateName = lower(lorebookNameOf(candidate));
        const candidateId = String(lorebookIdOf(candidate) ?? '').trim();

        if (wantedName && candidateName && candidateName === wantedName) return candidate;
        if (wantedId && candidateId && candidateId === wantedId) return candidate;
        return null;
    };

    if (Array.isArray(store)) {
        for (const item of store) {
            const found = probe(item);
            if (found) return found;
        }
        return null;
    }

    if (typeof store === 'object') {
        if (wantedName && store[wantedName]) {
            const found = probe(store[wantedName]);
            if (found) return found;
        }
        if (binding.name && store[binding.name]) {
            const found = probe(store[binding.name]);
            if (found) return found;
        }
        if (wantedId && store[wantedId]) {
            const found = probe(store[wantedId]);
            if (found) return found;
        }

        if (looksLikeLorebook(store)) {
            const found = probe(store);
            if (found) return found;
        }

        for (const value of Object.values(store)) {
            const found = probe(value);
            if (found) return found;
        }
    }

    return null;
}

function normalizeCharacterBook(source, fallbackName = '') {
    if (!looksLikeLorebook(source)) return null;

    const rawEntries = Array.isArray(source.entries)
        ? source.entries
        : Object.values(source.entries || {});

    const entries = rawEntries
        .map((entry, index) => {
            if (!entry || typeof entry !== 'object') return null;

            const content = String(firstNonNull(entry.content, entry.text, entry.entry, entry.value, entry.memo, '')).trim();
            const keys = splitKeys(firstNonNull(entry.keys, entry.key, entry.primary_keys));
            const secondary = splitKeys(firstNonNull(entry.secondary_keys, entry.keysecondary, entry.secondary));
            const enabled = entry.enabled ?? !entry.disable;

            if (!content) return null;

            return {
                keys,
                content,
                extensions: typeof entry.extensions === 'object' && entry.extensions ? entry.extensions : {},
                enabled: Boolean(enabled),
                insertion_order: Number(firstNonNull(entry.insertion_order, entry.order, entry.display_index, index)) || 0,
                case_sensitive: Boolean(firstNonNull(entry.case_sensitive, entry.caseSensitive, false)),
                id: firstNonNull(entry.id, entry.uid, index),
                name: firstNonNull(entry.name, entry.comment, entry.title) || undefined,
                comment: firstNonNull(entry.comment, entry.memo) || undefined,
                selective: Boolean(firstNonNull(entry.selective, entry.selectiveLogic, false)),
                secondary_keys: secondary.length ? secondary : undefined,
                constant: Boolean(firstNonNull(entry.constant, entry.always_active, false)),
                position: firstNonNull(entry.position, entry.insertion_position, entry.place) || undefined,
                priority: firstNonNull(entry.priority, entry.weight) ?? undefined,
            };
        })
        .filter(Boolean);

    if (!entries.length) return null;

    return {
        name: String(firstNonNull(lorebookNameOf(source), fallbackName, 'Persona Lore')).trim() || 'Persona Lore',
        description: String(firstNonNull(source.description, source.comment, '')).trim(),
        scan_depth: Number(firstNonNull(source.scan_depth, source.scanDepth, source.depth, 4)) || 4,
        token_budget: Number(firstNonNull(source.token_budget, source.tokenBudget, source.context_limit, 512)) || 512,
        recursive_scanning: Boolean(firstNonNull(source.recursive_scanning, source.recursiveScanning, true)),
        extensions: typeof source.extensions === 'object' && source.extensions ? source.extensions : {},
        entries,
    };
}

function resolveCharacterBook(persona, settings) {
    const binding = persona.loreBinding;
    if (!binding) return null;

    if (binding.data) {
        return normalizeCharacterBook(binding.data, binding.name);
    }

    for (const store of gatherLoreStores(settings)) {
        const found = directLorebookLookup(store, binding);
        if (found) return normalizeCharacterBook(found, binding.name);
    }

    return null;
}

function normalizePersona(avatar, name, rawDescription, settings) {
    const meta = rawDescription && typeof rawDescription === 'object' ? rawDescription : {};
    const description = typeof rawDescription === 'string'
        ? rawDescription
        : String(meta.description || '');

    const persona = {
        avatar,
        name: String(name || 'Без имени'),
        description,
        title: String(meta.title || ''),
        position: meta.position ?? null,
        depth: meta.depth ?? null,
        role: meta.role ?? null,
        loreBinding: resolvePersonaLoreBinding(avatar, meta, settings),
    };

    persona.characterBook = resolveCharacterBook(persona, settings);
    persona.hasLore = Boolean(persona.characterBook);
    persona.loreName = persona.characterBook?.name || persona.loreBinding?.name || '';
    return persona;
}

async function loadPersonas() {
    const settings = powerUser();
    const names = settings?.personas && typeof settings.personas === 'object' ? settings.personas : {};
    const descriptions = settings?.persona_descriptions && typeof settings.persona_descriptions === 'object'
        ? settings.persona_descriptions
        : {};

    state.personas = Object.entries(names)
        .map(([avatar, name]) => normalizePersona(avatar, name, descriptions[avatar], settings))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    state.filtered = state.personas.slice();
    state.selected.clear();
    renderGrid();

    const loreCount = state.personas.filter(persona => persona.hasLore).length;
    setStatus(`Готово: ${state.personas.length} персон${loreCount ? ` · с lorebook: ${loreCount}` : ''}.`);
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


function personaCardId(persona) {
    const stem = String(persona?.avatar || 'persona').replace(/\.[^.]+$/, '');
    const cleaned = stem.replace(/[^a-zA-Z0-9_-]/g, '');
    if (cleaned) return cleaned.slice(-8).toUpperCase();

    let hash = 2166136261;
    const source = `${persona?.name || ''}|${persona?.avatar || ''}`;
    for (let i = 0; i < source.length; i++) {
        hash ^= source.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).slice(-6).toUpperCase();
}

function exportedCharacterName(persona) {
    return `${persona.name} · PV-${personaCardId(persona)}`;
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
            name: exportedCharacterName(persona),
            description: persona.description,
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: `Persona Vault backup for original persona: ${persona.name}. The temporary character name includes a PV ID to avoid SillyTavern duplicate-name avatar collisions. After Convert to Persona, rename it back to ${persona.name}. If a lorebook was embedded, SillyTavern can import it as Character Lore during character import.`,
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            character_book: persona.characterBook || undefined,
            tags: ['persona-backup', 'persona-vault'],
            creator: 'Persona Vault',
            character_version: VERSION,
            extensions: {
                persona_vault: {
                    backup: true,
                    original_persona_name: persona.name,
                    temporary_character_name: exportedCharacterName(persona),
                    persona_card_id: personaCardId(persona),
                    source_avatar: persona.avatar,
                    exporter_version: VERSION,
                    title: persona.title,
                    position: persona.position,
                    depth: persona.depth,
                    role: persona.role,
                    lorebook_name: persona.loreName || null,
                    has_embedded_lorebook: Boolean(persona.characterBook),
                    exported_at: new Date().toISOString(),
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
    const context2d = canvas.getContext('2d');
    context2d.drawImage(bitmap, 0, 0);
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

function buildPersonaTxt(persona) {
    const header = [
        `Name: ${persona.name}`,
        persona.title ? `Title: ${persona.title}` : '',
        persona.loreName ? `Persona Lorebook: ${persona.loreName}` : '',
        '',
        persona.description || '',
    ].filter(Boolean).join('\n');

    return new Blob([header], { type: 'text/plain;charset=utf-8' });
}

async function exportPng(persona) {
    try {
        setStatus(`Собираю PNG: ${persona.name}…`);
        const blob = await buildPersonaPng(persona);
        downloadBlob(blob, `${safeFileName(persona.name)}.persona.png`);
        setStatus(`PNG готов: ${persona.name}${persona.hasLore ? ' · lorebook встроен' : ''}.`);
    } catch (error) {
        showError(error);
    }
}

function exportTxt(persona) {
    try {
        const blob = buildPersonaTxt(persona);
        downloadBlob(blob, `${safeFileName(persona.name)}.persona.txt`);
        setStatus(`TXT готов: ${persona.name}.`);
    } catch (error) {
        showError(error);
    }
}

async function ensureZip() {
    if (window.JSZip) return true;
    if (state.zipPromise) return state.zipPromise;

    state.zipPromise = new Promise(resolve => {
        const script = document.createElement('script');
        script.src = '/lib/jszip.min.js';
        script.onload = () => resolve(Boolean(window.JSZip));
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });

    return state.zipPromise;
}

function uniqueZipFileName(persona, usedNames, ext) {
    const base = safeFileName(persona.name);
    const avatarStem = safeFileName(String(persona.avatar || 'avatar').replace(/\.[^.]+$/, ''));
    const suffix = avatarStem.slice(-18) || 'avatar';
    let candidate = `${base} [${suffix}].persona.${ext}`;
    let index = 2;

    while (usedNames.has(candidate.toLocaleLowerCase())) {
        candidate = `${base} [${suffix}-${index}].persona.${ext}`;
        index += 1;
    }

    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
}

async function exportSelectedZip(type, items) {
    if (!(await ensureZip())) throw new Error('JSZip не найден в SillyTavern');

    const zip = new JSZip();
    const usedNames = new Set();

    for (let i = 0; i < items.length; i++) {
        const persona = items[i];
        setStatus(`${type.toUpperCase()} ${i + 1}/${items.length}: ${persona.name}`);

        if (type === 'png') {
            const blob = await buildPersonaPng(persona);
            zip.file(uniqueZipFileName(persona, usedNames, 'png'), await blob.arrayBuffer());
        } else {
            const blob = buildPersonaTxt(persona);
            zip.file(uniqueZipFileName(persona, usedNames, 'txt'), await blob.arrayBuffer());
        }
    }

    const archive = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(archive, `persona-vault-${type}-${stamp}.zip`);
    setStatus(`Готово: ${items.length} ${type.toUpperCase()} в ZIP.`);
}

async function exportSelection(type) {
    const items = state.personas.filter(persona => state.selected.has(persona.avatar));
    if (!items.length) return setStatus('Сначала выбери хотя бы одну персону.');

    if (items.length === 1) {
        return type === 'png' ? exportPng(items[0]) : exportTxt(items[0]);
    }

    try {
        await exportSelectedZip(type, items);
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
    const count = state.selected.size;
    document.querySelector('#pv-selected-count')?.replaceChildren(document.createTextNode(String(count)));

    const png = document.querySelector('#pv-download-selected-png');
    const txt = document.querySelector('#pv-download-selected-txt');
    if (png && txt) {
        png.disabled = count === 0;
        txt.disabled = count === 0;
        png.textContent = count > 1 ? `PNG ZIP · ${count}` : count === 1 ? 'PNG · 1' : 'PNG';
        txt.textContent = count > 1 ? `TXT ZIP · ${count}` : count === 1 ? 'TXT · 1' : 'TXT';
    }

    document.querySelectorAll('.pv-card').forEach(card => {
        const isSelected = state.selected.has(card.dataset.avatar);
        card.classList.toggle('is-selected', isSelected);
        const input = card.querySelector('.pv-check');
        if (input) input.checked = isSelected;
    });
}

function makeButton(label, className, onClick, title = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (title) button.title = title;
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
        check.checked ? state.selected.add(persona.avatar) : state.selected.delete(persona.avatar);
        updateSelectionUi();
    });
    imageWrap.appendChild(check);

    if (persona.hasLore || persona.loreName) {
        const badge = document.createElement('span');
        badge.className = 'pv-badge';
        badge.textContent = 'LORE';
        badge.title = persona.loreName ? `Привязан lorebook: ${persona.loreName}` : 'У персоны найден lorebook';
        imageWrap.appendChild(badge);
    }

    const body = document.createElement('div');
    body.className = 'pv-card-body';

    const name = document.createElement('h3');
    name.className = 'pv-name';
    name.textContent = persona.name;

    const meta = document.createElement('div');
    meta.className = 'pv-meta';
    meta.textContent = persona.loreName
        ? `Lorebook: ${persona.loreName}`
        : (persona.title || 'Без привязанного lorebook');

    const preview = document.createElement('p');
    preview.className = 'pv-description';
    preview.textContent = persona.description || 'Описание пустое';

    const actions = document.createElement('div');
    actions.className = 'pv-card-actions';
    actions.append(
        makeButton('PNG', 'pv-btn pv-btn-primary', () => exportPng(persona), 'Скачать PNG-карточку'),
        makeButton('TXT', 'pv-btn', () => exportTxt(persona), 'Скачать TXT-описание'),
    );

    body.append(name, meta, preview, actions);
    card.append(imageWrap, body);

    card.addEventListener('click', () => {
        state.selected.has(persona.avatar) ? state.selected.delete(persona.avatar) : state.selected.add(persona.avatar);
        updateSelectionUi();
    });

    return card;
}

function renderGrid() {
    const grid = document.querySelector('#pv-grid');
    if (!grid) return;
    grid.replaceChildren();

    if (!state.filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'pv-empty';
        empty.textContent = state.personas.length ? 'Ничего не найдено.' : 'Персоны не найдены.';
        grid.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    state.filtered.forEach(persona => fragment.appendChild(buildCard(persona)));
    grid.appendChild(fragment);
    updateSelectionUi();
}

function filterBy(query) {
    const value = lower(query);
    state.filtered = value
        ? state.personas.filter(persona => `${persona.name}\n${persona.description}\n${persona.loreName}`.toLocaleLowerCase('ru').includes(value))
        : state.personas.slice();
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
                    <p>PNG-карточки, TXT и массовый ZIP для ваших персон.</p>
                </div>
                <button type="button" class="pv-close" data-pv-close aria-label="Закрыть">×</button>
            </header>

            <div class="pv-toolbar">
                <input id="pv-search" class="pv-search" type="search" placeholder="Поиск по персонам…" autocomplete="off">
                <button type="button" id="pv-select-all" class="pv-btn">Выбрать все</button>
                <button type="button" id="pv-clear" class="pv-btn">Снять</button>
                <button type="button" id="pv-download-selected-png" class="pv-btn pv-btn-primary" disabled>PNG</button>
                <button type="button" id="pv-download-selected-txt" class="pv-btn" disabled>TXT</button>
                <span id="pv-selected-count" class="pv-count" hidden>0</span>
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
    modal.querySelector('#pv-download-selected-png').addEventListener('click', () => exportSelection('png'));
    modal.querySelector('#pv-download-selected-txt').addEventListener('click', () => exportSelection('txt'));
    modal.querySelector('#pv-select-all').addEventListener('click', () => {
        state.filtered.forEach(persona => state.selected.add(persona.avatar));
        updateSelectionUi();
    });
    modal.querySelector('#pv-clear').addEventListener('click', () => {
        state.selected.clear();
        updateSelectionUi();
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeVault();
    });
}

function mountSettingsEntry() {
    if (document.querySelector('#pv-settings')) return true;
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
                <p class="pv-settings-copy">Резервные PNG/TXT для персон. При наличии привязанного Persona Lore расширка пытается встроить lorebook в PNG.</p>
                <button type="button" id="pv-open" class="menu_button">Открыть хранилище персон</button>
            </div>
        </div>
    `;

    host.appendChild(root);
    root.querySelector('#pv-open').addEventListener('click', openVault);
    return true;
}

function mount() {
    if (state.mounted) return;
    mountModal();

    if (mountSettingsEntry()) {
        state.mounted = true;
        console.log(`[${MODULE}] v${VERSION} loaded`);
        return;
    }

    const observer = new MutationObserver(() => {
        if (mountSettingsEntry()) {
            observer.disconnect();
            state.mounted = true;
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

boot();
