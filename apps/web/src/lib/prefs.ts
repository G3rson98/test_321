/**
 * Preferencias NO sensibles en localStorage (ESP §17.1/§17.3): solo visibilidad/tamaño de columnas por módulo.
 * Nunca filtros de personas, contenido de celdas, tokens ni caché autenticada.
 */
export interface ColumnPrefs {
  visibility?: Record<string, boolean>;
  sizing?: Record<string, number>;
}

const PREFIX = 'katalyst.cols.';

export function loadColumnPrefs(key: string): ColumnPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ColumnPrefs;
    const clean: ColumnPrefs = {};
    if (parsed.visibility && typeof parsed.visibility === 'object') {
      clean.visibility = Object.fromEntries(
        Object.entries(parsed.visibility).filter(([, v]) => typeof v === 'boolean'),
      );
    }
    if (parsed.sizing && typeof parsed.sizing === 'object') {
      clean.sizing = Object.fromEntries(
        Object.entries(parsed.sizing).filter(([, v]) => typeof v === 'number' && v > 20 && v < 2000),
      );
    }
    return clean;
  } catch {
    return {};
  }
}

export function saveColumnPrefs(key: string, prefs: ColumnPrefs): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(prefs));
  } catch {
    /* cuota o modo privado: ignorar */
  }
}

/** Logout: las preferencias de columnas se conservan (no sensibles); se elimina cualquier otra clave propia. */
export function clearSensitiveStorage(): void {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    for (let i = ls.length - 1; i >= 0; i--) {
      const k = ls.key(i);
      if (k && k.startsWith('katalyst.') && !k.startsWith(PREFIX)) ls.removeItem(k);
    }
    globalThis.sessionStorage?.clear();
  } catch {
    /* ignorar */
  }
}
