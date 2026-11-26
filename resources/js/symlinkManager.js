/**
 * LinkShift — symlinkManager.js
 *
 * Безопасная транзакция «Перенести и связать» (mklink) + откат + история.
 *
 * Схема транзакции (данные не могут потеряться ни на одном шаге):
 *   1. validate — источник существует, это не ссылка, не системный путь;
 *      целевая папка не существует; проверка прав администратора.
 *   2. space    — размер дерева источника и свободное место целевого диска.
 *   3. rename   — исходная папка → "<имя>.bak_<штамп>". Если папка занята
 *                 запущенной программой, Windows выдаст ошибку блокировки
 *                 и транзакция прервется ДО начала копирования.
 *   4. copy     — robocopy /E /COPY:DATS /XJ (права доступа, атрибуты,
 *                 пропуск вложенных ссылок); прогресс по опросу приемника.
 *   5. link     — mklink /J (junction, без админа) или /D (symlink).
 *   6. verify   — проверка типа и цели созданной ссылки.
 *   7. cleanup  — удаление .bak ТОЛЬКО после успешной проверки связи.
 *
 * Любая ошибка на шагах 4-7 вызывает автоматический откат: удалить ссылку
 * (если создана), вернуть .bak на место, удалить частичную копию.
 */

import { runPSInline, toB64, quoteArg } from './core/exec.js';
import { runScript } from './core/ps.js';
import { measureDirectorySize, getDriveSpace, getLinkInfo } from './core/fsinfo.js';
import * as history from './core/history.js';
import { AppError, isAppError, t } from './core/i18n.js';

const MB = 1024 * 1024;
const FREE_SPACE_MARGIN = 256 * MB;   // запас под метаданные NTFS и рост во время копирования
const COPY_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 часов на очень большие папки
const COPY_POLL_MS = 1500;

/* ------------------------------------------------------------- утилиты */

