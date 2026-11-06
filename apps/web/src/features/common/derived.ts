/**
 * Datos que el panel obtiene o deriva de endpoints existentes (sin inventar contratos). Los pendientes [WEB→API-A]
 * de resumen de caso y selección por ID están resueltos en servidor (D-054).
 */
import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { catalogApi } from '@/lib/api/endpoints';
import type { CaseRow, FlakyInfo, Section } from '@/lib/api/types';
import type { Classification } from '@katalyst/shared/enums';
import { qk } from '@/lib/query/keys';

/** Etiquetas iniciales mientras carga el listado de tests. */
export const DEFAULT_TAGS = ['@humo', '@oc', '@agendamiento', '@arranque', '@rendimiento'];

export interface CaseAutomation {
  tags: string[];
  classification: Classification | null;
  flaky: FlakyInfo | null;
}

/**
 * Etiquetas, clasificación e inestabilidad por caso: el servidor ya las entrega agregadas en el resumen de caso
 * (`GET /testrail/cases`, D-054), sin consultar `/tests?caseId=` por fila.
 */
export function useCaseAutomation(rows: readonly CaseRow[] | undefined): Map<string, CaseAutomation> {
  return useMemo(
    () => new Map((rows ?? []).map((r) => [r.id, { tags: r.tags ?? [], classification: r.classification ?? null, flaky: r.flaky ?? null }])),
    [rows],
  );
}

/** Etiquetas conocidas: unión de las de los tests vigentes (primera página, orden por título) y las iniciales. */
export function useKnownTags(): string[] {
  const q = useQuery({
    queryKey: qk.catalog.tags(),
    queryFn: ({ signal }) => catalogApi.tests({ status: 'aprobado', limit: 100 }, signal),
    staleTime: 5 * 60_000,
  });
  const fromTests = q.data?.items.flatMap((t) => t.tags) ?? [];
  return [...new Set([...DEFAULT_TAGS, ...fromTests])].sort();
}

/** Nombre de sección por ID (las secciones llegan en `GET /testrail/sections`). */
export function sectionNameMap(sections: readonly Section[] | undefined): Map<string, string> {
  return new Map((sections ?? []).map((s) => [s.id, s.name]));
}

/**
 * Casos por ID para selecciones traídas del catálogo: una sola consulta `GET /testrail/cases?ids=` (máximo `max`,
 * D-054).
 */
export function useCasesByIds(ids: readonly string[], max = 100) {
  const wanted = useMemo(() => [...new Set(ids)].slice(0, max).sort(), [ids, max]);
  const q = useQuery({
    queryKey: qk.catalog.cases({ ids: wanted, limit: max }),
    queryFn: ({ signal }) => catalogApi.cases({ ids: wanted, limit: max, includeArchived: true }, signal),
    enabled: wanted.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  return useMemo(() => new Map<string, CaseRow>((q.data?.items ?? []).map((c) => [c.id, c])), [q.data]);
}
