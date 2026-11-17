/**
 * LinkShift — core/exec.js
 *
 * Запуск процессов Windows из Neutralinojs с полной обработкой кодировок:
 *  - все динамические данные передаются в PowerShell как Base64 (UTF-8),
 *    поэтому кириллица, пробелы и спецсимволы в путях не ломают командную строку;
 *  - инлайн-скрипты передаются через `powershell -EncodedCommand`
 *    (Base64 от UTF-16LE) — никакой ручной экранизации кавычек;
 *  - вывод процессов читается построчно через os.spawnProcess,
 *    что даёт таймауты, отмену и потоковый прогресс.
 */

import { AppError } from './i18n.js';

/* ------------------------------------------------------------ кодировки */

/** UTF-8 → Base64 (для аргументов PowerShell-скриптов и путей). */
export function toB64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

/** UTF-16LE → Base64 (для `powershell -EncodedCommand`). */
export function toB64Utf16(text) {
    const s = String(text);
    const bytes = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        bytes[i * 2] = code & 0xff;
        bytes[i * 2 + 1] = (code >> 8) & 0xff;
    }
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

/** Экранирование пути для командной строки Windows (в путях кавычек не бывает). */
export function quoteArg(value) {
    return '"' + String(value).replace(/^"+|"+$/g, '').replace(/\\+$/, '') + '"';
}

/** Префикс \\?\ для снятия лимита MAX_PATH (260) в robocopy/.NET. */
export function withLongPrefix(path) {
    let p = String(path).replace(/^"+|"+$/g, '').replace(/\\+$/, '');
    if (p.startsWith('\\\\?\\')) return p;
    if (p.startsWith('\\\\')) return '\\\\?\\UNC\\' + p.slice(2);
    return '\\\\?\\' + p;
}

/* ------------------------------------------------- запуск с потоковым выводом */

/**
 * Запускает команду и собирает её вывод, вызывая колбэки на каждую строку.
 *
 * @param {string} command
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  0 / null — без таймаута
 * @param {(line: string) => void} [opts.onStdOutLine]
 * @param {(line: string) => void} [opts.onStdErrLine]
 * @returns {Promise<{exitCode:number|null, stdOut:string, stdErr:string,
 *                    timedOut:boolean, cancelled:boolean}>}
 *          у промиса есть метод .cancel() для досрочной остановки.
 */
export function spawnStreaming(command, opts = {}) {
    const { timeoutMs = 120000, onStdOutLine = null, onStdErrLine = null } = opts;
    let cancelFn = null;

    const promise = (async () => {
        let proc = null;
        let settled = false;
        let stdOutAll = '';
        let stdErrAll = '';
        let outBuf = '';
        let errBuf = '';
        let timeoutTimer = null;
        let forceTimer = null;
        let killed = false;
        let resolveFn = null;

        const detach = () => {
            if (handler) {
                Neutralino.events.off('spawnedProcess', handler).catch(() => {});
                handler = null;
            }
        };

        const finish = (payload) => {
            if (settled) return;
            settled = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (forceTimer) clearTimeout(forceTimer);
            detach();
            resolveFn(payload);
        };

        const kill = () => {
            if (killed) return;
            killed = true;
            Neutralino.os.updateSpawnedProcess(proc.id, 'exit').catch(() => {});
            // Страховка: если событие 'exit' не пришло — завершаем сами.
            forceTimer = setTimeout(() => finish({
                exitCode: null, stdOut: stdOutAll, stdErr: stdErrAll,
                timedOut: true, cancelled: true,
            }), 5000);
        };

        cancelFn = kill;

        // Слушатель вешается ДО запуска процесса: события, пришедшие между
        // spawnProcess и подпиской, не теряются.
        const handler = (evt) => {
            const d = evt && evt.detail ? evt.detail : {};
            if (proc == null || d.id !== proc.id) return;
            if (d.action === 'stdOut') {
                const chunk = d.data == null ? '' : String(d.data);
                stdOutAll += chunk;
                outBuf += chunk;
                let idx;
                while ((idx = outBuf.indexOf('\n')) >= 0) {
                    const line = outBuf.slice(0, idx).replace(/\r$/, '');
                    outBuf = outBuf.slice(idx + 1);
                    if (line && onStdOutLine) {
                        try { onStdOutLine(line); } catch { /* колбэк не должен ронять чтение */ }
                    }
                }
            } else if (d.action === 'stdErr') {
                const chunk = d.data == null ? '' : String(d.data);
                stdErrAll += chunk;
                errBuf += chunk;
                let idx;
                while ((idx = errBuf.indexOf('\n')) >= 0) {
                    const line = errBuf.slice(0, idx).replace(/\r$/, '');
                    errBuf = errBuf.slice(idx + 1);
                    if (line && onStdErrLine) {
                        try { onStdErrLine(line); } catch { }
                    }
                }
            } else if (d.action === 'exit') {
                finish({
                    exitCode: Number(d.data),
                    stdOut: stdOutAll,
                    stdErr: stdErrAll,
                    timedOut: false,
                    cancelled: killed,
                });
            }
        };

        Neutralino.events.on('spawnedProcess', handler);

        let spawned;
        try {
            spawned = await Neutralino.os.spawnProcess(command);
        } catch (e) {
            detach();
            // Нативный сбой запуска: сырую ошибку сервера сохраняем в details,
            // чтобы UI показал, какой вызов и какой код вернул.
            const raw = JSON.stringify(e && typeof e === 'object' ? { code: e.code, message: e.message } : String(e));
            throw new AppError('ERR_INTERNAL', { details: `spawnProcess failed: ${raw}` });
        }
        proc = spawned;

        return await new Promise((resolve) => {
            resolveFn = resolve;
            if (timeoutMs && timeoutMs > 0) {
                timeoutTimer = setTimeout(kill, timeoutMs);
            }
        });
    })();

    promise.cancel = () => { if (cancelFn) cancelFn(); };
    return promise;
}

/* --------------------------------------------------------- PowerShell inline */

/**
 * Выполняет инлайн-скрипт PowerShell 5.1 без риска для кавычек и кодировки:
 * скрипт уходит как `-EncodedCommand` (Base64 UTF-16LE), перед ним принудительно
 * включается UTF-8 для stdout.
 *
 * @param {string} script  Текст скрипта (можно с Unicode).
 * @param {object} [opts]  Те же опции, что у spawnStreaming.
 */
export async function runPSInline(script, opts = {}) {
    const prefix = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ';
    const encoded = toB64Utf16(prefix + script);
    const command = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + encoded;
    return spawnStreaming(command, opts);
}
