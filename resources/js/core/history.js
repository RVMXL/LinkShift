/**
 * LinkShift — core/history.js
 *
 * Журнал созданных ссылок: %APPDATA%\LinkShift\links_history.json.
 * Каждая запись позволяет выполнить «Вернуть как было» (revertLink)
 * и содержит всё необходимое для аудита и отката.
 *
 * Формат записи:
 * {
 *   id, status: 'active'|'reverted'|'error',
 *   originalPath, targetPath, bakPath|null, linkType: 'junction'|'symlink',
 *   drive, sizeBytes, files, createdAt, updatedAt, revertedAt|null, notes: []
 * }
 */

import { AppError } from './i18n.js';

const APP_DIR = 'LinkShift';
const FILE_NAME = 'links_history.json';

let cachedDb = null;

async function getDataDir() {
    const base = await Neutralino.os.getPath('data');
    return String(base).replace(/[\\/]+$/, '') + '\\' + APP_DIR;
}

async function getFilePath() {
    return (await getDataDir()) + '\\' + FILE_NAME;
}

async function ensureDir() {
    // createDirectory в Neutralinojs создает каталоги рекурсивно.
    await Neutralino.filesystem.createDirectory(await getDataDir());
}

async function load() {
    if (cachedDb) return cachedDb;
    try {
        const raw = await Neutralino.filesystem.readFile(await getFilePath());
        const parsed = JSON.parse(raw);
        cachedDb = {
            version: 1,
            entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        };
    } catch {
        cachedDb = { version: 1, entries: [] };
    }
    return cachedDb;
}

async function save() {
    await ensureDir();
    await Neutralino.filesystem.writeFile(
        await getFilePath(),
        JSON.stringify(cachedDb, null, 2),
    );
}

/** Все записи журнала. */
export async function list() {
    return [...(await load()).entries];
}

/** Создает запись с id/датами и добавляет в начало журнала. */
export async function add(fields) {
    const db = await load();
    const now = new Date().toISOString();
    const entry = {
        id: crypto.randomUUID(),
        status: 'active',
        notes: [],
        createdAt: now,
        updatedAt: now,
        revertedAt: null,
        ...fields,
    };
    db.entries.unshift(entry);
    await save();
    return entry;
}

/** Частичное обновление записи по id. */
export async function update(id, patch) {
    const db = await load();
    const entry = db.entries.find((e) => e.id === id);
    if (!entry) throw new AppError('ERR_INTERNAL', { details: `history entry ${id} not found` });
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    await save();
    return entry;
}

/** Удалить запись из журнала (сама ссылка не трогается). */
export async function remove(id) {
    const db = await load();
    const before = db.entries.length;
    db.entries = db.entries.filter((e) => e.id !== id);
    await save();
    return before !== db.entries.length;
}

export async function findById(id) {
    return (await load()).entries.find((e) => e.id === id) || null;
}

export async function findByOriginalPath(path) {
    const p = String(path).toLowerCase();
    return (await load()).entries.find(
        (e) => String(e.originalPath).toLowerCase() === p,
    ) || null;
}
