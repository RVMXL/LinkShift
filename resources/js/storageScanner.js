/**
 * LinkShift — storageScanner.js
 *
 * Умный сканер «Пожиратели места»: поиск тяжелых папок и кэшей на диске C
 * через PowerShell (resources/ps/scan-storage.ps1).
 *
 * Цели сканирования:
 *  - кэши браузеров (Chrome, Edge, Yandex — все профили);
 *  - %APPDATA%\Telegram Desktop, %APPDATA%\discord;
 *  - кэши шейдеров: NVIDIA (DXCache/GLCache/NV_Cache), AMD (DxCache/DxcCache),
 *    D3DSCache, Steam shadercache (все библиотеки из libraryfolders.vdf);
 *  - все первые уровни %LOCALAPPDATA% и %APPDATA% тяжелее minSizeMB (500 МБ).
 *
 * Папки, которые УЖЕ являются ссылками (ReparsePoint), пропускаются —
 * их нельзя предложить к повторному переносу.
 *
 * Результат: массив объектов
 *   { name, path, sizeMB, files, category, isSafeToMove, reasons[] }
 */

import { runScript } from './core/ps.js';
import { AppError } from './core/i18n.js';

/** Активная задача сканирования (для отмены). */
let activeScanJob = null;

/**
 * Полное сканирование известных «пожирателей места».
 *
 * @param {object} [options]
 * @param {number} [options.minSizeMB=500]      Порог для общего скана %LOCALAPPDATA%/%APPDATA%.
 * @param {boolean} [options.checkProcesses=true] Проверять запущенные процессы (isSafeToMove).
 * @param {number} [options.timeoutMs]           Лимит сканирования (30 минут).
 * @param {(progress:object) => void} [options.onProgress]  { phase, path, category }
 * @returns {Promise<Array<{name,path,sizeMB,files,category,isSafeToMove,reasons}>>}
 *          отсортированный по размеру список (сначала крупные).
 */
export async function scanStorage(options = {}) {
    const {
        minSizeMB = 500,
        checkProcesses = true,
        timeoutMs = 30 * 60 * 1000,
        onProgress = null,
    } = options;

    const job = runScript('scan-storage', [JSON.stringify({ minSizeMB, checkProcesses })], {
        timeoutMs,
        onProgress: (p) => {
            if (onProgress) {
                try { onProgress(p); } catch { /* UI не должен ронять сканер */ }
            }
        },
    });
    activeScanJob = job;

    try {
        const res = await job;
        if (!res || res.ok !== true) {
            throw new AppError('ERR_SCAN_FAILED', { details: (res && res.message) || 'no result' });
        }

        const items = Array.isArray(res.items) ? res.items : [];
        const normalized = items.map((it) => ({
            name: String(it.name ?? ''),
            path: String(it.path ?? ''),
            sizeMB: Number(it.sizeMB) || 0,
            files: Number(it.files) || 0,
            category: String(it.category ?? 'other'),
            isSafeToMove: Boolean(it.isSafeToMove),
            reasons: Array.isArray(it.reasons) ? it.reasons : [],
        }));

        normalized.sort((a, b) => b.sizeMB - a.sizeMB);
        return normalized;
    } finally {
        activeScanJob = null;
    }
}

/** Досрочная остановка сканирования (из UI или по таймауту). */
export function cancelScan() {
    if (activeScanJob && typeof activeScanJob.cancel === 'function') {
        activeScanJob.cancel();
    }
}
