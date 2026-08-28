const MODULE = 'persona_vault';
const VERSION = '0.3.0';

const state = {
    mode: 'persona',
    personas: [],
    characters: [],
    filtered: [],
    selected: new Set(),
    mounted: false,
    zipPromise: null,
    loadSeq: 0,
};

function ctx() {
    return SillyTavern.getContext();
}

function powerUser() {
    return ctx().powerUserSettings || {};
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

async function postBlob(url, body = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.blob();
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
    return Boolean(value && typeof value === 'object' && value.entries && typeof value.entries === 'object');
}

function convertWorldInfoToCharacterBook(name, world) {
    if (!looksLikeLorebook(world)) return null;

    if (world.originalData && typeof world.originalData === 'object') {
        return world.originalData;
    }

    const result = { entries: [], name: String(name || 'Persona Lore') };

    for (const [index, entry] of Object.entries(world.entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const content = String(entry.content ?? '');
        if (!content.trim()) continue;

        result.entries.push({
            id: entry.uid ?? Number(index),
            keys: splitKeys(entry.key),
            secondary_keys: splitKeys(entry.keysecondary),
            comment: entry.comment ?? '',
            content,
            constant: Boolean(entry.constant),
            selective: Boolean(entry.selective),
            insertion_order: Number(entry.order ?? 0),
            enabled: !Boolean(entry.disable),
            position: Number(entry.position) === 0 ? 'before_char' : 'after_char',
            use_regex: true,
            extensions: {
                ...(entry.extensions && typeof entry.extensions === 'object' ? entry.extensions : {}),
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        });
    }

    return result.entries.length ? result : null;
}

const loreCache = new Map();

async function fetchCharacterBook(binding) {
    if (!binding) return null;
    if (binding.data) return convertWorldInfoToCharacterBook(binding.name, binding.data);
    if (!binding.name) return null;

    const key = String(binding.name);
    if (!loreCache.has(key)) {
        loreCache.set(key, postJson('/api/worldinfo/get', { name: key })
            .then(world => convertWorldInfoToCharacterBook(key, world))
            .catch(error => {
                console.warn(`[${MODULE}] failed to load lorebook "${key}"`, error);
                return null;
            }));
    }

    return loreCache.get(key);
}

async function hydratePersonaLore(persona) {
    if (!persona?.loreBinding) return persona;
    persona.characterBook = await fetchCharacterBook(persona.loreBinding);
    persona.hasLore = Boolean(persona.characterBook);
    persona.loreName = persona.characterBook?.name || persona.loreBinding?.name || '';
    return persona;
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

    persona.characterBook = null;
    persona.hasLore = false;
    persona.loreName = persona.loreBinding?.name || '';
    return persona;
}

async function avatarExists(persona) {
    const url = avatarUrl(persona.avatar);
    try {
        const response = await fetch(url, {
            method: 'HEAD',
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (response.ok) return true;
        if (response.status !== 405) return false;
    } catch {
        // Some ST builds/proxies may not like HEAD; fall back to a normal GET.
    }

    try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        return response.ok;
    } catch {
        return false;
    }
}

async function loadPersonas(loadSeq) {
    const settings = powerUser();
    const names = settings?.personas && typeof settings.personas === 'object' ? settings.personas : {};
    const descriptions = settings?.persona_descriptions && typeof settings.persona_descriptions === 'object'
        ? settings.persona_descriptions
        : {};

    const personas = Object.entries(names)
        .map(([avatar, name]) => normalizePersona(avatar, name, descriptions[avatar], settings))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    await Promise.all(personas.map(async persona => {
        await hydratePersonaLore(persona);
        persona.avatarMissing = !(await avatarExists(persona));
    }));

    if (loadSeq !== state.loadSeq || state.mode !== 'persona') return;

    state.personas = personas;
    state.filtered = personas.slice();
    state.selected.clear();
    renderGrid();

    const loreCount = personas.filter(persona => persona.hasLore).length;
    const brokenCount = personas.filter(persona => persona.avatarMissing).length;
    const parts = [`Готово: ${personas.length} персон`];
    if (loreCount) parts.push(`с lorebook: ${loreCount}`);
    if (brokenCount) parts.push(`повреждённых: ${brokenCount}`);
    setStatus(`${parts.join(' · ')}.`);
}

function characterAvatarUrl(character) {
    const avatar = String(character?.avatar || '').trim();
    const raw = character?.avatar_url;
    if (raw && /^(?:https?:|data:|blob:|\/)/i.test(String(raw))) return String(raw);

    const thumbnail = ctx().getThumbnailUrl || window.getThumbnailUrl;
    if (avatar && typeof thumbnail === 'function') {
        try { return thumbnail('avatar', avatar); } catch { /* fall through */ }
    }

    return avatar ? `/characters/${encodeURIComponent(avatar).replaceAll('%2F', '/')}` : '';
}

function normalizeCharacter(character, index) {
    const data = character?.data && typeof character.data === 'object' ? character.data : {};
    return {
        key: String(character?.avatar || `character-${index}`),
        avatar: String(character?.avatar || ''),
        image: characterAvatarUrl(character),
        name: String(character?.name || data.name || 'Без имени'),
        description: String(character?.description || data.description || ''),
        creator: String(data.creator || character?.creator || ''),
        version: String(data.character_version || character?.character_version || ''),
        tags: Array.isArray(character?.tags) ? character.tags : (Array.isArray(data.tags) ? data.tags : []),
        raw: character,
    };
}

async function loadCharacters(loadSeq) {
    const source = Array.isArray(ctx().characters) ? ctx().characters : [];
    const characters = source
        .filter(character => character && character.avatar)
        .map(normalizeCharacter)
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    if (loadSeq !== state.loadSeq || state.mode !== 'character') return;

    state.characters = characters;
    state.filtered = characters.slice();
    state.selected.clear();
    renderGrid();
    setStatus(`Готово: ${characters.length} чаров.`);
}

async function loadCurrentMode() {
    const loadSeq = ++state.loadSeq;
    return state.mode === 'character' ? loadCharacters(loadSeq) : loadPersonas(loadSeq);
}

function currentItems() {
    return state.mode === 'character' ? state.characters : state.personas;
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
    if (persona.loreBinding && !persona.characterBook) await hydratePersonaLore(persona);
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

async function buildCharacterExport(character, format) {
    return postBlob('/api/characters/export', {
        avatar_url: character.avatar,
        format,
    });
}

async function exportCharacterFile(character, format) {
    try {
        const label = format.toUpperCase();
        setStatus(`Собираю ${label}: ${character.name}…`);
        const blob = await buildCharacterExport(character, format);
        downloadBlob(blob, `${safeFileName(character.name)}.character.${format}`);
        setStatus(`${label} готов: ${character.name}.`);
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

async function exportPersonaSelectedZip(type, items) {
    if (!(await ensureZip())) throw new Error('JSZip не найден в SillyTavern');

    const zip = new JSZip();
    const usedNames = new Set();
    let added = 0;
    let skipped = 0;

    for (let i = 0; i < items.length; i++) {
        const persona = items[i];
        setStatus(`${type.toUpperCase()} ${i + 1}/${items.length}: ${persona.name}`);

        try {
            if (type === 'png') {
                if (persona.avatarMissing) throw new Error('аватар не найден');
                const blob = await buildPersonaPng(persona);
                zip.file(uniqueZipFileName(persona, usedNames, 'png'), await blob.arrayBuffer());
            } else {
                const blob = buildPersonaTxt(persona);
                zip.file(uniqueZipFileName(persona, usedNames, 'txt'), await blob.arrayBuffer());
            }
            added += 1;
        } catch (error) {
            skipped += 1;
            state.selected.delete(persona.avatar);
            console.warn(`[${MODULE}] skipped ${persona.name}:`, error);
        }
    }

    if (!added) throw new Error('Не удалось подготовить ни одного файла');

    const archive = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(archive, `persona-vault-${type}-${stamp}.zip`);
    updateSelectionUi();
    setStatus(`Готово: ${added} ${type.toUpperCase()} в ZIP${skipped ? ` · пропущено: ${skipped}` : ''}.`);
}

async function exportCharacterSelectedZip(format, items) {
    if (!(await ensureZip())) throw new Error('JSZip не найден в SillyTavern');

    const zip = new JSZip();
    const usedNames = new Set();
    let added = 0;
    let skipped = 0;

    for (let i = 0; i < items.length; i++) {
        const character = items[i];
        const label = format.toUpperCase();
        setStatus(`${label} ${i + 1}/${items.length}: ${character.name}`);

        try {
            const blob = await buildCharacterExport(character, format);
            const base = safeFileName(character.name);
            let filename = `${base}.character.${format}`;
            let n = 2;
            while (usedNames.has(filename.toLocaleLowerCase())) {
                filename = `${base} (${n++}).character.${format}`;
            }
            usedNames.add(filename.toLocaleLowerCase());
            zip.file(filename, await blob.arrayBuffer());
            added += 1;
        } catch (error) {
            skipped += 1;
            state.selected.delete(character.key);
            console.warn(`[${MODULE}] skipped character ${character.name}:`, error);
        }
    }

    if (!added) throw new Error('Не удалось подготовить ни одного файла');

    const archive = await zip.generateAsync({ type: 'blob' });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(archive, `character-vault-${format}-${stamp}.zip`);
    updateSelectionUi();
    setStatus(`Готово: ${added} ${format.toUpperCase()} в ZIP${skipped ? ` · пропущено: ${skipped}` : ''}.`);
}

async function exportSelection(type) {
    if (state.mode === 'character') {
        const items = state.characters.filter(character => state.selected.has(character.key));
        if (!items.length) return setStatus('Сначала выбери хотя бы одного чара.');

        if (items.length === 1) return exportCharacterFile(items[0], type);

        try {
            await exportCharacterSelectedZip(type, items);
        } catch (error) {
            showError(error);
        }
        return;
    }

    const items = state.personas.filter(persona => state.selected.has(persona.avatar));
    if (!items.length) return setStatus('Сначала выбери хотя бы одну персону.');

    if (items.length === 1) {
        return type === 'png' ? exportPng(items[0]) : exportTxt(items[0]);
    }

    try {
        await exportPersonaSelectedZip(type, items);
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

    const primary = document.querySelector('#pv-download-primary');
    const secondary = document.querySelector('#pv-download-secondary');
    const secondType = state.mode === 'character' ? 'JSON' : 'TXT';

    if (primary && secondary) {
        primary.disabled = count === 0;
        secondary.disabled = count === 0;
        primary.textContent = count > 1 ? `PNG ZIP · ${count}` : count === 1 ? 'PNG · 1' : 'PNG';
        secondary.textContent = count > 1 ? `${secondType} ZIP · ${count}` : count === 1 ? `${secondType} · 1` : secondType;
    }

    document.querySelectorAll('.pv-card').forEach(card => {
        const isSelected = state.selected.has(card.dataset.key);
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

function buildPersonaCard(persona) {
    const card = document.createElement('article');
    card.className = 'pv-card';
    card.dataset.key = persona.avatar;
    if (persona.avatarMissing) card.classList.add('is-broken');

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
    check.disabled = Boolean(persona.avatarMissing);
    check.setAttribute('aria-label', `Выбрать ${persona.name}`);
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => {
        if (persona.avatarMissing) return;
        check.checked ? state.selected.add(persona.avatar) : state.selected.delete(persona.avatar);
        updateSelectionUi();
    });
    imageWrap.appendChild(check);

    if (persona.avatarMissing) {
        const badge = document.createElement('span');
        badge.className = 'pv-badge';
        badge.textContent = 'НЕТ АВЫ';
        badge.title = 'Сиротская запись персоны: файл аватара больше не существует';
        imageWrap.appendChild(badge);
    } else if (persona.hasLore) {
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
    meta.textContent = persona.avatarMissing
        ? 'Повреждённая запись · аватар не найден'
        : persona.hasLore
            ? `Lorebook: ${persona.loreName}`
            : (persona.loreName ? `Lorebook link: ${persona.loreName}` : (persona.title || 'Без привязанного lorebook'));

    const preview = document.createElement('p');
    preview.className = 'pv-description';
    preview.textContent = persona.description || 'Описание пустое';

    const actions = document.createElement('div');
    actions.className = 'pv-card-actions';
    const pngButton = makeButton('PNG', 'pv-btn pv-btn-primary', () => exportPng(persona), 'Скачать PNG-карточку');
    pngButton.disabled = Boolean(persona.avatarMissing);
    actions.append(
        pngButton,
        makeButton('TXT', 'pv-btn', () => exportTxt(persona), 'Скачать TXT-описание'),
    );

    body.append(name, meta, preview, actions);
    card.append(imageWrap, body);

    card.addEventListener('click', () => {
        if (persona.avatarMissing) return;
        state.selected.has(persona.avatar) ? state.selected.delete(persona.avatar) : state.selected.add(persona.avatar);
        updateSelectionUi();
    });

    return card;
}


function buildCharacterCard(character) {
    const card = document.createElement('article');
    card.className = 'pv-card';
    card.dataset.key = character.key;

    const imageWrap = document.createElement('div');
    imageWrap.className = 'pv-image-wrap';

    const image = document.createElement('img');
    image.className = 'pv-image';
    image.src = character.image;
    image.alt = character.name;
    image.loading = 'lazy';
    imageWrap.appendChild(image);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pv-check';
    check.setAttribute('aria-label', `Выбрать ${character.name}`);
    check.addEventListener('click', event => event.stopPropagation());
    check.addEventListener('change', () => {
        check.checked ? state.selected.add(character.key) : state.selected.delete(character.key);
        updateSelectionUi();
    });
    imageWrap.appendChild(check);

    const badge = document.createElement('span');
    badge.className = 'pv-badge pv-badge-char';
    badge.textContent = 'CHAR';
    badge.title = 'Нативная Character Card SillyTavern';
    imageWrap.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'pv-card-body';

    const name = document.createElement('h3');
    name.className = 'pv-name';
    name.textContent = character.name;

    const meta = document.createElement('div');
    meta.className = 'pv-meta';
    const bits = [];
    if (character.creator) bits.push(character.creator);
    if (character.version) bits.push(`v${character.version}`);
    meta.textContent = bits.length ? bits.join(' · ') : 'Character Card · нативный экспорт ST';

    const preview = document.createElement('p');
    preview.className = 'pv-description';
    preview.textContent = character.description || 'Описание пустое';

    const actions = document.createElement('div');
    actions.className = 'pv-card-actions';
    actions.append(
        makeButton('PNG', 'pv-btn pv-btn-primary', () => exportCharacterFile(character, 'png'), 'Скачать PNG-карточку'),
        makeButton('JSON', 'pv-btn', () => exportCharacterFile(character, 'json'), 'Скачать JSON-карточку'),
    );

    body.append(name, meta, preview, actions);
    card.append(imageWrap, body);

    card.addEventListener('click', () => {
        state.selected.has(character.key) ? state.selected.delete(character.key) : state.selected.add(character.key);
        updateSelectionUi();
    });

    return card;
}

function modeConfig() {
    return state.mode === 'character'
        ? {
            title: 'Character Vault',
            subtitle: 'PNG/JSON-карточки и массовый ZIP для ваших чаров.',
            search: 'Поиск по чарам…',
            secondType: 'json',
            empty: 'Чары не найдены.',
        }
        : {
            title: 'Persona Vault',
            subtitle: 'PNG-карточки, TXT и массовый ZIP для ваших персон.',
            search: 'Поиск по персонам…',
            secondType: 'txt',
            empty: 'Персоны не найдены.',
        };
}

function syncModeUi() {
    const config = modeConfig();
    const title = document.querySelector('#pv-active-title');
    const subtitle = document.querySelector('#pv-active-subtitle');
    const search = document.querySelector('#pv-search');

    if (title) title.textContent = config.title;
    if (subtitle) subtitle.textContent = config.subtitle;
    if (search) {
        search.value = '';
        search.placeholder = config.search;
    }

    document.querySelectorAll('[data-pv-mode]').forEach(button => {
        const active = button.dataset.pvMode === state.mode;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });

    updateSelectionUi();
}

async function setMode(mode) {
    if (!['persona', 'character'].includes(mode)) return;
    state.mode = mode;
    state.selected.clear();
    state.filtered = [];
    syncModeUi();

    const grid = document.querySelector('#pv-grid');
    if (grid) grid.replaceChildren();
    setStatus(mode === 'character' ? 'Загружаю чаров…' : 'Загружаю персоны…');
    await loadCurrentMode();
}

function renderGrid() {
    const grid = document.querySelector('#pv-grid');
    if (!grid) return;
    grid.replaceChildren();

    if (!state.filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'pv-empty';
        empty.textContent = currentItems().length ? 'Ничего не найдено.' : modeConfig().empty;
        grid.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    const builder = state.mode === 'character' ? buildCharacterCard : buildPersonaCard;
    state.filtered.forEach(item => fragment.appendChild(builder(item)));
    grid.appendChild(fragment);
    updateSelectionUi();
}

function filterBy(query) {
    const value = lower(query);
    const source = currentItems();

    if (!value) {
        state.filtered = source.slice();
    } else if (state.mode === 'character') {
        state.filtered = source.filter(character =>
            `${character.name}\n${character.description}\n${character.creator}\n${character.tags.join(' ')}`
                .toLocaleLowerCase('ru')
                .includes(value));
    } else {
        state.filtered = source.filter(persona =>
            `${persona.name}\n${persona.description}\n${persona.loreName}`
                .toLocaleLowerCase('ru')
                .includes(value));
    }

    renderGrid();
}

function openVault() {
    document.querySelector('#pv-modal')?.classList.add('is-open');
    document.body.classList.add('pv-lock-scroll');
    syncModeUi();
    loadCurrentMode().catch(showError);
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
        <section class="pv-window" role="dialog" aria-modal="true" aria-label="Persona and Character Vault">
            <header class="pv-window-head">
                <div class="pv-head-copy">
                    <div class="pv-kicker">✦ ARCANE ARCHIVE ✦</div>
                    <div class="pv-vault-tabs" role="tablist" aria-label="Vault mode">
                        <button type="button" class="pv-vault-tab is-active" data-pv-mode="persona" aria-pressed="true">Persona Vault</button>
                        <span class="pv-vault-divider">◇</span>
                        <button type="button" class="pv-vault-tab" data-pv-mode="character" aria-pressed="false">Character Vault</button>
                        <small class="pv-version">v${VERSION}</small>
                    </div>
                    <h2 id="pv-active-title" class="pv-sr-title">Persona Vault</h2>
                    <p id="pv-active-subtitle">PNG-карточки, TXT и массовый ZIP для ваших персон.</p>
                </div>
                <button type="button" class="pv-close" data-pv-close aria-label="Закрыть">×</button>
            </header>

            <div class="pv-toolbar">
                <input id="pv-search" class="pv-search" type="search" placeholder="Поиск по персонам…" autocomplete="off">
                <button type="button" id="pv-select-all" class="pv-btn">Выбрать все</button>
                <button type="button" id="pv-clear" class="pv-btn">Снять</button>
                <button type="button" id="pv-download-primary" class="pv-btn pv-btn-primary" disabled>PNG</button>
                <button type="button" id="pv-download-secondary" class="pv-btn" disabled>TXT</button>
                <span id="pv-selected-count" class="pv-count" hidden>0</span>
                <button type="button" id="pv-refresh" class="pv-btn pv-icon-btn" title="Обновить">↻</button>
            </div>

            <div id="pv-status" class="pv-status">Готово к загрузке.</div>
            <div id="pv-grid" class="pv-grid"></div>
        </section>
    `;

    document.body.appendChild(modal);

    modal.querySelectorAll('[data-pv-close]').forEach(node => node.addEventListener('click', closeVault));
    modal.querySelectorAll('[data-pv-mode]').forEach(button => {
        button.addEventListener('click', () => {
            if (button.dataset.pvMode === state.mode) return;
            setMode(button.dataset.pvMode).catch(showError);
        });
    });
    modal.querySelector('#pv-search').addEventListener('input', event => filterBy(event.target.value));
    modal.querySelector('#pv-refresh').addEventListener('click', () => loadCurrentMode().catch(showError));
    modal.querySelector('#pv-download-primary').addEventListener('click', () => exportSelection('png'));
    modal.querySelector('#pv-download-secondary').addEventListener('click', () => exportSelection(modeConfig().secondType));
    modal.querySelector('#pv-select-all').addEventListener('click', () => {
        if (state.mode === 'character') {
            state.filtered.forEach(character => state.selected.add(character.key));
        } else {
            state.filtered
                .filter(persona => !persona.avatarMissing)
                .forEach(persona => state.selected.add(persona.avatar));
        }
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
                <p class="pv-settings-copy">Persona Vault: PNG/TXT с Persona Lore. Character Vault: нативный PNG/JSON экспорт SillyTavern с Character Lore.</p>
                <button type="button" id="pv-open" class="menu_button">Открыть Vault</button>
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
