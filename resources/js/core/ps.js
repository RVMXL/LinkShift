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

/** Каталог для временных .ps1: os.getPath('temp') с фолбэком на %TEMP%. */
async function getTempDir() {
    try {
        const dir = await Neutralino.os.getPath('temp');
        if (dir) return String(dir).replace(/[\\/]+$/, '');
    } catch { /* ниже ручной фолбэк */ }
    const env = await Neutralino.os.getEnv('TEMP');
    if (env) return String(env).replace(/[\\/]+$/, '');
    throw new AppError('ERR_INTERNAL', { details: 'TEMP directory not found' });
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
export async function runScript(name, args = [], opts = {}) {
    const { timeoutMs = 120000, onProgress = null } = opts;

    const scriptText = await getScriptText(name);
    const tempDir = await getTempDir();
    const tempFile = `${tempDir}\\LinkShift_${name}_${Date.now()}_${tempCounter++}.ps1`;
    await Neutralino.filesystem.writeFile(tempFile, scriptText);

    try {
        const b64args = args.map((a) => toB64(String(a)));
        const command = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '
            + quoteArg(tempFile)
            + (b64args.length ? ' ' + b64args.join(' ') : '');

        const outLines = [];
        const job = spawnStreaming(command, {
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

        const res = await job;

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
}