/** Нормализация пути: кавычки, косые черты, хвостовые слеши, префикс \\?\. */
export function normalizePath(p) {
    let s = String(p ?? '').trim().replace(/^["']+|["']+$/g, '');
    // Drag-drop Neutralino и копипаст дают косые черты (C:/Users/...). Для
    // PowerShell это терпимо, но сырые .NET API с префиксом \\?\ трактуют
    // путь буквально: "\\?\C:/..." -> «Не удалось найти часть пути».
    s = s.replace(/\//g, '\\');
    s = s.replace(/\\+$/, '');
    s = s.replace(/^\\\\\?\\/, ''); // снимаем \\?\ (4 символа: \ \ ? \)
    if (/^[a-zA-Z]:$/.test(s)) s += '\\';
    return s;
}

function leafOf(p) {
    const n = normalizePath(p);
    const idx = n.lastIndexOf('\\');
    return idx >= 0 ? n.slice(idx + 1) : n;
}

function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 1234567 → "1.2 MB" — для сообщений об ошибках и UI. */
export function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

async function pathExists(p) {
    try {
        await Neutralino.filesystem.getStats(p);
        return true;
    } catch {
        return false;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- права администратора */

const PS_IS_ADMIN = '((([Security.Principal.WindowsPrincipal]'
    + '[Security.Principal.WindowsIdentity]::GetCurrent())'
    + '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))'
    + '.ToString().ToLower())';

/** True, если процесс запущен с правами администратора. */
export async function isAdmin() {
    const res = await runPSInline(PS_IS_ADMIN, { timeoutMs: 15000 });
    return res.stdOut.trim() === 'true';
}

/**
 * Путь к исполняемому файлу приложения (нужен для перезапуска от админа).
 * 1-й способ: NL_ARGS содержит путь к .exe; 2-й: WMI по родительскому процессу.
 */
export async function getOwnExecutablePath() {
    const args = Array.isArray(window.NL_ARGS) ? window.NL_ARGS : [];
    for (const a of args) {
        const cand = String(a).replace(/^"+|"+$/g, '');
        if (/\.exe$/i.test(cand)) {
            try {
                const st = await Neutralino.filesystem.getStats(cand);
                if (st.isFile) return cand;
            } catch { /* попробуем следующий аргумент */ }
        }
    }

    const res = await runPSInline(
        '$p=(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId; '
        + '(Get-CimInstance Win32_Process -Filter "ProcessId=$p").ExecutablePath',
        { timeoutMs: 20000 },
    );
    const exe = res.stdOut.trim();
    if (/\.exe$/i.test(exe)) return exe;
    throw new AppError('ERR_INTERNAL', { details: 'cannot resolve own executable path' });
}

/**
 * Перезапуск приложения с правами администратора через UAC.
 * Если пользователь отклонит запрос UAC — приложение НЕ закроется.
 */
export async function restartAsAdmin() {
    const exe = await getOwnExecutablePath();
    const workDir = exe.slice(0, Math.max(exe.lastIndexOf('\\'), 0)) || '.';
    const script = 'try { '
        + `Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toB64(exe)}'))) `
        + `-WorkingDirectory ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toB64(workDir)}'))) `
        + '-Verb RunAs | Out-Null; Write-Output "ok" '
        + '} catch { Write-Output "uac-fail" }';
    const res = await runPSInline(script, { timeoutMs: 120000 });
    if (!res.stdOut.includes('ok')) throw new AppError('ERR_UAC_CANCELLED');
    await Neutralino.app.exit(0);
}

/** Сводка окружения для проверки при старте приложения. */
export async function checkEnvironment() {
    return {
        isAdmin: await isAdmin(),
        os: window.NL_OS ?? null,
        platform: window.NL_PLATFORM ?? null,
        appVersion: window.NL_VERSION ?? null,
        appPath: await getOwnExecutablePath().catch(() => null),
    };
}

/* ------------------------------------------------------ robocopy / копия */

function robocopyFlags(admin) {
    // DATS = Data+Attributes+Timestamps+Security(NTFS ACL). 'S' требует админа.
    const acl = admin ? '/COPY:DATS' : '/COPY:DAT';
    return ['/E', acl, '/DCOPY:DAT', '/R:1', '/W:1', '/NP', '/MT:8', '/XJ', '/NFL', '/NDL'].join(' ');
}

/**
 * robocopy с потоковым прогрессом: опрашиваем приемник каждые 1.5 сек.
 * (robocopy не умеет проценты, а построчный разбор вывода ломается на
 * русскоязычных Windows из-за локализованных сообщений.)
 *
 * Сам robocopy запускается ВНУТРИ PowerShell-обёртки copy-dir.ps1 с
 * Base64-путями. Прямой спавн страдал от ANSI командной строки Neutralino:
 * UTF-8 путь с кириллицей превращался в mojibake, robocopy не находил
 * источник и выходил с кодом 16. Возврат/отмена: таймаут обёртки
 * превращается в exitCode null (неудача копирования).
 */
async function runCopyWithProgress(fromDir, toDir, totalBytes, totalFiles, onProgress, flags) {
    let stopped = false;
    const poller = (async () => {
        while (!stopped) {
            await sleep(COPY_POLL_MS);
            if (stopped) break;
            try {
                const m = await measureDirectorySize(toDir);
                if (m.ok && m.exists && !m.isReparsePoint && onProgress) {
                    onProgress({
                        copiedBytes: Number(m.bytes || 0),
                        totalBytes: Number(totalBytes || 0),
                        copiedFiles: Number(m.files || 0),
                        totalFiles: Number(totalFiles || 0),
                    });
                }
            } catch { /* проба не удалась — не критично */ }
        }
    })();

    try {
        const res = await runScript('copy-dir', [fromDir, toDir, flags], { timeoutMs: COPY_TIMEOUT_MS });
        if (!res || res.ok !== true) {
            throw new AppError('ERR_ROBOCOPY_FAILED', {
                exitCode: 'error',
                hint: ` · Robocopy: wrapper failed (${(res && (res.error || res.message)) || 'no result'})`,
            });
        }
        // /UNILOG (UTF-16) — единственный кодировочно-надёжный вывод robocopy.
        return { exitCode: res.exitCode, timedOut: false, output: String(res.log ?? '').slice(-4000) };
    } catch (e) {
        if (isAppError(e) && e.code === 'ERR_TIMEOUT') {
            // Обёртка убита по таймауту: robocopy не успел завершиться.
            return { exitCode: null, timedOut: true, output: '' };
        }
        throw e;
    } finally {
        stopped = true;
        await poller;
    }
}

/** Коды 0-7 у robocopy — успех (1 = «файлы скопированы», это норма). */
function robocopyFailed(exitCode) {
    return exitCode == null || exitCode >= 8;
}

/** Расшифровка типовых кодов Win32 для тоста — всегда на английском. */
const WIN32_ERROR_EN = {
    2: 'The system cannot find the file specified',
    3: 'The system cannot find the path specified',
    5: 'Access is denied',
    32: 'The file is in use by another process (sharing violation)',
    87: 'The parameter is incorrect',
    123: 'The filename, directory name, or volume label syntax is incorrect',
    161: 'The specified path is invalid',
    183: 'Cannot create a file when that file already exists',
    267: 'The directory name is invalid',
};

/**
 * Диагностика robocopy для тоста — всегда на английском. Консольный вывод
 * robocopy идёт в OEM-кодировке и в UTF-8-канале превращается в ромбы;
 * строка «ERROR N (0x…)» языконезависима (цифры и скобки — ASCII, выживают
 * в любой кодировке), расшифровку даёт таблица Win32. Хвост строки (какой
 * файл/папка) берём из /UNILOG — он UTF-16 и читается нормально.
 */
function robocopyErrorHint(output, exitCode) {
    const text = String(output ?? '');
    let last = null;
    for (const m of text.matchAll(/\bERROR\s+(\d+)\s+\(0x([0-9A-Fa-f]+)\)/g)) last = m;
    if (last) {
        const n = parseInt(last[1], 10);
        const hex = last[2].toUpperCase();
        const desc = WIN32_ERROR_EN[n] ?? `Windows error 0x${hex} (${n})`;
        const line = (text.slice(last.index).split(/\r?\n/)[0] ?? '').trim();
        const ctx = line.replace(/^.*?\(0x[0-9A-Fa-f]+\)\s*/, '').trim();
        let hint = `robocopy reported ERROR ${n} (0x${hex}): ${desc}`;
        if (ctx) hint += ` — ${ctx}`.slice(0, 200);
        return hint.slice(0, 240);
    }
    const code = Number(exitCode);
    if (code >= 16) return 'robocopy failed before copying anything — usually the source path was not found or access was denied';
    if (code >= 8) return 'some files failed to copy';
    return '';
}

/* ------------------------------------------------------------ верификация */

async function verifyLink(src, dest, effectiveType) {
    const info = await getLinkInfo(src);
    if (!info.exists || !info.isReparsePoint) {
        return { ok: false, details: `link not found at ${src}` };
    }
    const expected = effectiveType === 'symlink' ? 'SymbolicLink' : 'Junction';
    const actual = String(info.linkType ?? '');
    if (actual.toLowerCase() !== expected.toLowerCase()) {
        return { ok: false, details: `expected ${expected}, got "${actual}"` };
    }
    const target = String(info.linkTarget ?? '').replace(/[\\/]+$/, '').toLowerCase();
    if (target !== dest.toLowerCase()) {
        return { ok: false, details: `link target mismatch: "${info.linkTarget}" != "${dest}"` };
    }
    return { ok: true };
}

/* --------------------------------------------------------------- откат */

async function rollbackAfterFailure({ src, bakPath, dest, linkCreated }) {
    const problems = [];
    let linkRemoved = true;

    if (linkCreated) {
        try {
            const rl = await runScript('remove-link', [src]);
            if (!rl.ok) {
                problems.push(`remove-link: ${rl.message || rl.error}`);
                linkRemoved = false;
            }
        } catch (e) {
            problems.push(`remove-link: ${(e && e.message) || e}`);
            linkRemoved = false;
        }
    }
    if (bakPath && linkRemoved) {
        // .bak поверх неубранной ссылки переименовывать бессмысленно:
        // гарантированное «файл уже существует» добавляло только шум.
        try {
            const ren = await runScript('rename-dir', [bakPath, leafOf(src)]);
            if (!ren.ok) problems.push(`restore rename: ${ren.message || ren.error}`);
        } catch (e) {
            problems.push(`restore rename: ${(e && e.message) || e}`);
        }
    }
    if (dest) {
        try {
            const del = await runScript('delete-dir', [dest]);
            if (!del.ok) problems.push(`delete partial copy: ${del.message || del.error}`);
        } catch (e) {
            problems.push(`delete partial copy: ${(e && e.message) || e}`);
        }
    }
    return { ok: problems.length === 0, details: problems.join('; ') };
}

/* --------------------------------------------------------- транзакция */

/**
 * Режим «Перенести и связать»: безопасный перенос папки на другой диск
 * с созданием на ее месте junction/symlink.
 *
 * @param {object} options
 * @param {string} options.sourcePath       Исходная папка (можно с %ENV%).
 * @param {string} options.targetParent     Каталог на другом диске (создается при отсутствии).
 * @param {'junction'|'symlink'} [options.linkType]  По умолчанию junction.
 * @param {(step:string, info:object) => void} [options.onStep]
 * @param {(progress:object) => void} [options.onProgress]  { copiedBytes, totalBytes, copiedFiles, totalFiles }
 * @param {boolean} [options.createTargetParent]
 * @returns {Promise<{ok:true, entry:object, warnings:string[], robocopyExitCode:number}>}
 */
export async function moveAndLink(options = {}) {
    const {
        sourcePath,
        targetParent,
        linkType = 'junction',
        onStep = null,
        onProgress = null,
        createTargetParent = true,
    } = options;

    if (!sourcePath) throw new AppError('ERR_SOURCE_NOT_FOUND', { path: '' });
    const emit = (step, info = {}) => {
        if (onStep) { try { onStep(step, info); } catch { /* UI не должен ронять транзакцию */ } }
    };
    const warnings = [];

    /* --- Шаг 1: валидация --- */
    emit('validate', { path: sourcePath });
    const src = normalizePath(sourcePath);
    const v = await runScript('validate-source', [src]);
    if (!v.exists) throw new AppError('ERR_SOURCE_NOT_FOUND', { path: src });
    if (!v.isDirectory) throw new AppError('ERR_SOURCE_NOT_DIR', { path: src });
    if (v.isReparsePoint) {
        throw new AppError('ERR_SOURCE_IS_LINK', { path: src, linkType: v.linkType ?? '' });
    }
    if (v.isSystemPath) throw new AppError('ERR_SYSTEM_PATH_FORBIDDEN', { path: v.path });
    if (v.pathRoot && v.pathRoot.toLowerCase() === v.path.toLowerCase()) {
        throw new AppError('ERR_SOURCE_IS_ROOT', { path: src });
    }

    const srcName = v.name;
    const parent = normalizePath(targetParent ?? '');
    if (!parent) throw new AppError('ERR_TARGET_PARENT_MISSING', { path: '' });
    const srcLower = src.toLowerCase();
    const parentLower = parent.toLowerCase();
    if (parentLower === srcLower || (parentLower + '\\').startsWith(srcLower + '\\')) {
        throw new AppError('ERR_TARGET_INSIDE_SOURCE', { path: parent });
    }
    if (!(await pathExists(parent))) {
        if (!createTargetParent) throw new AppError('ERR_TARGET_PARENT_MISSING', { path: parent });
        await Neutralino.filesystem.createDirectory(parent); // рекурсивно
    }
    const dest = parent.replace(/[\\/]+$/, '') + '\\' + srcName;
    if (await pathExists(dest)) throw new AppError('ERR_TARGET_EXISTS', { path: dest });

    /* --- Шаг 2: свободное место --- */
    emit('space', { source: src, target: dest });
    const size = await measureDirectorySize(src);
    if (!size.ok || !size.exists) throw new AppError('ERR_SOURCE_NOT_FOUND', { path: src });
    const space = await getDriveSpace(dest);
    if (!space.ok) {
        throw new AppError('ERR_INTERNAL', { details: `no drive info for ${dest}` });
    }
    const need = Number(size.bytes ?? 0) + FREE_SPACE_MARGIN;
    if (space.freeBytes < need) {
        throw new AppError('ERR_NO_FREE_SPACE', {
            need: formatBytes(need),
            free: formatBytes(space.freeBytes),
            drive: space.drive,
        });
    }
    if (size.reparseDirs > 0) {
        warnings.push(t('WARN_SOURCE_CONTAINS_LINKS', { count: size.reparseDirs }));
    }

    const admin = await isAdmin();
    if (!admin) warnings.push(t('WARN_COPY_ACL_SKIPPED'));

    /* --- Шаг 3: переименование в .bak (проба замка) --- */
    emit('rename', { path: src });
    const bakName = `${srcName}.bak_${timestamp()}`;
    const ren = await runScript('rename-dir', [src, bakName]);
    if (!ren.ok) {
        if (ren.error === 'locked-or-in-use') throw new AppError('ERR_SOURCE_LOCKED', { path: src });
        if (ren.error === 'access-denied') throw new AppError('ERR_SOURCE_ACCESS_DENIED', { path: src });
        if (ren.error === 'not-found') throw new AppError('ERR_SOURCE_NOT_FOUND', { path: src });
        throw new AppError('ERR_RENAME_FAILED', { details: ren.message ?? ren.error ?? '' });
    }
    const bakPath = ren.newPath;

    /* --- Шаги 4-7: копия → ссылка → проверка → уборка --- */
    const effectiveType = (linkType === 'symlink' && admin) ? 'symlink' : 'junction';
    if (linkType === 'symlink' && !admin) warnings.push(t('WARN_SYMLINK_FALLBACK'));

    let linkCreated = false;
    try {
        emit('copy', { from: bakPath, to: dest, totalBytes: size.bytes, totalFiles: size.files });
        const copyRes = await runCopyWithProgress(
            bakPath, dest, size.bytes, size.files, onProgress, robocopyFlags(admin),
        );
        if (robocopyFailed(copyRes.exitCode)) {
            const rcHint = robocopyErrorHint(copyRes.output, copyRes.exitCode);
            throw new AppError('ERR_ROBOCOPY_FAILED', {
                exitCode: copyRes.exitCode == null ? 'timeout' : String(copyRes.exitCode),
                hint: rcHint ? ` · Robocopy: ${rcHint}` : '',
            });
        }

        emit('link', { linkPath: src, target: dest, linkType: effectiveType });
        const mk = await runScript('make-link', [src, dest, effectiveType === 'symlink' ? 'D' : 'J']);
        if (!mk.ok) throw new AppError('ERR_LINK_FAILED', { details: mk.message ?? mk.error ?? '' });
        linkCreated = true;

        emit('verify', { linkPath: src });
        const check = await verifyLink(src, dest, effectiveType);
        if (!check.ok) throw new AppError('ERR_LINK_VERIFY_FAILED', { details: check.details ?? '' });

        emit('cleanup', { bakPath });
        // Сбой уборки (ok:false или крах скрипта) НЕ откатывает успешный
        // перенос: копия и ссылка уже проверены. Раньше крах delete-dir
        // проваливался в общий catch и запускал бессмысленный откат
        // (remove-link поверх рабочей ссылки -> «уже существует»).
        // Бэкап остаётся, путь попадает в историю и предупреждение.
        let del = { ok: false, error: 'cleanup-crashed' };
        try {
            del = await runScript('delete-dir', [bakPath]);
        } catch (e) {
            del = { ok: false, error: 'cleanup-crashed', message: String((e && e.message) || e) };
        }
        let bakKept = null;
        if (!del.ok) {
            bakKept = bakPath;
            warnings.push(t('WARN_BAK_KEPT', { path: bakPath }));
        }

        const entry = await history.add({
            originalPath: src,
            targetPath: dest,
            bakPath: bakKept,
            linkType: effectiveType,
            drive: space.drive,
            sizeBytes: Number(size.bytes ?? 0),
            files: Number(size.files ?? 0),
            status: 'active',
        });

        emit('done', { entry, warnings });
        return { ok: true, entry, warnings, robocopyExitCode: copyRes.exitCode };
    } catch (e) {
        emit('rollback', { code: e instanceof AppError ? e.code : 'ERR_INTERNAL' });
        const rb = await rollbackAfterFailure({ src, bakPath, dest, linkCreated });
        if (!rb.ok) {
            // Код первопричины в деталях: ERR_ROLLBACK_FAILED раньше прятал,
            // ЧТО именно сломало транзакцию (виден был только откат).
            const cause = isAppError(e) ? `[${e.code}] ` : '';
            throw new AppError('ERR_ROLLBACK_FAILED', { details: cause + rb.details }, e);
        }
        throw e;
    }
}

/* --------------------------------------------------- «Вернуть как было» */

/**
 * Откат переноса по записи истории (id или originalPath):
 *   Состояние A — ссылка жива: удалить ссылку (rmdir), вернуть данные
 *                robocopy /MOVE на исходное место, удалить пустую цель.
 *   Состояние B — транзакция прервалась до копирования: вернуть .bak обратно.
 *
 * @param {string} idOrPath  id записи истории либо originalPath.
 */
export async function revertLink(idOrPath, { onStep = null, onProgress = null } = {}) {
    const emit = (step, info = {}) => {
        if (onStep) { try { onStep(step, info); } catch { } }
    };
    const warnings = [];

    const db = await history.load();
    const key = String(idOrPath ?? '');
    let entry = db.entries.find((e) => e.id === key) ?? null;
    if (!entry) entry = await history.findByOriginalPath(normalizePath(key));
    if (!entry) throw new AppError('ERR_NOT_IN_HISTORY', { path: key });

    const src = normalizePath(entry.originalPath);
    const dest = normalizePath(entry.targetPath);
    const srcInfo = await getLinkInfo(src);

    /* --- Состояние A: ссылка активна, данные лежат на целевом диске --- */
    if (srcInfo.exists && srcInfo.isReparsePoint) {
        emit('remove-link', { path: src });
        const rl = await runScript('remove-link', [src]);
        if (!rl.ok) throw new AppError('ERR_LINK_FAILED', { details: rl.message ?? rl.error ?? '' });

        emit('move-back', { from: dest, to: src });
        await Neutralino.filesystem.createDirectory(src); // заново создать исходный каталог

        const dstSize = await measureDirectorySize(dest);
        const admin = await isAdmin();
        const copyRes = await runCopyWithProgress(
            dest, src,
            dstSize.ok ? Number(dstSize.bytes ?? 0) : 0,
            dstSize.ok ? Number(dstSize.files ?? 0) : 0,
            onProgress,
            robocopyFlags(admin) + ' /MOVE',
        );
        if (robocopyFailed(copyRes.exitCode)) {
            const rcHint = robocopyErrorHint(copyRes.output, copyRes.exitCode);
            await history.update(entry.id, {
                status: 'error',
                notes: [...(entry.notes ?? []),
                    `revert move failed (exit ${copyRes.exitCode ?? 'timeout'}); files remain at ${dest}`],
            });
            throw new AppError('ERR_REVERT_MOVE_FAILED', {
                exitCode: copyRes.exitCode == null ? 'timeout' : String(copyRes.exitCode),
                hint: rcHint ? ` · Robocopy: ${rcHint}` : '',
            });
        }

        emit('cleanup-target', { path: dest });
        const after = await measureDirectorySize(dest);
        if (after.ok && after.exists && !after.isReparsePoint
            && Number(after.files ?? 0) === 0 && Number(after.dirs ?? 0) === 0) {
            const del = await runScript('delete-dir', [dest]);
            if (!del.ok) warnings.push(t('WARN_TARGET_NOT_EMPTY', { path: dest }));
        } else if (after.ok && after.exists) {
            // Остались файлы (например, созданные после переноса) — не трогаем.
            warnings.push(t('WARN_TARGET_NOT_EMPTY', { path: dest }));
        }

        if (warnings.length) {
            await history.update(entry.id, { notes: [...(entry.notes ?? []), ...warnings] });
        }
        // Спецификация: после успешного «Вернуть как было» запись удаляется из истории.
        await history.remove(entry.id);
        const updated = { ...entry, status: 'reverted', revertedAt: new Date().toISOString() };
        emit('done', { entry: updated, warnings });
        return { ok: true, entry: updated, warnings };
    }

    /* --- Состояние B: прерванная транзакция — восстановление из .bak --- */
    const bakPath = entry.bakPath ? normalizePath(entry.bakPath) : null;
    if (bakPath && (await pathExists(bakPath)) && !(await pathExists(src))) {
        emit('restore-bak', { path: bakPath });
        const ren = await runScript('rename-dir', [bakPath, leafOf(src)]);
        if (!ren.ok) {
            if (ren.error === 'locked-or-in-use') throw new AppError('ERR_SOURCE_LOCKED', { path: bakPath });
            throw new AppError('ERR_RENAME_FAILED', { details: ren.message ?? ren.error ?? '' });
        }
        // Спецификация: после успешного восстановления запись удаляется из истории.
        await history.remove(entry.id);
        const updated = {
            ...entry,
            status: 'reverted',
            revertedAt: new Date().toISOString(),
            notes: [...(entry.notes ?? []), 'restored_from_bak'],
        };
        emit('done', { entry: updated, warnings: ['restored_from_bak'] });
        return { ok: true, entry: updated, warnings: ['restored_from_bak'] };
    }

    throw new AppError('ERR_REVERT_STATE_UNEXPECTED', {
        details: `originalPath=${srcInfo.exists ? (srcInfo.isReparsePoint ? 'link' : 'real directory') : 'missing'}`
            + `; targetPath=${dest}; bakPath=${bakPath ?? 'none'}`,
    });
}

/* ------------------------------------------- откат внешней (ручной) ссылки */

/**
 * Откат ссылки, созданной вне LinkShift (mklink вручную): удалить ссылку
 * и вернуть файлы с целевой папки на исходное место. В историю не пишется —
 * запись «Вернуть как было» имеет смысл только для ссылок приложения.
 *
 * @param {string} pathArg  Путь ссылки (reparse point, можно с %ENV%).
 * @param {object} [opts]
 * @param {boolean} [opts.unlinkOnly=false]  Удалить только ссылку (когда цель
 *                             недоступна; подтверждается отдельно в UI).
 * @param {(step:string, info:object) => void} [opts.onStep]
 * @param {(progress:object) => void} [opts.onProgress]
 * @returns {Promise<{ok:true, warnings:string[], unlinkedOnly:boolean}>}
 */
export async function revertExternalLink(pathArg, { onStep = null, onProgress = null, unlinkOnly = false } = {}) {
    const emit = (step, info = {}) => {
        if (onStep) { try { onStep(step, info); } catch { } }
    };
    const warnings = [];

    const src = normalizePath(pathArg);
    if (!src) throw new AppError('ERR_NOT_A_LINK', { path: '' });

    emit('validate', { path: src });
    const v = await runScript('validate-source', [src]);
    if (!v.exists || !v.isDirectory || !v.isReparsePoint) {
        throw new AppError('ERR_NOT_A_LINK', { path: src });
    }
    if (v.isSystemPath) throw new AppError('ERR_SYSTEM_PATH_FORBIDDEN', { path: v.path });

    const dest = normalizePath(v.linkTarget ?? '');
    if (!dest || dest.toLowerCase() === src.toLowerCase()) {
        throw new AppError('ERR_LINK_TARGET_MISSING', { path: src });
    }

    /* Только удалить ссылку: цель недоступна или пользователь так решил. */
    if (unlinkOnly) {
        emit('remove-link', { path: src });
        const rl = await runScript('remove-link', [src]);
        if (!rl.ok) throw new AppError('ERR_LINK_FAILED', { details: rl.message ?? rl.error ?? '' });
        const still = await getLinkInfo(dest);
        if (still.exists) warnings.push(t('WARN_TARGET_NOT_EMPTY', { path: dest }));
        emit('done', {});
        return { ok: true, warnings, unlinkedOnly: true };
    }

    const dstInfo = await getLinkInfo(dest);
    const targetReady = dstInfo.exists && dstInfo.isDirectory && !dstInfo.isReparsePoint;
    if (!targetReady) throw new AppError('ERR_LINK_TARGET_MISSING', { path: dest });

    /* Цель внутри ссылки не пройдет: robocopy /MOVE ходил бы по кругу. */
    if ((dest.toLowerCase() + '\\').startsWith(src.toLowerCase() + '\\')) {
        throw new AppError('ERR_REVERT_STATE_UNEXPECTED', {
            details: `link target is inside the link: ${dest}`,
        });
    }

    /* --- место на исходном диске --- */
    const size = await measureDirectorySize(dest);
    if (!size.ok || !size.exists) throw new AppError('ERR_LINK_TARGET_MISSING', { path: dest });
    const space = await getDriveSpace(src);
    if (!space.ok) throw new AppError('ERR_INTERNAL', { details: `no drive info for ${src}` });
    const need = Number(size.bytes ?? 0) + FREE_SPACE_MARGIN;
    if (space.freeBytes < need) {
        throw new AppError('ERR_NO_FREE_SPACE', {
            need: formatBytes(need),
            free: formatBytes(space.freeBytes),
            drive: space.drive,
        });
    }

    /* --- удалить ссылку и вернуть данные --- */
    emit('remove-link', { path: src });
    const rl = await runScript('remove-link', [src]);
    if (!rl.ok) throw new AppError('ERR_LINK_FAILED', { details: rl.message ?? rl.error ?? '' });

    emit('move-back', { from: dest, to: src });
    await Neutralino.filesystem.createDirectory(src);

    const admin = await isAdmin();
    const copyRes = await runCopyWithProgress(
        dest, src,
        Number(size.bytes ?? 0), Number(size.files ?? 0),
        onProgress,
        robocopyFlags(admin) + ' /MOVE',
    );
    if (robocopyFailed(copyRes.exitCode)) {
        throw new AppError('ERR_REVERT_MOVE_FAILED', {
            exitCode: copyRes.exitCode == null ? 'timeout' : String(copyRes.exitCode),
        });
    }

    emit('cleanup-target', { path: dest });
    const after = await measureDirectorySize(dest);
    if (after.ok && after.exists && !after.isReparsePoint
        && Number(after.files ?? 0) === 0 && Number(after.dirs ?? 0) === 0) {
        const del = await runScript('delete-dir', [dest]);
        if (!del.ok) warnings.push(t('WARN_TARGET_NOT_EMPTY', { path: dest }));
    } else if (after.ok && after.exists) {
        warnings.push(t('WARN_TARGET_NOT_EMPTY', { path: dest }));
    }

    emit('done', {});
    return { ok: true, warnings, unlinkedOnly: false };
}

/* --------------------------------------------------------- re-exports */

export { isAdmin as checkAdminRights };
export { measureDirectorySize, getDriveSpace, getLinkInfo } from './core/fsinfo.js';
export { list as listHistory } from './core/history.js';
