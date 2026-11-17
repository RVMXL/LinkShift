/**
 * LinkShift — core/i18n.js
 *
 * Локализация RU/EN через JSON-словари (resources/locales/*.json)
 * и класс ошибок AppError: модули бросают код ошибки + параметры,
 * а текст подставляется из словаря текущего языка при обращении к .message.
 */

let currentLocale = 'ru';
const locales = new Map();

/** Загружает словарь и выставляет активный язык ('ru' | 'en'). */
export async function setLocale(locale) {
    const lang = String(locale || 'ru').toLowerCase();
    if (!locales.has(lang)) {
        const res = await fetch(`/locales/${lang}.json`);
        if (!res.ok) throw new Error(`i18n: locale "${lang}" not found`);
        locales.set(lang, await res.json());
    }
    currentLocale = lang;
}

export async function init(locale = 'ru') {
    await setLocale(locale);
}

export function getLocale() {
    return currentLocale;
}

/**
 * Перевод с подстановкой параметров: t('ERR_NO_FREE_SPACE', { need: '2.1 GB' }).
 * Если ключа нет в текущем словаре — падает на английский, затем на сам ключ.
 */
export function t(key, params = {}) {
    let text = locales.get(currentLocale)?.[key];
    if (text == null) text = locales.get('en')?.[key];
    if (text == null) return key;
    for (const [name, value] of Object.entries(params ?? {})) {
        text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
}

/**
 * Ошибка с кодом локализации. message всегда вычисляется заново из словаря,
 * поэтому после смены языка тексты уже показанных ошибок не «застывают».
 */
export class AppError extends Error {
    constructor(code, params = {}, cause = null) {
        super(code);
        this.name = 'AppError';
        this.code = code;
        this.params = params ?? {};
        this.cause = cause;
        // ВАЖНО: super(code) создаёт собственное свойство message с сырым
        // кодом ('ERR_INTERNAL'), а собственное свойство затеняет геттер
        // прототипа — e.message всегда возвращал голый код, и UI показывал
        // «ERR_INTERNAL: ERR_INTERNAL» вместо локализованного текста.
        // Переопределяем его собственным геттером с живой локализацией.
        Object.defineProperty(this, 'message', {
            get: () => t(this.code, this.params),
            enumerable: true,
            configurable: true,
        });
    }

    toJSON() {
        return { error: true, code: this.code, params: this.params, message: this.message };
    }
}

export function isAppError(e) {
    return e instanceof AppError;
}

/** Единый формат ошибки для логов/UI. */
export function toErrorPayload(e) {
    if (e instanceof AppError) return e.toJSON();
    return {
        error: true,
        code: 'ERR_INTERNAL',
        message: String((e && e.message) || e),
    };
}
