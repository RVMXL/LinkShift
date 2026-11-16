/**
 * LinkShift — core/fsinfo.js
 *
 * Обертки над PowerShell-скриптами для сведений о файлах и дисках:
 * размер дерева, свободное место, тип и цель ссылки (reparse point).
 */

import { runScript } from './ps.js';

/**
 * Размер и статистика дерева каталога.
 * @returns {Promise<{ok:boolean, exists:boolean, isReparsePoint:boolean,
 *   bytes:number, files:number, dirs:number, reparseDirs:number, accessErrors:number}>}
 */
export async function measureDirectorySize(path) {
    return runScript('measure-dir', [path]);
}

/**
 * Свободное/общее место на диске, содержащем путь.
 * @returns {Promise<{ok:boolean, drive:string, freeBytes:number, totalBytes:number}>}
 */
export async function getDriveSpace(path) {
    return runScript('drive-space', [path]);
}

/**
 * Информация о пути: существует ли, является ли ссылкой (junction/symlink).
 * @returns {Promise<{ok:boolean, exists:boolean, isDirectory:boolean,
 *   isReparsePoint:boolean, linkType:string|null, linkTarget:string|null}>}
 */
export async function getLinkInfo(path) {
    return runScript('link-info', [path]);
}

/** Проверка «это уже символическая ссылка / junction?» */
export async function isReparsePoint(path) {
    const info = await getLinkInfo(path);
    return Boolean(info.exists && info.isReparsePoint);
}
