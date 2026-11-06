/**
 * Selección de casos por IDs entre páginas y rutas (ESP §17.1 "UI transversal no remota" → TanStack Store).
 * Solo IDs (UUID) y el ámbito de filtro en que se hicieron; nunca copias de entidades. Se limpia al cambiar de
 * ámbito/identidad y en logout.
 */
import { createStore } from '@tanstack/react-store';

export interface SelectionState {
  ids: ReadonlySet<string>;
  /** Clave del filtro/ámbito donde se seleccionó (cambiar filtro limpia tras advertencia). */
  scopeKey: string | null;
}

export const caseSelectionStore = createStore<SelectionState>({ ids: new Set<string>(), scopeKey: null });
/** = MAX_EXPLICIT_CASES de @katalyst/shared (500; verificado en test para no arrastrar los esquemas al chunk inicial). */
export const SELECTION_LIMIT = 500;

export const selection = {
  toggle(id: string, on?: boolean): boolean {
    let accepted = true;
    caseSelectionStore.setState((s) => {
      const next = new Set(s.ids);
      const want = on ?? !next.has(id);
      if (want) {
        if (!next.has(id) && next.size >= SELECTION_LIMIT) {
          accepted = false;
          return s;
        }
        next.add(id);
      } else next.delete(id);
      return { ...s, ids: next };
    });
    return accepted;
  },
  setMany(ids: readonly string[], on: boolean): number {
    let rejected = 0;
    caseSelectionStore.setState((s) => {
      const next = new Set(s.ids);
      for (const id of ids) {
        if (on) {
          if (next.has(id)) continue;
          if (next.size >= SELECTION_LIMIT) {
            rejected++;
            continue;
          }
          next.add(id);
        } else next.delete(id);
      }
      return { ...s, ids: next };
    });
    return rejected;
  },
  replace(ids: readonly string[], scopeKey: string | null = null): void {
    caseSelectionStore.setState(() => ({ ids: new Set(ids.slice(0, SELECTION_LIMIT)), scopeKey }));
  },
  setScope(scopeKey: string): void {
    caseSelectionStore.setState((s) => ({ ...s, scopeKey }));
  },
  clear(): void {
    caseSelectionStore.setState(() => ({ ids: new Set<string>(), scopeKey: null }));
  },
  get(): string[] {
    return [...caseSelectionStore.state.ids];
  },
};
