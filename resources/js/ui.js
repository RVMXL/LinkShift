/**
 * LinkShift — ui.js (Sprint 2)
 *
 * Интерфейсный слой: вкладки «Перенос», «Сканер диска C», «История»,
 * состояние страниц, локализация RU/EN без перезагрузки, светлая/тёмная
 * тема, Drag-and-Drop, нативные диалоги Windows и пошаговый прогресс.
 * Вся системная логика живет в symlinkManager.js и storageScanner.js —
 * UI только вызывает их API.
 */

import * as i18n from './core/i18n.js';
import * as history from './core/history.js';
import * as symlinkManager from './symlinkManager.js';
import * as storageScanner from './storageScanner.js';

/* Публичный API для консоли DevTools и TESTING.md */
window.LM = {
    i18n,
    history,
    symlinkManager,
    storageScanner,
    isAdmin: symlinkManager.isAdmin,
    scanStorage: storageScanner.scanStorage,
    cancelScan: storageScanner.cancelScan,
    scanExternalLinks: storageScanner.scanExternalLinks,
    cancelExternalScan: storageScanner.cancelExternalScan,
    moveAndLink: symlinkManager.moveAndLink,
    revertLink: symlinkManager.revertLink,
    revertExternalLink: symlinkManager.revertExternalLink,
};

/* ------------------------------------------------------------ утилиты */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const { formatBytes } = symlinkManager;

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

const store = {
    get(key, fallback = '') {
        try { return localStorage.getItem(`linkshift.${key}`) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(`linkshift.${key}`, value); } catch { /* приватный режим */ }
    },
};

/* ------------------------------------------------------------ состояние */

const state = {
    busy: false,
    page: 'transfer',
    admin: null,
    scanner: {
        running: false,
        items: [],
        selected: new Set(),
    },
    links: {
        running: false,
        items: [],
        historyPaths: new Set(),
    },
};

/* ------------------------------------------------------------ тосты */

function toast(message, type = 'info') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
        el.classList.add('hide');
        setTimeout(() => el.remove(), 320);
    }, 4600);
}

function showError(e) {
    const payload = i18n.isAppError(e)
        ? e.toJSON()
        : {
            code: 'ERR_INTERNAL',
            message: String(e?.message ?? e),
            raw: e && typeof e === 'object' ? { code: e.code, message: e.message } : String(e),
        };
    toast(`${payload.code}: ${payload.message}`, 'err');
    console.error('[LinkShift]', payload, e);
    // Дублируем в лог Neutralino (resources/.tmp/neutralino.log или рядом с exe):
    // по нему можно разобрать ошибку без открытых DevTools.
    try { Neutralino.debug.log(JSON.stringify(payload), 'ERROR'); } catch { /* лог не критичен */ }
}

/** Нативное подтверждение Windows (MessageBox YES_NO). */
async function confirmBox(titleKey, text) {
    const res = await Neutralino.os.showMessageBox(i18n.t(titleKey), text, 'YES_NO', 'QUESTION');
    return res === 'YES';
}

