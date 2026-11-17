/**
 * LinkShift — core/ps.js
 *
 * Реестр PowerShell-скриптов из resources/ps/. Каждый скрипт:
 *  - принимает аргументы ТОЛЬКО как Base64 (их декодирует _lib.ps1),
 *  - печатает прогресс строками "##P##{json}" (разбирается потоково),
 *  - завершается одной строкой JSON-результата.
 *
 * Скрипт копируется во временный файл перед запуском, потому что в собранном
 * релизе ресурсы лежат внутри resources.neu и недоступны PowerShell с диска.
 */

import { spawnStreaming, toB64, quoteArg } from './exec.js';
import { AppError } from './i18n.js';

const scriptCache = new Map();
let tempCounter = 0;
let tempDirCache = null;

/** Рабочий каталог для временных .ps1. */
async function getTempDir() {
    if (tempDirCache) return tempDirCache;
    // Приоритет — %PUBLIC% (обычно C:\Users\Public): путь гарантированно ASCII.
    // CreateProcess в Neutralino передаёт командную строку как ANSI без
    // конверсии, и UTF-8 путь с кириллицей (типичный %TEMP% русскоязычного
    // профиля) превращается в mojibake: PowerShell получает несуществующий
    // путь -File и мгновенно умирает. ASCII-каталог снимает проблему целиком.
    const candidates = [];
    try { candidates.push(await Neutralino.os.getEnv('PUBLIC')); } catch { }
    try { candidates.push(await Neutralino.os.getPath('temp')); } catch { }
    try { candidates.push(await Neutralino.os.getEnv('TEMP')); } catch { }
    for (const raw of candidates) {
        const dir = String(raw || '').trim().replace(/[\\/]+$/, '');
        if (!dir) continue;
        const sep = dir.includes('\\') ? '\\' : '/';
        const work = `${dir}${sep}LinkShift_tmp`;
        try {
            await Neutralino.filesystem.createDirectory(work);
            tempDirCache = work;
            return work;
        } catch (e) {
            // Каталог мог существовать: проверяем фактическое наличие.
            try {
                const st = await Neutralino.filesystem.getStats(work);
                if (st && st.isDirectory) {
                    tempDirCache = work;
                    return work;
                }
            } catch { /* действительно недоступен */ }
            console.warn('[LinkShift] temp dir candidate failed:', work, e);
        }
    }
    throw new AppError('ERR_INTERNAL', { details: 'no writable temp directory found' });
}

/** Текст скрипта из documentRoot (кэшируется на сессию). */
async function getScriptText(name) {
    if (!scriptCache.has(name)) {
        const res = await fetch(`/ps/${name}.ps1`);
        if (!res.ok) {
            throw new AppError('ERR_INTERNAL', { details: `script /ps/${name}.ps1 not found (HTTP ${res.status})` });
        }
        scriptCache.set(name, await res.text());
    }
    return scriptCache.get(name);
}

/**
 * Запускает скрипт из resources/ps/<name>.ps1 с Base64-аргументами.
 *
 * @param {string} name       Имя скрипта без расширения.
 * @param {string[]} args     Значения (строки/JSON); уходят как Base64.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]        0 — без таймаута.
 * @param {(progress: object) => void} [opts.onProgress]  Поток ##P##-событий.
 * @returns {Promise<object>}  Разобранный JSON-результат скрипта.
 */
export function runScript(name, args = [], opts = {}) {
    const { timeoutMs = 120000, onProgress = null } = opts;
    let job = null;

    const promise = (async () => {
        const scriptText = await getScriptText(name);
    const tempDir = await getTempDir();
    const sep = tempDir.includes('\\') ? '\\' : '/';
    const tempFile = `${tempDir}${sep}LinkShift_${name}_${Date.now()}_${tempCounter++}.ps1`;
    try {
        await Neutralino.filesystem.writeFile(tempFile, scriptText);
    } catch (e) {
        // Нативный сбой записи: сохраняем raw-ошибку сервера для диагностики.
        const raw = JSON.stringify(e && typeof e === 'object' ? { code: e.code, message: e.message } : String(e));
        throw new AppError('ERR_INTERNAL', { details: `writeFile(${tempFile}) failed: ${raw}` });
    }

    try {
        const b64args = args.map((a) => toB64(String(a)));
        const command = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '
            + quoteArg(tempFile)
            + (b64args.length ? ' ' + b64args.join(' ') : '');

        const outLines = [];
        job = spawnStreaming(command, {
            timeoutMs,
            onStdOutLine: (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                if (trimmed.startsWith('##P##')) {
                    if (onProgress) {
                        try { onProgress(JSON.parse(trimmed.slice(5))); } catch { /* битый прогресс не критичен */ }
                    }
                } else {
                    outLines.push(trimmed);
                }
            },
        });

        let res;
        try {
            res = await job;
        } catch (e) {
            // AppError (отмена/таймаут) — пробрасываем как есть; сырые нативные
            // ошибки оборачиваем, сохраняя raw-объект сервера в details.
            if (e instanceof AppError) throw e;
            const raw = JSON.stringify(e && typeof e === 'object' ? { code: e.code, message: e.message } : String(e));
            throw new AppError('ERR_INTERNAL', { details: `script job failed: ${raw}` });
        }

        if (res.cancelled) throw new AppError('ERR_CANCELLED');
        if (res.timedOut) {
            throw new AppError('ERR_TIMEOUT', { seconds: Math.round((timeoutMs || 0) / 1000) });
        }

        // Результат — последняя строка, похожая на JSON-объект.
        for (let i = outLines.length - 1; i >= 0; i--) {
            if (outLines[i].startsWith('{')) {
                try { return JSON.parse(outLines[i]); } catch { /* попробуем строку выше */ }
            }
        }

        throw new AppError('ERR_INTERNAL', {
            details: `script "${name}" produced no JSON (exit ${res.exitCode}). `
                + res.stdErr.slice(-400),
        });
    } finally {
        try { await Neutralino.filesystem.remove(tempFile); } catch { /* не критично */ }
    }
    })();

    // Кнопки «Остановить» зовут .cancel() — пробрасываем во внутренний
    // spawnStreaming. Раньше runScript был async-функцией: у её промиса не
    // было .cancel, и cancelScan() молча ничего не делал — скан продолжался
    // до самозавершения PowerShell.
    promise.cancel = () => {
        if (job && typeof job.cancel === 'function') job.cancel();
    };
    return promise;
}
