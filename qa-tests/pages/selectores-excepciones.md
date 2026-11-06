# Excepciones controladas de selectores — versión 1

Registro versionado de las clases CSS **públicas** de MUI / Inovua DataGrid que los Page Objects usan como excepción a
la regla 2 de la ESP §10 (orden `getByTestId` → `getByRole` → `getByLabel` → `getByText`; prohibidas clases generadas
como `css-2etuwl` y XPath por posición). Fundamento: ESP §10 reglas 7 y 12.

Reglas de uso:

- Solo `pages/inovua.ts` y los Page Objects de `pages/` consumen estos selectores. Ningún archivo de `tests/` los usa
  directamente.
- Cada cambio de esta tabla incrementa la versión del documento y la constante `SELECTOR_EXCEPTIONS_VERSION` de
  `pages/inovua.ts` en el mismo PR (revisión de desarrollador, ESP §13.1).
- No se eliminan automáticamente (tampoco en bloque 3, revisión asistida por IA). Se sustituyen por `data-testid`
  cuando el frontend de FMS DeltaX los provea (regla 8), registrando el reemplazo aquí.
- "Versión observada" se completa en Bloque 0 con la versión de frontend de DeltaX y de `@inovua/reactdatagrid-*` /
  `@mui/material` en la que se verificó cada clase.

| ID | Selector | Librería | Uso | Archivo | Versión observada | Reemplazo `data-testid` solicitado |
| --- | --- | --- | --- | --- | --- | --- |
| E-01 | `.InovuaReactDataGrid` | Inovua DataGrid | Raíz de la grilla de cada pantalla | `pages/inovua.ts` (`inovuaGrid`) | Pendiente Bloque 0 | `loadorder-grid`, `warehouses-grid`, `schedulings-grid` |
| E-02 | `.InovuaReactDataGrid__row` | Inovua DataGrid | Filas de datos (regla 7) | `pages/inovua.ts` | Pendiente Bloque 0 | `*-grid-row` |
| E-03 | `.InovuaReactDataGrid__load-mask--visible` | Inovua DataGrid | Máscara de carga visible (regla 7) | `pages/inovua.ts` | Pendiente Bloque 0 | `*-grid-loading` |
| E-04 | `.InovuaReactDataGrid__empty-wrapper` | Inovua DataGrid | Estado vacío explícito (regla 11) | `pages/inovua.ts` | Pendiente Bloque 0: confirmar que DeltaX no reemplaza el `emptyText` por otro componente | `*-grid-empty` |
| E-05 | `.MuiSkeleton-root` | MUI | Loader tipo skeleton (regla 7) | `pages/inovua.ts`, `pages/ControlCenterPage.ts` | Pendiente Bloque 0 | `page-loading` |
| E-06 | `.MuiCircularProgress-root` | MUI | Loader circular (regla 7) | `pages/inovua.ts`, `pages/ControlCenterPage.ts` | Pendiente Bloque 0 | `page-loading` |

Pedido al frontend (regla 8), además de las grillas: `data-testid` en las pestañas de Órdenes de carga
(`loadorder-tab-catering`, `loadorder-tab-direct`, `loadorder-tab-distribution`), en los botones de vista de
Agendamientos (`schedulings-view-list`, `schedulings-view-calendar`), en el contenedor del calendario
(`schedulings-calendar`) y en los filtros de las pantallas cubiertas.

## Historial

| Versión | Fecha | Cambio |
| --- | --- | --- |
| 1 | 2026-11-06 | Alta inicial E-01..E-06 (ESP §10 reglas 7, 11 y 12). |