async function openInExplorer(path) {
    if (window.NL_OS !== 'Windows') return;
    try {
        await Neutralino.os.spawnProcess('explorer.exe "' + String(path).replace(/"/g, '') + '"');
    } catch { /* не критично */ }
}

/* ------------------------------------------------------------ тема и язык */

function initTheme() {
    const saved = store.get('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = saved || (prefersDark ? 'dark' : 'light');
}

function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
}

function updateLangToggle() {
    const lang = i18n.getLocale();
    $('#lang-ru').classList.toggle('active', lang === 'ru');
    $('#lang-en').classList.toggle('active', lang === 'en');
    document.documentElement.lang = lang;
}

function applyI18n() {
    $$('[data-i18n]').forEach((el) => { el.textContent = i18n.t(el.dataset.i18n); });
    $$('[data-i18n-ph]').forEach((el) => { el.placeholder = i18n.t(el.dataset.i18nPh); });
    $$('[data-i18n-title]').forEach((el) => { el.title = i18n.t(el.dataset.i18nTitle); });
    document.title = 'LinkShift';
}

async function setLang(lang) {
    await i18n.setLocale(lang);
    store.set('lang', lang);
    applyI18n();
    updateLangToggle();
    renderStatus();
    renderAdminHint();
    renderScannerItems();
    renderLinks();
    renderHistory();
}

/* ------------------------------------------------------------ роутер */

function showPage(page) {
    state.page = page;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    $$('.page').forEach((p) => p.classList.toggle('visible', p.id === `page-${page}`));
    const el = $(`#page-${page}`);
    el.classList.remove('enter');
    void el.offsetWidth; // перезапуск CSS-анимации
    el.classList.add('enter');
    if (page === 'history') renderHistory();
    if (page === 'links') renderLinks();
}

/* ------------------------------------------------------------ статусбар */

function renderStatus() {
    const chip = $('#admin-chip');
    chip.textContent = i18n.t(state.admin ? 'ui.status.admin.yes' : 'ui.status.admin.no');
    chip.className = `chip ${state.admin ? 'chip-ok' : 'chip-warn'}`;
    $('#admin-restart').classList.toggle('hidden', Boolean(state.admin));
    $('#ver-label').textContent = i18n.t('ui.status.version', {
        version: window.NL_APPVERSION ?? window.NL_VERSION ?? '?',
    });
}

function renderAdminHint() {
    const linkType = document.querySelector('input[name="linktype"]:checked')?.value ?? 'junction';
    $('#tr-admin-hint').classList.toggle('hidden', state.admin || linkType === 'junction');
}

async function refreshAdmin() {
    try {
        state.admin = await symlinkManager.isAdmin();
    } catch {
        state.admin = null;
    }
    renderStatus();
    renderAdminHint();
}

/* ------------------------------------------------------------ прогресс */

let lastStepChip = null;

function resetProgress() {
    $('#tr-progress').classList.remove('hidden');
    $('#tr-steps').innerHTML = '';
    lastStepChip = null;
    setBar(null, null);
    $('#tr-progress-label').textContent = '';
}

function setBar(copiedBytes, totalBytes) {
    const fill = $('#tr-bar-fill');
    fill.classList.remove('indeterminate');
    if (copiedBytes == null || !totalBytes) {
        fill.style.width = '0%';
        return;
    }
    const percent = Math.min(100, Math.floor((copiedBytes / totalBytes) * 100));
    fill.style.width = `${percent}%`;
}

function stepActive(step, info = {}) {
    if (lastStepChip) {
        lastStepChip.classList.remove('active');
        lastStepChip.classList.add('done');
        const spin = lastStepChip.querySelector('.spin');
        if (spin) { spin.classList.remove('spin'); spin.classList.add('dot'); }
    }
    const chip = document.createElement('span');
    chip.className = 'step-chip active';
    chip.innerHTML = '<span class="spin"></span>';
    chip.appendChild(document.createTextNode(i18n.t(`step.${step}`)));
    $('#tr-steps').appendChild(chip);
    lastStepChip = chip;

    const label = info && (info.path || info.from || info.linkPath)
        ? `${i18n.t(`step.${step}`)}: ${info.path ?? info.from ?? info.linkPath}`
        : i18n.t(`step.${step}`);
    $('#tr-progress-label').textContent = label;
}

function stepDone(step) {
    if (lastStepChip) {
        lastStepChip.classList.remove('active');
        lastStepChip.classList.add('done');
        const spin = lastStepChip.querySelector('.spin');
        if (spin) { spin.classList.remove('spin'); spin.classList.add('dot'); }
        lastStepChip = null;
    }
    $('#tr-progress-label').textContent = i18n.t(`step.${step}`);
}

function stepFail() {
    if (lastStepChip) {
        lastStepChip.style.color = 'var(--err)';
        lastStepChip.style.borderColor = 'var(--err)';
    }
}

function copyProgress(p) {
    setBar(p.copiedBytes, p.totalBytes);
    $('#tr-progress-label').textContent = `${formatBytes(p.copiedBytes)} / ${formatBytes(p.totalBytes)}`
        + ` · ${p.copiedFiles}/${p.totalFiles}`;
}

/* ------------------------------------------------------------ вкладка «Перенос» */

function setTransferSource(path) {
    $('#tr-source').value = path;
}

function updateBulkLabel() {
    const btn = $('#sc-move-selected');
    btn.textContent = i18n.t('ui.scanner.moveSelected', { count: state.scanner.selected.size });
    btn.disabled = state.scanner.selected.size === 0;
    btn.style.opacity = state.scanner.selected.size === 0 ? '0.55' : '1';
}

async function runTransfer(sourcePath, targetParent, { silent = false } = {}) {
    const linkType = document.querySelector('input[name="linktype"]:checked')?.value ?? 'junction';
    resetProgress();
    const result = await symlinkManager.moveAndLink({
        sourcePath,
        targetParent,
        linkType,
        onStep: (step, info) => stepActive(step, info),
        onProgress: copyProgress,
    });
    stepDone('done');
    setBar(1, 1);
    if (!silent) toast(i18n.t('ui.transfer.success', { path: result.entry.targetPath }), 'ok');
    for (const w of result.warnings) toast(w, 'warn');
    return result;
}

async function onMoveClick() {
    if (state.busy) return;
    const src = $('#tr-source').value.trim();
    const dst = $('#tr-target').value.trim();
    if (!src) { toast(i18n.t('ui.transfer.errNoSource'), 'warn'); return; }
    if (!dst) { toast(i18n.t('ui.transfer.errNoTarget'), 'warn'); return; }

    store.set('target', dst);
    setBusy(true);
    try {
        await runTransfer(src, dst);
        $('#tr-source').value = '';
    } catch (e) {
        stepFail();
        showError(e);
    } finally {
        setBusy(false);
        renderHistory();
    }
}

/* ------------------------------------------------------------ вкладка «Сканер» */

function sizeLabel(sizeMB) {
    return sizeMB >= 1024
        ? `${(sizeMB / 1024).toFixed(1)} ${i18n.t('ui.common.gb')}`
        : `${Math.round(sizeMB)} ${i18n.t('ui.common.mb')}`;
}

function reasonText(reason) {
    return i18n.t(`reason.${reason.code}`, reason);
}

function renderScannerItems() {
    const list = $('#sc-list');
    list.innerHTML = '';
    for (const it of state.scanner.items) {
        const row = document.createElement('div');
        row.className = 'scan-row';
        const checked = state.scanner.selected.has(it.path) ? 'checked' : '';
        const reasons = it.reasons.length
            ? `<div class="scan-reasons">${esc(it.reasons.map(reasonText).join(' · '))}</div>`
            : '';
        row.innerHTML = `
            <label class="cb"><input type="checkbox" data-scan="${esc(it.path)}" ${checked} ${it.isSafeToMove ? '' : 'disabled'}></label>
            <div class="scan-main">
                <div class="scan-name">${esc(it.name)}</div>
                <div class="scan-path" title="${esc(it.path)}">${esc(it.path)}</div>
                ${reasons}
            </div>
            <span class="chip chip-cat">${esc(i18n.t(`cat.${it.category}`))}</span>
            <span class="scan-size">${esc(sizeLabel(it.sizeMB))}</span>
            <span class="badge ${it.isSafeToMove ? 'badge-ok' : 'badge-block'}">${esc(i18n.t(it.isSafeToMove ? 'ui.scanner.safe.ok' : 'ui.scanner.safe.blocked'))}</span>
            <button class="btn btn-sm btn-subtle" data-use="${esc(it.path)}" title="${esc(i18n.t('ui.scanner.toTransfer'))}">⇱</button>`;
        list.appendChild(row);
    }
    updateBulkLabel();
}

function syncSelection(checkbox) {
    const path = checkbox.dataset.scan;
    if (checkbox.checked) state.scanner.selected.add(path);
    else state.scanner.selected.delete(path);
    updateBulkLabel();
}

async function runScan() {
    if (state.busy || state.scanner.running) return;
    const threshold = Math.max(10, Number($('#sc-threshold').value) || 500);
    store.set('threshold', String(threshold));

    state.scanner.running = true;
    state.scanner.selected.clear();
    setBusy(true);
    $('#sc-cancel').classList.remove('hidden');
    $('#sc-empty').classList.add('hidden');
    $('#sc-list').innerHTML = '';
    setBar(null, null);

    const t0 = performance.now();
    try {
        const items = await storageScanner.scanStorage({
            minSizeMB: threshold,
            onProgress: (p) => {
                $('#sc-current').textContent = i18n.t('ui.scanner.scanning', { path: p.path });
            },
        });
        state.scanner.items = items;
        renderScannerItems();
        $('#sc-current').textContent = i18n.t('ui.scanner.done', {
            count: items.length,
            seconds: Math.round((performance.now() - t0) / 100) / 10,
        });
        if (!items.length) $('#sc-empty').classList.remove('hidden');
    } catch (e) {
        if (i18n.isAppError(e) && e.code === 'ERR_CANCELLED') {
            $('#sc-current').textContent = '';
            toast(e.message, 'info');
        } else {
            $('#sc-current').textContent = '';
            showError(e);
        }
    } finally {
        state.scanner.running = false;
        setBusy(false);
        $('#sc-cancel').classList.add('hidden');
    }
}

async function runBulkMove() {
    if (state.busy || state.scanner.running) return;
    const paths = [...state.scanner.selected];
    if (!paths.length) { toast(i18n.t('ui.scanner.noSelection'), 'warn'); return; }
    const dst = $('#sc-target').value.trim();
    if (!dst) { toast(i18n.t('ui.transfer.errNoTarget'), 'warn'); return; }
    store.set('scanTarget', dst);

    const confirmed = await confirmBox(
        'ui.scanner.confirmBulkTitle',
        i18n.t('ui.scanner.confirmBulkText', { count: paths.length, target: dst }),
    );
    if (!confirmed) return;

    setBusy(true);
    let done = 0;
    let failed = 0;
    const total = paths.length;

    for (const [index, path] of paths.entries()) {
        $('#tr-progress-label').textContent = `[${index + 1}/${total}] ${path}`;
        try {
            await symlinkManager.moveAndLink({
                sourcePath: path,
                targetParent: dst,
                linkType: 'junction',
                onStep: (step, info) => stepActive(step, info),
                onProgress: copyProgress,
            });
            done += 1;
        } catch (e) {
            failed += 1;
            stepFail();
            showError(e);
            break; // при ошибке останавливаем пакет, дальше решает пользователь
        }
        state.scanner.items = state.scanner.items.filter((it) => it.path !== path);
        state.scanner.selected.delete(path);
        renderScannerItems();
    }

    setBusy(false);
    renderHistory();
    updateBulkLabel();
    toast(i18n.t('ui.scanner.bulkDone', { done, failed, total }), failed ? 'warn' : 'ok');
}

/* -------------------------------------------- вкладка «Ссылки на диске» */

function linkTypeKey(linkType) {
    return String(linkType || '').toLowerCase() === 'symboliclink' ? 'symlink' : 'junction';
}

async function renderLinks() {
    const list = $('#lk-list');
    list.innerHTML = '';
    try {
        const entries = await history.list();
        state.links.historyPaths = new Set(entries.map((e) => String(e.originalPath ?? '').toLowerCase()));
    } catch {
        state.links.historyPaths = new Set();
    }
    $('#lk-empty').classList.toggle('hidden', state.links.items.length > 0);

    // Системные ссылки (Hidden/System-атрибуты или compat-имена Windows)
    // скрыты по умолчанию; тумблер «Показывать системные» открывает их
    // с бейджем и без кнопки «Вернуть» — откат системного джанкшена опасен.
    const showSystem = store.get('showSystemLinks', '0') === '1';
    const visible = showSystem
        ? state.links.items
        : state.links.items.filter((it) => !it.isSystem);

    for (const it of visible) {
        const isApp = state.links.historyPaths.has(it.path.toLowerCase());
        const row = document.createElement('div');
        row.className = 'scan-row';
        const sysBadge = it.isSystem
            ? `<span class="badge badge-warn">${esc(i18n.t('ui.links.markSystem'))}</span>`
            : '';
        const revertBtn = it.isSystem
            ? ''
            : `<button class="btn btn-sm btn-accent" data-revert-ext="${esc(it.path)}" data-target="${esc(it.linkTarget)}">${esc(i18n.t('ui.links.revertBtn'))}</button>`;
        row.innerHTML = `
            <div class="scan-main">
                <div class="scan-name">${esc(it.name)}</div>
                <div class="scan-path" title="${esc(it.path)}">${esc(it.path)}</div>
                <div class="scan-reasons" title="${esc(it.linkTarget)}">→ ${esc(it.linkTarget || '?')}</div>
            </div>
            <span class="chip chip-cat">${esc(i18n.t(`ui.history.linktype.${linkTypeKey(it.linkType)}`))}</span>
            ${sysBadge}
            <span class="badge ${isApp ? 'badge-dim' : 'badge-ok'}">${esc(i18n.t(isApp ? 'ui.links.markApp' : 'ui.links.markExternal'))}</span>
            ${revertBtn}
            <button class="btn btn-sm btn-subtle" data-open="${esc(it.path)}">${esc(i18n.t('ui.history.openBtn'))}</button>`;
        list.appendChild(row);
    }
}

async function runLinksScan() {
    if (state.busy || state.links.running) return;
    const root = $('#lk-root').value.trim();
    store.set('linksRoot', root);

    state.links.running = true;
    setBusy(true);
    $('#lk-cancel').classList.remove('hidden');
    $('#lk-empty').classList.add('hidden');
    $('#lk-list').innerHTML = '';

    const t0 = performance.now();
    try {
        const items = await storageScanner.scanExternalLinks({
            root,
            onProgress: (p) => {
                $('#lk-current').textContent = i18n.t('ui.links.scanning', { path: p.path });
            },
        });
        state.links.items = items;
        await renderLinks();
        const hiddenSystem = store.get('showSystemLinks', '0') === '1'
            ? 0
            : items.filter((it) => it.isSystem).length;
        $('#lk-current').textContent = i18n.t('ui.links.done', {
            count: items.length,
            seconds: Math.round((performance.now() - t0) / 100) / 10,
        })
            + (hiddenSystem ? ' · ' + i18n.t('ui.links.systemHidden', { count: hiddenSystem }) : '');
        if (!items.length) $('#lk-empty').classList.remove('hidden');
    } catch (e) {
        if (i18n.isAppError(e) && e.code === 'ERR_CANCELLED') {
            $('#lk-current').textContent = '';
            toast(e.message, 'info');
        } else {
            $('#lk-current').textContent = '';
            showError(e);
        }
    } finally {
        state.links.running = false;
        setBusy(false);
        $('#lk-cancel').classList.add('hidden');
    }
}

/**
 * Откат ссылки из вкладки «Ссылки на диске»: записи истории откатываются
 * через revertLink (с удалением записи), остальные — revertExternalLink.
 */
async function doLinksRevert(path, linkTarget) {
    if (state.busy) return;
    const inApp = state.links.historyPaths.has(String(path).toLowerCase());

    const confirmed = await confirmBox(
        'ui.links.confirmRevertTitle',
        i18n.t('ui.links.confirmRevertText', { path, target: linkTarget || '?' }),
    );
    if (!confirmed) return;

    setBusy(true);
    resetProgress();
    try {
        let res;
        if (inApp) {
            res = await symlinkManager.revertLink(path, {
                onStep: (step, info) => stepActive(step, info),
                onProgress: copyProgress,
            });
        } else {
            try {
                res = await symlinkManager.revertExternalLink(path, {
                    onStep: (step, info) => stepActive(step, info),
                    onProgress: copyProgress,
                });
            } catch (e) {
                if (i18n.isAppError(e) && e.code === 'ERR_LINK_TARGET_MISSING') {
                    $('#tr-progress').classList.add('hidden');
                    const unlinkOk = await confirmBox(
                        'ui.links.confirmUnlinkTitle',
                        i18n.t('ui.links.confirmUnlinkText', { path }),
                    );
                    if (!unlinkOk) return;
                    resetProgress();
                    res = await symlinkManager.revertExternalLink(path, {
                        unlinkOnly: true,
                        onStep: (step, info) => stepActive(step, info),
                    });
                } else {
                    throw e;
                }
            }
        }
        stepDone('done');
        toast(i18n.t('ui.links.revertSuccess', { path }), 'ok');
        for (const w of (res.warnings ?? [])) toast(w, 'warn');
    } catch (e) {
        stepFail();
        showError(e);
    } finally {
        setBusy(false);
        renderLinks();
        renderHistory();
    }
}

/* ------------------------------------------------------------ вкладка «История» */

function dateLabel(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString(i18n.getLocale() === 'ru' ? 'ru-RU' : 'en-US');
}

function renderHistory() {
    history.list().then((entries) => {
        const list = $('#hi-list');
        list.innerHTML = '';
        $('#hi-empty').classList.toggle('hidden', entries.length > 0);

        for (const e of entries) {
            const row = document.createElement('div');
            row.className = 'hist-row';
            const statusClass = e.status === 'active' ? 'badge-ok' : (e.status === 'error' ? 'badge-block' : 'badge-dim');
            row.innerHTML = `
                <div class="hist-main">
                    <div class="hist-path" title="${esc(e.originalPath)}">${esc(e.originalPath)}</div>
                    <div class="hist-sub">→ ${esc(e.targetPath)}</div>
                    <div class="hist-meta">${esc(dateLabel(e.createdAt))} · ${esc(i18n.t(`ui.history.linktype.${e.linkType}`))} · ${esc(formatBytes(e.sizeBytes))}</div>
                </div>
                <span class="badge ${statusClass}">${esc(i18n.t(`ui.history.status.${e.status}`))}</span>
                <button class="btn btn-sm btn-accent" data-revert="${esc(e.id)}">${esc(i18n.t('ui.history.revertBtn'))}</button>
                <button class="btn btn-sm btn-subtle" data-open="${esc(e.originalPath)}">${esc(i18n.t('ui.history.openBtn'))}</button>
                <button class="btn btn-sm btn-danger" data-del="${esc(e.id)}">${esc(i18n.t('ui.history.deleteBtn'))}</button>`;
            list.appendChild(row);
        }
    }).catch(showError);
}

async function doRevert(id) {
    if (state.busy) return;
    const entry = await history.findById(id);
    if (!entry) { toast(i18n.t('ERR_NOT_IN_HISTORY', { path: id }), 'warn'); return; }

    const confirmed = await confirmBox(
        'ui.history.revertConfirmTitle',
        i18n.t('ui.history.revertConfirmText', { path: entry.originalPath }),
    );
    if (!confirmed) return;

    setBusy(true);
    resetProgress();
    try {
        await symlinkManager.revertLink(id, {
            onStep: (step, info) => stepActive(step, info),
            onProgress: copyProgress,
        });
        stepDone('done');
        toast(i18n.t('ui.history.revertSuccess', { path: entry.originalPath }), 'ok');
    } catch (e) {
        stepFail();
        showError(e);
    } finally {
        setBusy(false);
        renderHistory();
    }
}

async function doDelete(id) {
    if (state.busy) return;
    const entry = await history.findById(id);
    if (!entry) return;
    const confirmed = await confirmBox(
        'ui.history.deleteConfirmTitle',
        i18n.t('ui.history.deleteConfirmText', { path: entry.originalPath }),
    );
    if (!confirmed) return;
    await history.remove(id);
    renderHistory();
}

/* ------------------------------------------------------------ занятость */

function setBusy(busy) {
    state.busy = busy;
    document.body.classList.toggle('busy', busy);
}

/* ------------------------------------------------------------ инициализация */

function bind() {
    $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => showPage(btn.dataset.page)));
    $('#theme-toggle').addEventListener('click', toggleTheme);
    $('#lang-ru').addEventListener('click', () => setLang('ru'));
    $('#lang-en').addEventListener('click', () => setLang('en'));

    $('#tr-browse-src').addEventListener('click', async () => {
        try {
            const path = await Neutralino.os.showFolderDialog(i18n.t('ui.transfer.pickSource'));
            if (path) setTransferSource(path);
        } catch { /* диалог закрыт */ }
    });
    $('#tr-browse-dst').addEventListener('click', async () => {
        try {
            const path = await Neutralino.os.showFolderDialog(i18n.t('ui.transfer.pickTarget'));
            if (path) {
                $('#tr-target').value = path;
                store.set('target', path);
            }
        } catch { /* диалог закрыт */ }
    });
    $('#tr-target').value = store.get('target');
    $('#tr-target').addEventListener('input', () => store.set('target', $('#tr-target').value.trim()));
    $('#tr-move').addEventListener('click', onMoveClick);
    $$('input[name="linktype"]').forEach((r) => r.addEventListener('change', renderAdminHint));

    $('#sc-threshold').value = store.get('threshold', '500');
    $('#sc-target').value = store.get('scanTarget');
    $('#sc-target').addEventListener('input', () => store.set('scanTarget', $('#sc-target').value.trim()));
    $('#sc-scan').addEventListener('click', runScan);
    $('#sc-cancel').addEventListener('click', () => storageScanner.cancelScan());
    $('#sc-select-all').addEventListener('click', () => {
        $$('#sc-list input[data-scan]').forEach((cb) => {
            if (!cb.disabled) { cb.checked = true; syncSelection(cb); }
        });
    });
    $('#sc-clear-sel').addEventListener('click', () => {
        $$('#sc-list input[data-scan]').forEach((cb) => { cb.checked = false; syncSelection(cb); });
    });
    $('#sc-move-selected').addEventListener('click', runBulkMove);

    $('#lk-root').value = store.get('linksRoot', '%USERPROFILE%');
    $('#lk-root').addEventListener('input', () => store.set('linksRoot', $('#lk-root').value.trim()));
    $('#lk-show-system').checked = store.get('showSystemLinks', '0') === '1';
    $('#lk-show-system').addEventListener('change', () => {
        store.set('showSystemLinks', $('#lk-show-system').checked ? '1' : '0');
        renderLinks();
    });
    $('#lk-scan').addEventListener('click', runLinksScan);
    $('#lk-cancel').addEventListener('click', () => storageScanner.cancelExternalScan());
    $('#lk-list').addEventListener('click', (e) => {
        const revertBtn = e.target.closest('button[data-revert-ext]');
        const openBtn = e.target.closest('button[data-open]');
        if (revertBtn) doLinksRevert(revertBtn.dataset.revertExt, revertBtn.dataset.target);
        else if (openBtn) openInExplorer(openBtn.dataset.open);
    });

    // делегирование внутри списка сканера: чекбоксы и кнопка «на вкладку переноса»
    $('#sc-list').addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-scan]');
        if (cb) syncSelection(cb);
    });
    $('#sc-list').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-use]');
        if (!btn) return;
        setTransferSource(btn.dataset.use);
        showPage('transfer');
    });

    $('#hi-refresh').addEventListener('click', renderHistory);
    $('#hi-list').addEventListener('click', (e) => {
        const revertBtn = e.target.closest('button[data-revert]');
        const openBtn = e.target.closest('button[data-open]');
        const delBtn = e.target.closest('button[data-del]');
        if (revertBtn) doRevert(revertBtn.dataset.revert);
        else if (openBtn) openInExplorer(openBtn.dataset.open);
        else if (delBtn) doDelete(delBtn.dataset.del);
    });

    $('#admin-restart').addEventListener('click', async () => {
        try {
            await symlinkManager.restartAsAdmin();
        } catch (e) {
            showError(e);
        }
    });

    // Drag-and-Drop (emitDropEvents: true в neutralino.config.json)
    Neutralino.events.on('filesDropped', (evt) => {
        const detail = evt && evt.detail;
        const paths = Array.isArray(detail) ? detail
            : (detail && Array.isArray(detail.paths) ? detail.paths : []);
        if (!paths.length) return;
        setTransferSource(paths[0]);
        showPage('transfer');
        toast(i18n.t('ui.transfer.dropped', { path: paths[0] }), 'info');
    }).catch(() => { /* событие доступно только с emitDropEvents */ });
}

async function main() {
    initTheme();
    bind();

    await i18n.init(store.get('lang', (navigator.language || 'ru').toLowerCase().startsWith('en') ? 'en' : 'ru'));
    applyI18n();
    updateLangToggle();

    if (window.NL_OS !== 'Windows') $('#os-warning').classList.remove('hidden');

    showPage('transfer');
    refreshAdmin();
    renderHistory();
    updateBulkLabel();
}

Neutralino.init();
Neutralino.events.on('windowClose', () => Neutralino.app.exit());
main();
