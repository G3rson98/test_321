# Análisis de UI — capturas de Katalyst (DeltaX QA Runner)

Documento de referencia visual para el panel `apps/web` (React 19 + Vite + TanStack Router/Query/Table/Form + Tailwind v4 +
shadcn/ui + Lucide; **sin MUI**). Fuente: las 26 capturas de
`Especificación_Requerimientos/screens/capturas/*.png` (1600 × 1100 px, escala 1:1) contrastadas con la ESP
(`Especificación_Requerimientos/Especificación_Requerimientos.md`, secciones 1, 3, 5, 6, 9, 11, 13 y 17) y con
`docs/plan-implementacion.md`.

> Regla de lectura (ESP §17): las capturas definen **apariencia y mapa de pantallas**; la ESP define comportamiento. Los
> datos de ejemplo de los mockups (conteos, workers, duraciones, commits) **no son requisitos**. La ausencia en el mockup de
> estados vacío/error/carga/sin permiso **no autoriza a omitirlos**. No confundir MUI/Inovua de la app DeltaX bajo prueba
> con el stack del panel.

Los colores hex se obtuvieron muestreando píxeles de las capturas (valores exactos del render, redondeables). Las medidas
en px corresponden a la captura a 1:1.

---

## 1. Sistema visual global

### 1.1 Paleta de colores (muestreada)

| Rol | Hex | Dónde aparece |
| --- | --- | --- |
| **Ink / fondo oscuro** | `#151623` | Sidebar, panel izquierdo del login, visor de código, bloque cron, texto principal (títulos, celdas), texto sobre botón primario |
| Fondo de página | `#F6F7F8` | Área de contenido, fondo de botones secundarios/outline, fondo de diálogo, pestaña activa de tabs |
| Superficie (card) | `#FFFFFF` | Cards, tablas, topbar, inputs de formularios |
| Superficie atenuada (muted) | `#EDEDEF` | Fondo de chips de etiqueta, contenedor de tabs, badges neutros, ítem de sección activo en catálogo, recuadro de pasos de grabación, track de barra de progreso, grid del gráfico |
| Borde | `#DADADE` | Bordes de cards, tablas (separadores de fila), inputs, botones outline, toggles apagados, línea inferior del topbar |
| Borde del sidebar | `#313140` | Separador superior del bloque de usuario en el sidebar |
| **Primario (naranja DeltaX)** | `#EA9300` | Botón primario, ítem activo del sidebar (texto+icono), IDs `R-xxxx` / `Cxxxx`, enlaces "Ver todas"/"Gestionar", barra de selección, checkboxes, toggles encendidos, segmented activo, días activos, barra de progreso, texto del cron |
| Naranja del logo | `#ED9405` | "DELTA" del logotipo (casi idéntico al primario) |
| Primario tenue (ring) | `#F8DEB2` | Anillo de 2 px alrededor de la tarjeta seleccionada (≈ primario al 30 %) |
| Primario soft (fondo) | `#FFEED4` | Fondo del botón "Grabar" resaltado (07/08) y viñetas de "Próximas 5 ejecuciones" |
| Texto sobre primario soft | `#663800` | Texto del botón "Grabar" resaltado |
| Sidebar: ítem activo (fondo) | `#2A231F` | ≈ primario 10–12 % sobre ink |
| Sidebar: texto/icono inactivo | `#B4B5BC` | Ítems de navegación |
| Sidebar: texto usuario | `#EAEBEF` | Nombre "Ana Rojas" e iniciales del avatar |
| Sidebar: avatar (fondo) | `#262737` | Círculo de iniciales "AR" |
| Sidebar: rol / "KATALYST" | `#95969D` / `#83848C` | "QA" bajo el nombre; texto de marca |
| Texto secundario (muted-foreground) | `#5C5D67` | Subtítulos, encabezados de tabla, etiquetas de KPI, metadatos de fila |
| Placeholder | `#8A8A91` | "Buscar casos, ejecuciones..." |
| Iconos de acción en filas | `#84858C` | ExternalLink en evidencias |
| Ejes del gráfico | `#AEAEB3` | Ejes/ticks de Recharts |
| Texto claro sobre ink | `#EAEBEF` | Código en visor, titular blanco del login |
| Texto secundario sobre ink | `#AAABB2` | Bajada del login |

**Estados (texto / fondo de badge)**

| Estado UI | Texto | Fondo badge | Otros |
| --- | --- | --- | --- |
| Pasado / Publicado / Entregado / Automatizado / KPI positivo | `#25984D` | `#DFF0E4` | Punto "TestRail sincronizado"; barras verdes del historial; línea `current` |
| Fallido / Error / Alertas / KPI negativo | `#DB2C2B` | `#FAE0DF` | Banner de alerta `#F3E1E2` con borde `#EBAAAA`; recuadro de error de test y callout "bloqueado" `#FBE9E9`; botón destructivo `#DB2C2B` con texto `#F9F8F5`; punto de notificación; línea Agendamientos |
| Inestable / Pendiente / Requiere revisión / advertencias | `#3E2104` (marrón oscuro) | `#FBE9CB` | KPI "Errores HTTP 3" y "Casos cambiados 3" en `#3E2104`; "⚠ Requiere revisión" en catálogo |
| En curso (Corriendo) | `#1A89C5` | `#DDEDF6` | Punto `•` antes del texto; línea vertical "Despliegue" `#83BBDA` con etiqueta `#1A89C5` |
| Neutro fuerte (No aplica) | `#151623` | `#EDEDEF` | — |
| Neutro atenuado (Sin ejecutar, Cancelado, Sin test) | `#5C5D67` | `#EDEDEF` | "○ Sin test" en texto muted |
| **Bloqueado** (no aparece como badge en mockups) | propuesta `#6B3FA0` | propuesta `#EFE7F8` | En 13 sólo aparece como callout rojo "1 bloqueado en producción". La ESP separa `bloqueado` de `fallido` (§13.2/§13.4): **no reutilizar el rojo** del fallido en badges; ver tokens |
| **Omitido** (sólo aparece como contador "0–") | `#5C5D67` | `#EDEDEF` | Mismo tratamiento que neutro atenuado + icono `MinusCircle` |
| En cola / Preparando / Finalizando / Cancelando | propuesta `#5C5D67` | `#FFFFFF` con borde `#DADADE` | No se muestran; variante outline neutra con icono `Clock`/`Loader2` |
| Interrumpida / Error de infraestructura | propuesta `#B4232C` | `#FAE0DF` + borde punteado | No se muestran; distinguir de falla de aplicación (§13.2) con icono `ServerCrash` |

### 1.2 Tipografía

- **Sans (UI)**: aparenta ser **Inter** (formas de `a`, `g`, `ñ`, `ó`). Títulos de página en Inter Bold (700) con
  *tracking* negativo marcado (≈ `-0.03em`), estilo "Inter Display/Tight".
- **Mono (datos/etiquetas)**: **JetBrains Mono** (asterisco característico y ligadura `=>` → `⇒` visible en el visor de
  código). Se usa para: encabezados de tabla, etiquetas de KPI, badges, chips de etiquetas `@tag`, IDs (`R-2481`,
  `C1201`, `OB-552`, `P-01`), horas/fechas compactas (`06 nov 08:00`), duraciones (`1m 12s`), commits, URLs de
  ambientes, cron, nombres de usuarios de prueba, contadores `2✓ 0✗ 0–`, chip de estado de TestRail, "KATALYST".

| Uso | Familia | Tamaño | Peso | Extra |
| --- | --- | --- | --- | --- |
| Título de página (H1) | Inter | 30 px (≈ `text-3xl`) | 700 | `tracking-[-0.03em]`, ink |
| Subtítulo de página | Inter | 15 px | 400 | muted `#5C5D67` |
| Titular login | Inter | 48 px | 800 | 2 líneas: blanco `#EAEBEF` + naranja `#EA9300`, tracking negativo |
| Título de card | Inter | 15 px | 600 | `tracking-tight` |
| Título de tarjeta de suite / nombre de programación | Inter | 18 px / 15 px | 600 / 500 | — |
| Texto de cuerpo / celdas | Inter | 15 px | 400 | ink |
| Texto secundario en fila (2.ª línea) | Inter | 13 px | 400 | muted |
| Etiqueta de campo | Inter | 15 px | 500 | ink |
| Encabezado de tabla | JetBrains Mono | 10.5–11 px | 500 | MAYÚSCULAS, `tracking-[0.1em]`, muted |
| Etiqueta de KPI / sección ("SECCIÓN", "ETIQUETA", "EXPRESIÓN CRON", "AVISAR CUANDO") | JetBrains Mono | 10.5–11 px | 400 | MAYÚSCULAS, `tracking-[0.15em]`, muted |
| Valor de KPI | Inter | 32 px | 700 | color según semántica |
| Badge de estado | JetBrains Mono | 10.5 px | 600 | MAYÚSCULAS, `tracking-[0.06em]` |
| Chip de etiqueta `@tag` | JetBrains Mono | 11 px (tabla) / 12.5 px (filtro lateral) | 400 | minúsculas |
| IDs enlazables | JetBrains Mono | 14 px | 500 | naranja primario |
| Código | JetBrains Mono | 12.5 px | 400 | `line-height` ≈ 19.5 px, ligaduras activas |
| Marca "KATALYST" | JetBrains Mono | 10 px | 500 | `tracking-[0.25em]` |

### 1.3 Radios, sombras, espaciado y densidad

- **Radios**: cards/tablas/diálogos/banners ≈ **8 px** (`rounded-lg`); botones, inputs, selects, segmented ≈ **6 px**
  (`rounded-md`); chips de etiqueta y botones numéricos de reintentos ≈ **4 px** (`rounded-sm`); badges de estado,
  toggles, chip de TestRail del topbar y días de la semana: **pill/círculo** (`rounded-full`).
- **Sombras**: cards **sin sombra** (sólo borde 1 px `#DADADE`). Botones (primario y outline) con `shadow-xs` sutil
  (degradado de 3 px bajo el borde). Diálogo sobre overlay **negro al 80 %** (`bg-black/80`). Pestaña activa de tabs con
  sombra mínima.
- **Espaciado**: sidebar 240 px fijo; contenido con padding horizontal **32 px** (x 272 → 1568); topbar 62 px + borde;
  cabecera de página: título en y≈98, subtítulo y≈145, acciones alineadas a la derecha centradas verticalmente con el
  bloque título; separación cabecera→contenido 32 px; separación entre cards **16 px** (KPIs) / **24 px** (bloques);
  padding interno de card 20 px; cabecera de card 44–46 px con borde inferior.
- **Densidad de tablas**: "cómoda". Encabezado ≈ 37 px; fila de dos líneas ≈ 61 px; fila de una línea ≈ 45–48 px;
  padding horizontal de celda 20 px; separadores horizontales `#DADADE`, sin bandas alternas, sin bordes verticales.
  Configuración usa filas de 45–54 px.
- **Grid de KPIs**: 4 columnas iguales (gap 16 px), alto ≈ 122 px; 5 columnas en detalle de ejecución (alto ≈ 100 px).

### 1.4 Badges y chips

- **StatusBadge** (pill): alto 18–20 px, padding-x 9–10 px, mono 10.5 px 600 mayúsculas, fondo tenue + texto saturado
  (tabla 1.1). "CORRIENDO" lleva punto `•` de 6 px a la izquierda (sugerido: `animate-pulse`).
- **TagChip** (`@humo`, `@oc`…): rectángulo `rounded-sm`, alto 20 px, fondo `#EDEDEF`, borde `#DADADE`, mono 11 px,
  texto muted. En el filtro lateral del catálogo: fondo blanco, borde, mono 12.5 px ink, alto 26 px (clicables).
- **Inline status** (catálogo, columna Automatización): texto sin fondo: "● Automatizado" verde, "⚠ Requiere revisión"
  marrón `#3E2104`, "○ Sin test" muted; segunda línea "Inestable" en marrón.
- **Chip de cabecera de caso** "Requiere revisión: cambiaron los pasos en TestRail": pill fondo `#FBE9CB`, texto
  `#3E2104` 12.5 px 600 (no mono).
- **"Solo lectura"** (ambiente producción): `rounded-sm`, fondo `#FAE0DF`, texto `#DB2C2B` 12.5 px 500.
- **Contadores de resultado** `2✓ 0✗ 0–`: mono 12 px; `✓` verde, `✗` rojo, `–` muted; en Ejecuciones se añade `/ 4`.

### 1.5 Botones

| Variante | Aspecto | Ejemplos literales |
| --- | --- | --- |
| **Primario** | Fondo `#EA9300`, texto ink `#151623` 15 px 500, icono 16 px a la izquierda, alto 36 px (cabecera) / 32 px (cards) / 36 px ancho completo (paneles), `rounded-md`, `shadow-xs` | "Nueva ejecución", "Ejecutar", "Ejecutar ahora", "Nueva suite", "Nueva programación", "Guardar programación", "Sincronizar ahora", "Guardar", "Agregar", "Invitar", "Enviar PR", "Ingresar" |
| **Secundario / outline** | Fondo `#F6F7F8` (o blanco dentro de cards), borde `#DADADE`, texto ink, `shadow-xs` | "Sincronizar", "Exportar CSV", "Generar con IA", "Repetir fallidos", "Programar", "Probar conexión", "Reintentar", "Agregar verificación", "Detener", "Continuar con SSO de la empresa" |
| **Destructivo** | Fondo `#DB2C2B`, texto casi blanco, icono `CircleX` | "Cancelar" (ejecución en curso) |
| **Ghost** | Sin fondo ni borde, texto ink 15 px | "← Catálogo", "← Ejecuciones", "Cancelar" (formularios), "Descartar" (diálogo) |
| **Soft-warning (resaltado)** | Fondo `#FFEED4`, texto `#663800`, punto rojo `#DB2C2B` 14 px | "Grabar" en casos sin test o que requieren revisión (07, 08). En 05 es outline normal con punto rojo |
| **Sobre barra naranja** | "Programar": fondo `#EAEAED`, texto ink; "Ejecutar": mismo naranja con borde/sombra sutil y texto ink 600 | Barra de selección del catálogo (04) |
| **Icon button** | 16–18 px, color ink/muted, sin fondo | Pausar/Reanudar/Duplicar/Borrar en programaciones; campana; cerrar diálogo; cerrar sesión |
| **Link de card** | Texto naranja 13 px 500, sin subrayado | "Ver todas", "Gestionar" |
| **Link en banner** | Texto ink 600 subrayado | "Ver rendimiento" |

### 1.6 Inputs y controles

- **Input**: alto 36 px, `rounded-md`, borde `#DADADE`, fondo blanco (en el login el fondo coincide con la página
  `#F6F7F8`), texto 15 px ink, padding-x 12 px, placeholder `#8A8A91`. Etiqueta encima (15 px 500, gap 6–8 px).
- **Select**: en los mockups son **selects nativos** (chevron del navegador). Implementar con `Select` de shadcn
  manteniendo alto/borde.
- **Time input**: los mockups muestran el control nativo en formato 12 h (`08:00 AM`, `06:00 PM`, icono reloj). El panel
  debe mostrar **24 h** (`08:00`, `18:00`) según RNF-USA-01 (zona America/La_Paz); usar input propio con icono `Clock`.
- **Checkbox**: 16 px, `rounded-[4px]`, **borde naranja** incluso sin marcar; marcado: relleno `#EA9300` con check ink;
  deshabilitado: borde `#F4C87E` (naranja al 50 %).
- **Toggle (Switch)**: track 36 × 20 px, encendido `#EA9300`, apagado `#DADADE`, perilla `#F6F7F8`/blanca 16 px.
- **Segmented control** (pseudo-tabs de opción única): contenedor con borde `#DADADE` y padding 4 px; opción activa
  fondo `#EA9300` texto ink `rounded-sm`; inactiva texto ink sin fondo. Usos: "Suite guardada | Casos / etiquetas",
  "Hora fija | Rango con intervalo", "Hoy | 7 días | 30 días" (este último sobre fondo de página).
- **Selector numérico** (Reintentos ante falla): 3 cuadros 48 × 40 px mono 15 px, `rounded-sm`, activo naranja.
- **Day picker**: 7 círculos de 40 px con letra mono (L M X J V S D); activo naranja relleno con letra ink; inactivo
  blanco con borde.
- **Radio-card**: tarjeta seleccionable (suites y ambientes en Nueva ejecución). Normal: borde `#DADADE`; seleccionada:
  borde `#EA9300` 1 px + `ring-2` `#F8DEB2`.

### 1.7 Tabs

Tabs de Configuración (shadcn `Tabs`): lista con fondo `#EDEDEF`, `rounded-lg`, padding 4 px; disparador activo con fondo
`#F6F7F8`/blanco, texto ink 500, `shadow-xs`, `rounded-md`; inactivos texto `#5C5D67` 15 px. Cada pestaña debe ser una
**ruta** (no estado local) para cumplir ESP §17.1 (navegación compartible).

### 1.8 Logo y marca

- Logotipo **"DELTA" + "X"**: "DELTA" en sans condensada extra bold, naranja `#ED9405`; la "X" combina un trazo
  gris-plateado metálico (degradado claro) y un *swoosh* naranja que sube hacia la derecha. Tamaño en sidebar ≈ 142 × 34 px
  (x 24, y 26); en login ≈ 190 × 46 px.
- Debajo: **"KATALYST"** en JetBrains Mono 10 px, espaciado amplio (`0.25em`), gris `#83848C`.
- El nombre del producto mostrado al usuario es **Katalyst**; "DeltaX QA Runner" no aparece en la UI.
- Implementación: SVG local optimizado (`/src/assets/deltax-logo.svg`), sin raster (ESP §17.4 "logo local optimizado").
- Login, pie del panel izquierdo: "Playwright · TestRail · DXMon" (mono 12 px muted sobre ink).

### 1.9 Iconografía (Lucide sugerido)

| Uso | Icono Lucide |
| --- | --- |
| Inicio | `LayoutDashboard` |
| Catálogo | `ListChecks` |
| Suites | `Layers` |
| Ejecuciones | `CirclePlay` |
| Programaciones | `CalendarClock` |
| Rendimiento | `Gauge` |
| TestRail | `RefreshCw` (flechas circulares) |
| Auditoría | `ScrollText` |
| Configuración | `Settings` |
| Búsqueda global | `Search` |
| Notificaciones | `Bell` (+ punto rojo) |
| Cerrar sesión | `LogOut` |
| Ejecutar / Nueva ejecución / Ejecutar ahora | `Play` |
| Programar (barra de selección) | `CalendarClock` |
| Sincronizar / Sincronizar ahora | `RefreshCw` |
| Exportar CSV | `Download` |
| Nueva suite / programación, Agregar, Invitar | `Plus` |
| Volver ("← Catálogo") | `ArrowLeft` |
| Generar con IA | `Sparkles` (o `WandSparkles`) |
| Grabar | círculo rojo relleno (`Circle` con `fill`) |
| Cancelar ejecución | `CircleX` |
| Repetir fallidos / Reintentar | `RotateCcw` |
| Probar conexión | `CircleCheck` |
| Descartar | `Trash2` |
| Agregar verificación | `SquareCheck` |
| Detener | `Square` |
| Enviar PR | `GitPullRequest` |
| Cerrar diálogo | `X` |
| Pausar / Reanudar / Duplicar / Borrar programación | `Pause` / `CirclePlay` / `Copy` / `Trash2` |
| Alerta (banner) | `TriangleAlert` |
| Bloqueado en producción | `ShieldAlert` |
| Evidencia: video / traza / captura / reporte HTML | `Film` / `FileText` / `Image` / `FileText` (o `FileCode2`) |
| Abrir evidencia | `ExternalLink` |
| Metadato de horario en tarjetas de suite | `CalendarClock` (12 px) |
| Hora en inputs | `Clock` |

Importar iconos individualmente (tree-shaking), nunca el paquete completo (ESP §17.4).

### 1.10 Tokens propuestos (Tailwind v4 + shadcn/ui)

```css
/* apps/web/src/styles/globals.css */
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *)); /* el mockup sólo define tema claro con sidebar oscuro */

:root {
  /* Base shadcn */
  --background: #f6f7f8;
  --foreground: #151623;
  --card: #ffffff;
  --card-foreground: #151623;
  --popover: #ffffff;
  --popover-foreground: #151623;
  --primary: #ea9300;
  --primary-foreground: #151623;
  --secondary: #f6f7f8;            /* botón outline/secundario */
  --secondary-foreground: #151623;
  --muted: #ededef;
  --muted-foreground: #5c5d67;
  --accent: #ededef;
  --accent-foreground: #151623;
  --destructive: #db2c2b;
  --destructive-foreground: #f9f8f5;
  --border: #dadade;
  --input: #dadade;
  --ring: #ea9300;
  --radius: 0.5rem;                /* 8 px cards; md = 6 px; sm = 4 px */

  /* Marca */
  --brand-ink: #151623;
  --brand-orange: #ea9300;
  --brand-orange-logo: #ed9405;
  --primary-soft: #ffeed4;
  --primary-soft-foreground: #663800;
  --primary-ring: #f8deb2;
  --placeholder: #8a8a91;

  /* Sidebar */
  --sidebar: #151623;
  --sidebar-foreground: #b4b5bc;
  --sidebar-primary: #ea9300;
  --sidebar-primary-foreground: #151623;
  --sidebar-accent: #2a231f;       /* ítem activo: naranja ~11 % sobre ink */
  --sidebar-accent-foreground: #ea9300;
  --sidebar-border: #313140;
  --sidebar-ring: #ea9300;
  --sidebar-user: #eaebef;
  --sidebar-user-muted: #95969d;
  --sidebar-avatar: #262737;

  /* Estados (texto / fondo) */
  --status-passed: #25984d;      --status-passed-bg: #dff0e4;
  --status-failed: #db2c2b;      --status-failed-bg: #fae0df;
  --status-failed-soft: #fbe9e9; /* recuadros de error y callout de bloqueo */
  --status-alert-bg: #f3e1e2;    --status-alert-border: #ebaaaa;
  --status-flaky: #3e2104;       --status-flaky-bg: #fbe9cb;   /* inestable, pendiente, requiere revisión */
  --status-running: #1a89c5;     --status-running-bg: #ddedf6;
  --status-blocked: #6b3fa0;     --status-blocked-bg: #efe7f8; /* propuesta: no aparece en mockups */
  --status-skipped: #5c5d67;     --status-skipped-bg: #ededef; /* omitido, cancelado, sin ejecutar */
  --status-neutral: #151623;     --status-neutral-bg: #ededef; /* no aplica */
  --status-infra: #b4232c;       /* interrumpida / error_infraestructura (borde punteado) */

  /* Gráficos (Recharts) */
  --chart-1: #db2c2b;  /* Agendamientos lista */
  --chart-2: #ea9300;  /* Órdenes de carga */
  --chart-3: #25984d;  /* current */
  --chart-4: #1a89c5;  /* marcas de evento / despliegues */
  --chart-5: #6b3fa0;
  --chart-grid: #ededef;
  --chart-axis: #aeaeb3;
  --chart-threshold: #e25757;
  --chart-event: #83bbda;

  /* Código */
  --code-bg: #151623;
  --code-fg: #eaebef;
  --code-accent: #ea9300;
}

@theme inline {
  --font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary-soft: var(--primary-soft);
  --color-primary-soft-foreground: var(--primary-soft-foreground);
  --color-primary-ring: var(--primary-ring);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-placeholder: var(--placeholder);
  --color-brand-ink: var(--brand-ink);
  --color-brand-orange: var(--brand-orange);

  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --color-passed: var(--status-passed);       --color-passed-bg: var(--status-passed-bg);
  --color-failed: var(--status-failed);       --color-failed-bg: var(--status-failed-bg);
  --color-failed-soft: var(--status-failed-soft);
  --color-alert-bg: var(--status-alert-bg);   --color-alert-border: var(--status-alert-border);
  --color-flaky: var(--status-flaky);         --color-flaky-bg: var(--status-flaky-bg);
  --color-running: var(--status-running);     --color-running-bg: var(--status-running-bg);
  --color-blocked: var(--status-blocked);     --color-blocked-bg: var(--status-blocked-bg);
  --color-skipped: var(--status-skipped);     --color-skipped-bg: var(--status-skipped-bg);
  --color-neutral: var(--status-neutral);     --color-neutral-bg: var(--status-neutral-bg);
  --color-infra: var(--status-infra);

  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-code-bg: var(--code-bg);
  --color-code-fg: var(--code-fg);

  --radius-sm: calc(var(--radius) - 4px); /* 4 px */
  --radius-md: calc(var(--radius) - 2px); /* 6 px */
  --radius-lg: var(--radius);             /* 8 px */
  --radius-xl: calc(var(--radius) + 4px);

  --text-page-title: 1.875rem;            /* 30 px */
  --text-page-title--line-height: 2.25rem;
  --text-page-title--letter-spacing: -0.03em;
  --text-kpi: 2rem;                       /* 32 px */
  --text-label-mono: 0.6875rem;           /* 11 px */
  --text-label-mono--letter-spacing: 0.12em;

  --spacing-sidebar: 15rem;               /* 240 px */
  --spacing-topbar: 3.875rem;             /* 62 px */
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground font-sans antialiased; font-feature-settings: "cv11", "ss01"; }
  code, kbd, pre, .font-mono { font-variant-ligatures: contextual; }
}
```

Fuentes: autoalojar Inter y JetBrains Mono (subset latin + latin-ext, `font-display: swap`), sin Google Fonts en runtime.

---

## 2. Layout / shell

### 2.1 Estructura

```
┌──────────────┬─────────────────────────────────────────────────────────────────┐
│  SIDEBAR     │ TOPBAR (62 px, blanco, borde inferior #DADADE)                  │
│  240 px      │ [🔍 Buscar casos, ejecuciones...]        [● TestRail sincroniz…] 🔔│
│  #151623     ├─────────────────────────────────────────────────────────────────┤
│  logo        │ CONTENIDO (fondo #F6F7F8, padding 32 px, scroll vertical)        │
│  nav         │  H1 + subtítulo                         [acciones de página]     │
│              │  …cards / tablas…                                                │
│  ─────────   │                                                                  │
│  usuario     │                                                                  │
└──────────────┴─────────────────────────────────────────────────────────────────┘
```

- Sidebar **fijo** a la izquierda, alto completo, sin colapso visible en los mockups. Contenido fluido (en la captura
  1296 px útiles a 1600 px de ancho). Sin ancho máximo aparente; sugerido `max-w-[1600px]` opcional.
- Responsive no mostrado: sugerido colapsar sidebar a `Sheet` (shadcn) bajo `lg` (1024 px) con botón `Menu` en el
  topbar; tablas con scroll horizontal.

### 2.2 Sidebar

- Logo (DELTA X) en x 24 / y 26 + "KATALYST" en y≈75.
- **Navegación (orden y texto literal; una sola agrupación, sin títulos de grupo):**

| # | Texto | Icono Lucide | Ruta | Activo en capturas |
| --- | --- | --- | --- | --- |
| 1 | Inicio | `LayoutDashboard` | `/` | 02 |
| 2 | Catálogo | `ListChecks` | `/catalogo` | 03, 04, 05, 06, 07, 08 |
| 3 | Suites | `Layers` | `/suites` | 09 |
| 4 | Ejecuciones | `CirclePlay` | `/ejecuciones` | 10–15 |
| 5 | Programaciones | `CalendarClock` | `/programaciones` | 16–18 |
| 6 | Rendimiento | `Gauge` | `/rendimiento` | 19 |
| 7 | TestRail | `RefreshCw` | `/testrail` | 20 |
| 8 | Auditoría | `ScrollText` | `/auditoria` | 21 |
| 9 | Configuración | `Settings` | `/configuracion` | 22–26 |

- Ítem: alto 36 px, separación 2 px (paso 38 px), margen lateral 12 px (ancho 216 px), `rounded-md`, icono 16 px en
  x 24, texto 15 px en x 52, color `#B4B5BC`. **Activo**: fondo `#2A231F`, texto e icono `#EA9300`. Hover sugerido:
  fondo `white/5`, texto `#EAEBEF`. Activo por prefijo de ruta (p. ej. `/catalogo/C1501` activa "Catálogo").
- **Visibilidad por rol** (no mostrado: los mockups muestran todos los ítems a un usuario QA): ocultar "Auditoría" y
  "Configuración" a roles `qa`/`dev` (ESP §9: `GET /audit-log` y configuración son `admin`).
- **Bloque de usuario** (abajo, separador `#313140`): avatar circular 32 px fondo `#262737` con iniciales "AR"
  (`#EAEBEF`, 12 px 600); "Ana Rojas" 13 px 600 `#EAEBEF`; "QA" 12 px `#95969D`; botón icono `LogOut` a la derecha
  (x≈215). Rol mostrado en español: "QA", "Desarrollador", "Administrador".

### 2.3 Topbar

- Altura 62 px + borde inferior `#DADADE`, fondo blanco, padding-x 32 px.
- **Búsqueda global** (izquierda): input 384 × 38 px, icono `Search` 16 px, placeholder literal
  **"Buscar casos, ejecuciones..."**. Comportamiento (no mostrado): `Command`/popover con resultados agrupados (Casos,
  Ejecuciones), debounce 300 ms y cancelación (ESP §17.2); atajo sugerido `⌘K`/`Ctrl K`.
- **Indicador de TestRail** (derecha): pill borde `#DADADE`, fondo `#F6F8F9`, punto verde 6 px, texto mono 12 px literal
  **"TestRail sincronizado · 21:00"**. Estados adicionales exigidos (no mostrados): "Sincronizando…" (azul),
  "Sincronización fallida · HH:MM" (rojo), "Entregas pendientes: n" (ámbar). Clic → `/testrail`.
- **Notificaciones**: icono `Bell` 18 px con punto rojo `#DB2C2B` 6 px cuando hay no leídas. El panel/dropdown no aparece
  en los mockups (definir `Popover` con alertas de umbral y fallas de ejecución).
- **No hay** selector de ambiente global, ni breadcrumbs, ni menú de usuario en el topbar. El ambiente se elige por
  ejecución/programación y, en Rendimiento, por filtro de página (falta en el mockup; ver §3.19).

### 2.4 Navegación secundaria

- **Sin breadcrumbs**. Las páginas de detalle usan un botón ghost de retorno en la zona de acciones: "← Catálogo"
  (detalle de caso), "← Ejecuciones" (detalle de ejecución). Formularios usan "Cancelar" ghost arriba a la derecha.
- La cabecera de página es un patrón único: `PageHeader { title, subtitle, actions }`.

---

## 3. Capturas, una por una

Convención de rol mínimo según ESP §3 y §9: `qa < dev < admin`. Estados obligatorios no mostrados: ver ESP §17
("La ausencia de estados vacíos, error, permisos o carga en el mockup no autoriza a omitirlos").

### 3.1 `01-ingreso.png` — Ingreso

- **Ruta**: `/ingresar` (pública; redirige a `/` si hay sesión). Parámetro opcional `?redirect=` validado (sólo rutas internas).
- **Propósito**: login al panel con correo/contraseña o SSO corporativo (RF-USR-01).
- **Layout**: pantalla dividida 50/50 sin sidebar.
  - **Izquierda** (fondo ink `#151623` con cuadrícula de líneas finas cada 32 px; en el render se ven fuertes `#DADADE`,
    sugerido `white/8` para que sea sutil): logo DELTA X + "KATALYST"; titular grande en dos líneas
    **"Tus casos de TestRail,"** (blanco) / **"corriendo solos."** (naranja); bajada
    **"Graba flujos, prográmalos por día y hora y revisa resultados y rendimiento en un solo lugar."** (`#AAABB2`);
    pie mono **"Playwright · TestRail · DXMon"**.
  - **Derecha** (fondo `#F6F7F8`), formulario centrado de 384 px de ancho:
    - Título **"Ingresar"** (22 px 700) y subtítulo **"Usa tu cuenta de la empresa."**
    - Botón outline ancho completo **"Continuar con SSO de la empresa"**.
    - Separador con texto **"o"**.
    - Campo **"Correo"** (valor ejemplo `ana.rojas@deltax.la`).
    - Campo **"Contraseña"** (valor enmascarado `••••••••`).
    - Botón primario ancho completo **"Ingresar"**.
- **Componentes**: `AuthLayout`, `BrandPanel`, `Card` sin borde, `Input`, `Button`, `Separator` con etiqueta.
- **Estados mostrados**: formulario relleno.
- **Interacciones**: submit con TanStack Form + Zod; "Continuar con SSO" redirige al IdP (OIDC) **sólo si está
  configurado** (decisión abierta ESP §12; ocultar el botón y el separador si no hay IdP).
- **RF/RNF**: RF-USR-01, RNF-SEG-03 (HTTPS), RNF-SEG-01 (sin tokens en localStorage), RNF-USA-01, RNF-OPT-01.
- **No mostrado y exigido**: envío en curso (botón deshabilitado + `Loader2`), error de credenciales genérico ("Correo o
  contraseña incorrectos") sin revelar existencia de cuenta, cuenta deshabilitada, 429 por intentos (mostrar espera),
  error de red/servidor, sesión expirada ("Tu sesión expiró, vuelve a ingresar"), validación por campo (correo
  inválido, requerido), foco/teclado accesible, mostrar/ocultar contraseña opcional.

### 3.2 `02-inicio.png` — Inicio (dashboard)

- **Ruta**: `/` — rol `qa`.
- **Propósito**: resumen operativo del día: KPIs, alerta activa, ejecuciones recientes y próximas programaciones.
- **Cabecera**: H1 **"Buenas noches, Ana"** (saludo según hora local: "Buenos días" / "Buenas tardes" / "Buenas noches" +
  nombre de pila); subtítulo **"Jueves 5 de noviembre · America/La_Paz"** (fecha larga en zona configurada).
  Acción: botón primario **"Nueva ejecución"** (`Play`) → `/ejecuciones/nueva`.
- **KPIs (4 `KpiCard`)**:
  1. **"ÉXITO 7 DÍAS"** → **"87%"** (verde) · **"+4 pts vs semana anterior"**.
  2. **"EJECUCIONES HOY"** → **"14"** (ink) · **"1 corriendo ahora"**.
  3. **"COBERTURA AUTOMATIZADA"** → **"7/9"** (ink) · **"casos de TestRail con test"**.
  4. **"ALERTAS ACTIVAS"** → **"2"** (rojo) · **"Agendamientos p95 > 10 s"**.
- **Banner de alerta** (fondo `#F3E1E2`, borde `#EBAAAA`, icono `TriangleAlert` rojo):
  **"Agendamientos · lista"** (negrita) **" superó el umbral: p95 14,2 s (umbral 10 s) a las 17:00. "** + enlace
  subrayado **"Ver rendimiento"** → `/rendimiento`.
- **Card "Ejecuciones recientes"** (acción link naranja **"Ver todas"** → `/ejecuciones`). Tabla, columnas en orden:
  **ID · ORIGEN · AMBIENTE · RESULTADO · ESTADO**.

  | ID | Origen (línea 1 / línea 2) | Ambiente | Resultado | Estado |
  | --- | --- | --- | --- | --- |
  | R-2481 | Humo diario / Programada · 05 nov 21:30 | Producción | 2✓ 0✗ 0– | ● CORRIENDO |
  | R-2480 | Regresión OC / Manual · 05 nov 18:04 | Staging | 2✓ 1✗ 0– | FALLIDO |
  | R-2479 | Rendimiento DXMon / Programada · 05 nov 18:00 | Producción | 2✓ 0✗ 0– | INESTABLE |
  | R-2478 | C1501, C1502 / Manual · 05 nov 15:22 | Staging | 0✓ 1✗ 1– | FALLIDO |
  | R-2477 | Humo diario / Programada · 05 nov 08:00 | Producción | 4✓ 0✗ 0– | PASADO |

- **Card "Próximas programaciones"** (link **"Gestionar"** → `/programaciones`). Lista:
  - **"Humo mañana"** / **"Producción"** — **"06 nov 08:00"**
  - **"Rendimiento horario laboral"** / **"Producción"** — **"06 nov 08:00"**
  - **"Regresión nocturna OC"** / **"Staging"** — **"05 nov 22:00"**
- **Distribución**: tabla ocupa ~2/3 (856 px), próximas ~1/3 (416 px), gap 24 px.
- **Interacciones**: clic en ID/fila → `/ejecuciones/$runId`; clic en programación → `/programaciones/$scheduleId`;
  KPI de alertas → `/rendimiento`; SSE actualiza "1 corriendo ahora" y la fila en curso (sin polling si SSE está sano).
- **RF/RNF**: RF-EJE-02, RF-RES-01, RF-RES-05, RF-TR-03, RF-REN-03, RF-NOT-02, RF-PRG-02, RNF-USA-01, RNF-OPT-04.
- **No mostrado y exigido**: skeletons de KPIs/tablas; vacío ("Aún no hay ejecuciones", "No hay programaciones activas"
  con CTA); sin alertas (ocultar banner); error por bloque con "Reintentar" (no tumbar toda la página); varias alertas
  (agrupar "2 alertas activas" con enlace); KPIs sin datos suficientes ("—" + "sin datos en 7 días"); usuario sin
  permiso para "Nueva ejecución" (no aplica a qa, pero los botones deben consultar permisos).

### 3.3 `03-catalogo.png` — Catálogo

- **Ruta**: `/catalogo` con search params validados por Zod: `?seccion=&etiqueta=&q=&estado=&automatizacion=&sort=&cursor=&limit=25`
  — rol `qa`.
- **Propósito**: casos sincronizados desde TestRail con su estado de automatización y último resultado; punto de partida
  para seleccionar, ejecutar o programar.
- **Cabecera**: H1 **"Catálogo"**; subtítulo **"Casos sincronizados desde TestRail · Proyecto FMS DeltaX"**; acción
  outline **"Sincronizar"** (`RefreshCw`).
- **Panel de filtros (columna izquierda, 220 px)**:
  - Etiqueta mono **"SECCIÓN"**; lista: **"Todas"** (activo, fondo `#EDEDEF`, 600), **"Arranque"**,
    **"Órdenes de carga"**, **"Instalaciones"**, **"Agendamientos"** (árbol de secciones de TestRail; incluir
    descendientes, ESP §9).
  - Etiqueta mono **"ETIQUETA"**; chips clicables: **"@humo"**, **"@oc"**, **"@agendamiento"**, **"@arranque"**,
    **"@rendimiento"** (combinación OR, ESP §9). Estado seleccionado no mostrado: sugerido borde/texto naranja.
- **Tabla** (card), columnas en orden: **[checkbox] · CASO · ETIQUETAS · AUTOMATIZACIÓN · ÚLTIMO**.

  | Caso (ID mono naranja + título / sección · prioridad) | Etiquetas | Automatización | Último |
  | --- | --- | --- | --- |
  | **C1201** Login con usuario shipper válido / Arranque · Prioridad Alta | @arranque @humo | ● Automatizado | PASADO |
  | **C1202** Carga de Informe operativo < 10 s / Arranque · Prioridad Alta | @arranque @rendimiento | ● Automatizado / Inestable | INESTABLE |
  | **C1310** Filtrar órdenes de carga · Abastecimiento / Órdenes de carga · Prioridad Media | @oc @humo | ● Automatizado | PASADO |
  | **C1311** Filtrar órdenes de carga · Directa / Órdenes de carga · Prioridad Media | @oc | ● Automatizado | FALLIDO |
  | **C1312** Crear orden de carga · Distribuidores / Órdenes de carga · Prioridad Alta | @oc @escritura | ⚠ Requiere revisión | PASADO |
  | **C1420** Listar instalaciones en Configuración / Instalaciones · Prioridad Baja | @humo | ● Automatizado | PASADO |
  | **C1501** Agendamientos · vista lista carga < 60 s / Agendamientos · Prioridad Alta | @agendamiento @rendimiento | ● Automatizado | FALLIDO |
  | **C1502** Agendamientos · vista calendario / Agendamientos · Prioridad Media | @agendamiento | ○ Sin test | SIN EJECUTAR |
  | **C1503** Cambiar estado de agendamiento / Agendamientos · Prioridad Alta | @agendamiento | ○ Sin test | SIN EJECUTAR |

  Checkboxes de filas "Sin test" aparecen deshabilitados (borde naranja al 50 %). **No hay** checkbox de encabezado,
  paginación, buscador local, ni orden visible.
- **Interacciones**: clic en fila/título → `/catalogo/$caseId`; checkbox → selección (ver 04); chips/secciones actualizan
  search params y reinician cursor (ESP §17.3); "Sincronizar" → `POST /testrail/sync` (**admin**).
- **RF/RNF**: RF-TR-02, RF-TR-03, RF-TR-07, RF-CAT-01, RF-CAT-02, RF-CAT-04, RF-CAT-05, RNF-REN-01, RNF-OPT-02.
- **No mostrado y exigido**: carga (skeleton de filas, conservando datos previos al paginar con indicador de
  actualización); vacío por filtros ("Ningún caso coincide con los filtros" + "Limpiar filtros"); catálogo vacío
  ("Aún no se sincronizó TestRail" + CTA para admin); error de consulta; paginación por cursor 25/50/100 con
  Anterior/Siguiente (sin salto a página N); filtro por **estado del último resultado** y **texto** (RF-CAT-02) — la
  búsqueda global del topbar no sustituye al filtro de página; casos archivados ocultos; marca flaky con
  numerador/denominador ("Inestable 4/20 · Staging", ESP §13.1); "Sincronizar" oculto/deshabilitado para `qa`/`dev`;
  sincronización en curso y resultado (toast); columnas visibles persistidas en localStorage (sólo visibilidad/tamaño).

### 3.4 `04-catalogo-seleccion.png` — Catálogo con selección

- **Ruta**: `/catalogo` (misma). La selección vive en **TanStack Store** (no en la URL, ESP §17.1).
- **Propósito**: tras marcar casos aparece la barra de selección para ejecutar o programar.
- **Barra de selección** (sustituye el espacio sobre la tabla; fondo naranja `#EA9300`, `rounded-lg`, alto 56 px):
  texto **"1 casos seleccionados"** (cifra en negrita); botones **"Programar"** (`CalendarClock`, fondo claro
  `#EAEAED`) y **"Ejecutar"** (`Play`, sobre naranja con sombra).
- Fila C1201 marcada (checkbox relleno naranja con check ink). Resto de la tabla igual que 03.
- **Interacciones**: "Ejecutar" → `/ejecuciones/nueva?modo=casos` con la selección del Store; "Programar" →
  `/programaciones/nueva?modo=casos`.
- **RF/RNF**: RF-EJE-01, RF-PRG-01, RNF-OPT-02, ESP §17.3.
- **No mostrado y exigido**: pluralización correcta ("1 caso seleccionado" / "n casos seleccionados"); indicar
  seleccionados **fuera de la página visible** ("3 en otras páginas"); botón "Limpiar selección" (`X`); checkbox de
  encabezado que selecciona **sólo la página visible**; límite 500 casos por selección explícita con mensaje; advertencia
  al cambiar filtro/ámbito que limpia la selección; los casos sin automatización **deben poder seleccionarse** y aparecer
  luego como bloqueados `sin_automatizacion` en el plan (ESP §13.1) — el mockup los deshabilita (ver §6).

### 3.5 `05-caso-automatizado.png` — Detalle de caso automatizado

- **Ruta**: `/catalogo/$caseId` (p. ej. `/catalogo/C1501`; usar el ID de TestRail como parámetro legible y resolver a
  UUID en el loader) — rol `qa`.
- **Cabecera**: H1 **"C1501 · Agendamientos · vista lista carga < 60 s"**; subtítulo
  **"Agendamientos · Prioridad Alta · Clasificación lectura"**. Acciones: ghost **"← Catálogo"**, outline
  **"Generar con IA"** (`Sparkles`), outline **"Grabar"** (punto rojo), primario **"Ejecutar"** (`Play`).
- **Chips bajo el título**: `@agendamiento`, `@rendimiento`, badge **FALLIDO** (último resultado).
- **Card izquierda "Pasos en TestRail (v3)"** (v3 = revisión del caso). Lista numerada:
  1. **"Ingresar a /schedulings con usuario shipper"** — **"Esperado: Se muestra la vista Agendamientos"**
  2. **"Seleccionar la pestaña Lista"** — **"Esperado: La grilla carga en menos de 60 s"**
  3. **"Filtrar por estado 'Confirmado'"** — **"Esperado: Solo se muestran agendamientos confirmados"**
- **Card derecha "Test vinculado · tests/agendamiento.spec.ts"** con meta mono a la derecha **"main@a3f9c21"**; cuerpo
  `CodeViewer` oscuro con:

  ```ts
  test('C1501 Agendamientos lista carga < 60 s', {
    tag: ['@agendamiento', '@rendimiento'],
    annotation: { type: 'clasificacion', description: 'lectura' },
  }, async ({ page }) => {
    await page.goto('/schedulings');
    await page.getByRole('tab', { name: 'Lista' }).click();
    await expect(page.getByRole('grid')).toBeVisible({ timeout: 60_000 });
  });
  ```
- **Card "Historial (últimas 20)"**: gráfico de 20 barras (alto proporcional a la duración, color por resultado:
  verde pasado / rojo fallido; 5 rojas de 20); pie con **"Éxito 75%"** (izq.) y **"Duración media 48 s"** (der.).
- **Interacciones**: "Ejecutar" → `/ejecuciones/nueva?modo=casos&caseId=…`; "Grabar" → abre diálogo de grabación (06);
  "Generar con IA" → borrador IA (rol **dev**, RF-GRB-03, bloque 3); clic en barra → `/ejecuciones/$runId`.
- **RF/RNF**: RF-TR-02, RF-TR-03, RF-CAT-01, RF-CAT-05, RF-RES-03, RF-GRB-01, RF-GRB-03, RF-EJE-01.
- **No mostrado y exigido**: carga del visor (import dinámico, ESP §17.4); caso con **varios tests vinculados** (N:M →
  lista/tabs de tests); tests en estado `borrador`/`retirado`; flaky con numerador/denominador; historial con < 20
  ejecuciones o vacío ("Sin ejecuciones todavía"); tooltip por barra (fecha, ambiente, duración, estado); historial por
  ambiente; caso archivado (banner y acciones deshabilitadas); 404 "Caso no encontrado"; "Generar con IA" oculto o
  deshabilitado con tooltip para `qa`; código sanitizado sin secretos.

### 3.6 `06-caso-grabacion.png` — Diálogo de grabación

- **Ruta**: `/catalogo/$caseId?grabacion=$recordingId` (el ID de sesión de grabación en search param permite recargar y
  reanudar el estado; el diálogo en sí es UI local) — rol `qa`.
- **Propósito**: seguir una sesión de grabación del asistente local (codegen en el equipo del QA) y enviar el PR.
- **Diálogo** (fondo `#F6F7F8`, 512 px, overlay negro 80 %, botón `X` arriba a la derecha):
  - Título con punto rojo: **"Grabando C1501"**.
  - Texto: **"El asistente local abrió Chromium en staging. Interactúa con la app; las credenciales nunca salen de tu equipo."**
  - Recuadro mono (fondo `#EDEDEF`) con la lista de pasos capturados:
    - **"✓ goto /schedulings"**
    - **"✓ click tab "Lista""**
    - **"⚠ Falta verificación del paso 3"** (marrón `#3E2104`)
  - Botones: ghost **"Descartar"** (`Trash2`), outline **"Agregar verificación"** (`SquareCheck`), outline
    **"Detener"** (`Square`), primario **"Enviar PR"** (`GitPullRequest`).
- **Fondo**: la página 05 atenuada.
- **Interacciones**: estados de `recording_session` vía `GET /recordings/{id}` + SSE; "Detener" detiene codegen;
  "Agregar verificación" pide al asistente insertar aserción soportada; "Enviar PR" → `POST /recordings/{id}/complete`
  (crea rama + PR, RF-GRB-02); "Descartar" → `POST /recordings/{id}/cancel` con confirmación.
- **RF/RNF**: RF-GRB-01, RF-GRB-02, RF-GRB-05, RF-GRB-06, ESP §13.6, RNF-SEG-01.
- **No mostrado y exigido**: **asistente no instalado** (instrucciones de instalación para Windows 11, sin prometer abrir
  Chromium remotamente, ESP §9); asistente instalado pero no vinculado/desconectado (estado de salud); "Esperando que el
  asistente abra Chromium…"; sesión vencida (2 h) / cancelada; envío de PR en curso y resultado con enlace al PR
  (`pr_url`); rechazo por secretos/TODOs ("El código contiene datos sensibles…"); error de creación de rama/PR;
  confirmación al cerrar con pasos sin enviar; selección de etiquetas antes de grabar (RF-GRB-02 "etiquetas elegidas") y
  de ambiente (sólo staging para borradores, RF-GRB-05). El texto y botones del mockup **desbordan** el ancho del
  diálogo (ver §6): usar `max-w-xl`, `flex-wrap` en el pie y texto con salto de línea.

### 3.7 `07-caso-sin-test.png` — Caso sin test vinculado

- **Ruta**: `/catalogo/$caseId` (p. ej. `/catalogo/C1502`) — rol `qa`.
- **Cabecera**: H1 **"C1502 · Agendamientos · vista calendario"**; subtítulo
  **"Agendamientos · Prioridad Media · Clasificación -"**. Acciones iguales a 05, pero **"Grabar"** resaltado
  (fondo `#FFEED4`, texto `#663800`, punto rojo) como CTA principal sugerido.
- Chips: `@agendamiento`, badge **SIN EJECUTAR**.
- Card **"Pasos en TestRail (v3)"** (mismos 3 pasos que 05, dato de ejemplo).
- Card **"Sin test vinculado"** con estado vacío centrado: **"Graba el flujo o genera un borrador con IA para automatizar este caso."**
- Card **"Historial (últimas 20)"** con las mismas 20 barras y **"Éxito 75%"** / **"Duración media 48 s"** (dato de
  ejemplo copiado; ver §6).
- **RF/RNF**: RF-TR-03, RF-GRB-01, RF-GRB-03, RF-GRB-05, ESP §13.1.
- **No mostrado y exigido**: historial vacío para casos sin test ("Sin ejecuciones" — o resultados `bloqueado`
  `sin_automatizacion` si se incluyó en corridas); "Ejecutar" debe explicar que el plan quedará **bloqueado** (sin
  navegador) o deshabilitarse con tooltip; clasificación ausente mostrada como "Sin clasificar"; PR de grabación abierto
  pendiente de aprobación ("PR #84 en revisión").

### 3.8 `08-caso-revision.png` — Caso que requiere revisión

- **Ruta**: `/catalogo/$caseId` (p. ej. `/catalogo/C1312`) — rol `qa` (acción de revisión: `dev`).
- **Cabecera**: H1 **"C1312 · Crear orden de carga · Distribuidores"**; subtítulo
  **"Órdenes de carga · Prioridad Alta · Clasificación escritura"**. Acciones como 07 ("Grabar" resaltado).
- Chips: `@oc`, `@escritura`, badge **PASADO**, chip ámbar **"Requiere revisión: cambiaron los pasos en TestRail"**.
- Cards "Pasos en TestRail (v3)", "Test vinculado · tests/agendamiento.spec.ts" (`main@a3f9c21`, mismo código de C1501)
  e "Historial (últimas 20)" iguales a 05 (datos de ejemplo).
- **Propósito**: avisar que el vínculo test↔caso está `requiere_revision` porque cambió `content_hash` (RF-TR-07).
- **RF/RNF**: RF-TR-07, RF-EJE-06, ESP §13.1, `PUT /tests/{id}/case-links/{caseId}/review` (dev).
- **No mostrado y exigido**: **diff** entre la revisión revisada y la actual de los pasos (p. ej. "v2 → v3"); botón
  **"Marcar revisado"** (sólo `dev`) con confirmación — revisar el vínculo ≠ aprobar código; aviso de que el caso
  **no puede ir a producción ni a programaciones** hasta revisar (y advertencia en staging manual); clasificación
  `escritura` → badge visible "Escritura · bloqueado en producción".

### 3.9 `09-suites.png` — Suites

- **Ruta**: `/suites` — rol `qa`.
- **Cabecera**: H1 **"Suites"**; subtítulo **"Conjuntos guardados de casos o etiquetas"**; acción primaria
  **"Nueva suite"** (`Plus`).
- **Grid de 3 tarjetas** (`SuiteCard`, gap 16 px). Cada una: título 18 px, badge del último resultado arriba a la
  derecha, descripción, chips de etiquetas, meta mono (`N casos` + `CalendarClock` + horario), separador, botones
  **"Ejecutar"** (primario pequeño) y **"Programar"** (outline pequeño).

  | Título | Badge | Descripción | Etiqueta | Meta |
  | --- | --- | --- | --- | --- |
  | **Humo diario** | PASADO | Verificación rápida de pantallas principales | @humo | 4 casos · L-V 08:00 |
  | **Regresión OC** | FALLIDO | Órdenes de carga en las tres pestañas | @oc | 3 casos · Diario 22:00 |
  | **Rendimiento DXMon** | INESTABLE | Ciclos de medición de tiempos y tamaños | @rendimiento | 2 casos · L-V 08-18 c/30 min |

- **Interacciones**: "Ejecutar" → `/ejecuciones/nueva?modo=suite&suiteId=…`; "Programar" →
  `/programaciones/nueva?suiteId=…`; clic en tarjeta → `/suites/$suiteId` (edición; no mostrada).
- **RF/RNF**: RF-CAT-03, RF-EJE-01, RF-PRG-01, ESP §13.1 (suite dinámica para corridas futuras).
- **No mostrado y exigido**: **formulario de nueva/edición de suite** (nombre, descripción, selector por casos /
  etiquetas / secciones, vista previa de casos/tests resueltos) — pantalla inexistente en los mockups; eliminar suite
  con confirmación (no afecta snapshots históricos); vacío ("Aún no hay suites" + CTA); carga; error; suite sin
  ejecuciones (sin badge o "SIN EJECUTAR"); suite cuyo selector no resuelve casos (aviso); "4 casos" debe distinguir
  casos y tests (ESP §17.3); suites sin programación (meta sin horario) o con varias programaciones.

### 3.10 `10-ejecuciones.png` — Ejecuciones

- **Ruta**: `/ejecuciones` con `?ambiente=&estado=&origen=&desde=&hasta=&q=&cursor=&limit=25` — rol `qa`.
- **Cabecera**: H1 **"Ejecuciones"**; subtítulo **"Manuales y programadas, con su estado de publicación en TestRail"**;
  acciones: outline **"Exportar CSV"** (`Download`), primario **"Nueva ejecución"** (`Play`).
- **Tabla**, columnas en orden: **ID · ORIGEN · AMBIENTE · INICIADA POR · PROGRESO · DURACIÓN · TESTRAIL · ESTADO**.

  | ID | Origen / tipo · fecha | Ambiente | Iniciada por | Progreso (barra + contadores) | Duración | TestRail | Estado |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | R-2481 | Humo diario / Programada · 05 nov 21:30 | Producción | Programador | barra 50 % · 2✓ 0✗ 0– / 4 | 1m 12s | PENDIENTE | ● CORRIENDO |
  | R-2480 | Regresión OC / Manual · 05 nov 18:04 | Staging | Ana Rojas | 100 % · 2✓ 1✗ 0– / 3 | 2m 40s | PUBLICADO | FALLIDO |
  | R-2479 | Rendimiento DXMon / Programada · 05 nov 18:00 | Producción | Programador | 100 % · 2✓ 0✗ 0– / 2 | 3m 05s | PUBLICADO | INESTABLE |
  | R-2478 | C1501, C1502 / Manual · 05 nov 15:22 | Staging | Luis Paz | 100 % · 0✓ 1✗ 1– / 2 | 1m 58s | ERROR | FALLIDO |
  | R-2477 | Humo diario / Programada · 05 nov 08:00 | Producción | Programador | 100 % · 4✓ 0✗ 0– / 4 | 1m 30s | PUBLICADO | PASADO |
  | R-2476 | @oc / Manual · 04 nov 17:41 | Staging | Ana Rojas | 100 % · 1✓ 0✗ 2– / 3 | 40s | NO APLICA | CANCELADO |

  Barra de progreso 112 × 5 px, track `#EDEDEF`, relleno naranja. Duración mono (`1m 12s`).
- **Interacciones**: fila → `/ejecuciones/$runId`; SSE actualiza filas activas (agrupar renders cada 100–250 ms);
  "Exportar CSV" → exportación en servidor con los mismos filtros (elegir explícitamente "página actual" o "todo el
  filtro"; ESP §17.3).
- **RF/RNF**: RF-RES-01, RF-RES-04, RF-RES-05, RF-TR-08, RF-EJE-02, RNF-OPT-02, RNF-OPT-04.
- **No mostrado y exigido**: **barra de filtros** (ambiente, estado/outcome, origen manual/programada/api, rango de
  fechas, búsqueda) y **paginación por cursor**; exportar PDF (RF-RES-04); estados `en_cola`, `preparando`,
  `finalizando`, `cancelando`, `interrumpida`, `omitida` con sus badges; outcome `bloqueado` e `incompleto`; TestRail
  `enviando` y `requiere_intervencion`; vacío ("Aún no hay ejecuciones"); carga; error; fallback de polling sólo si SSE
  cae (lista visible cada 30 s con backoff).

### 3.11 `11-nueva-ejecucion-suite.png` — Nueva ejecución (suite guardada)

- **Ruta**: `/ejecuciones/nueva?modo=suite&suiteId=…` — rol `qa`.
- **Cabecera**: H1 **"Nueva ejecución"**; subtítulo **"La selección queda congelada al aceptar la corrida"**; acción
  ghost **"Cancelar"**.
- **Card "1 · Qué ejecutar"**: segmented **"Suite guardada"** (activo) | **"Casos / etiquetas"**; 3 radio-cards de suite:
  **"Humo diario" / "4 casos"** (seleccionada), **"Regresión OC" / "3 casos"**, **"Rendimiento DXMon" / "2 casos"**.
- **Card "2 · Dónde y cómo"** (dos columnas):
  - Izquierda: etiqueta **"Ambiente"**; radio-cards **"Staging" / `https://staging.deltax.la`** (seleccionada) y
    **"Producción" / `https://cbc.deltax.la`** con chip **"Solo lectura"**.
  - Derecha: **"Reintentos ante falla"** → botones **0** (activo) **1** **2**; **"Navegador"** → texto mono
    **"Chromium (único admitido)"**; checkbox **"Excluir tests inestables"** (marcado); checkbox
    **"Publicar resultados en TestRail"** (marcado).
- **Panel lateral "Plan resuelto"** (sticky, 360 px): pares clave-valor **"Tests" → "3"**, **"Commit" → "main@a3f9c21"**
  (mono), **"Workers" → "4"**, **"Duración estimada" → "~2 min"**; botón primario ancho completo **"Ejecutar ahora"**
  (`Play`).
- **Interacciones**: cada cambio dispara `POST /runs/preview` (debounced, cancelable) y actualiza el plan; "Ejecutar
  ahora" → `POST /runs` con `Idempotency-Key` estable por intento; botón deshabilitado en vuelo; al confirmar navega a
  `/ejecuciones/$runId`.
- **RF/RNF**: RF-EJE-01, RF-EJE-04, RF-EJE-05, RF-EJE-06, RF-EJE-07, RF-CAT-04, RF-TR-04, ESP §13.1, §17.2, §17.3.
- **No mostrado y exigido**: plan con **casos y tests por separado** + cobertura + bloqueados con motivo (ESP §17.3, ver
  §6); preview cargando/stale ("Actualizando plan…"); errores 422 con código estable (selección vacía, ambiente
  deshabilitado); 409 por configuración cambiada desde el preview; sin suites (vacío con CTA "Nueva suite"); ambiente
  sin usuario de prueba; capacidad saturada ("En cola: sin capacidad"); guardas ante navegación con cambios.

### 3.12 `12-nueva-ejecucion-casos.png` — Nueva ejecución (casos / etiquetas)

- **Ruta**: `/ejecuciones/nueva?modo=casos` (selección traída del Store del catálogo) — rol `qa`.
- Igual a 11 salvo:
  - Segmented con **"Casos / etiquetas"** activo.
  - Lista con checkbox (todos marcados), ID mono naranja, título y chips a la derecha:
    **C1201** Login con usuario shipper válido (@arranque @humo); **C1202** Carga de Informe operativo < 10 s
    (@arranque @rendimiento); **C1310** Filtrar órdenes de carga · Abastecimiento (@oc @humo); **C1311** Filtrar
    órdenes de carga · Directa (@oc); **C1312** Crear orden de carga · Distribuidores (@oc @escritura); **C1420** Listar
    instalaciones en Configuración (@humo); **C1501** Agendamientos · vista lista carga < 60 s (@agendamiento
    @rendimiento).
  - Plan resuelto: **"Tests" → "7"**, **"Commit" → "main@a3f9c21"**, **"Workers" → "4"**, **"Duración estimada" → "~2 min"**.
  - Ambiente Staging seleccionado; reintentos 0; ambos checkboxes marcados.
- **RF/RNF**: RF-EJE-01, RF-CAT-02, RF-EJE-07, ESP §9 (selección discriminada `caseIds` | `tags`).
- **No mostrado y exigido**: **selector por etiquetas** (chips, OR) y búsqueda/filtrado de casos dentro del paso; modo
  exclusivo casos **o** etiquetas (no mezclar en una misma petición); casos sin automatización listados y marcados
  "Bloqueado · sin automatización"; casos con revisión pendiente marcados; límite de 500 casos; lista larga paginada.

### 3.13 `13-nueva-ejecucion-produccion.png` — Nueva ejecución en producción

- **Ruta**: `/ejecuciones/nueva?modo=casos` con ambiente Producción — rol `qa`.
- Igual a 12 salvo:
  - Ambiente **Producción** seleccionado (borde naranja + ring).
  - Plan resuelto: **"Tests" → "6"**, **"Workers" → "1"**, **"Duración estimada" → "~2 min"**.
  - Callout rojo (`#FBE9E9`, borde rojo tenue, icono `ShieldAlert`): título **"1 bloqueado en producción"** (rojo, 600) y
    detalle **"C1312 · clasificación escritura"** (ink).
  - Botón **"Ejecutar ahora"** habilitado (se ejecutan los 6 permitidos; el bloqueado queda en el plan).
- **RF/RNF**: RF-EJE-06, RNF-SEG-04, RF-EJE-07, ESP §13.1.
- **No mostrado y exigido**: lista expandible de **todos** los motivos de bloqueo (escritura, sin clasificar, revisión
  pendiente, no aprobado, sin automatización); confirmación explícita al ejecutar en producción ("Vas a ejecutar 6 tests
  de solo lectura en Producción"); si **todo** queda bloqueado, explicar que la corrida termina `bloqueada` sin navegador;
  reintentos deshabilitados para escritura sin idempotencia aprobada.

### 3.14 `14-ejecucion-en-curso.png` — Ejecución en curso

- **Ruta**: `/ejecuciones/$runId` (p. ej. `/ejecuciones/R-2481`) — rol `qa` (cancelar: `qa`).
- **Cabecera**: H1 **"Ejecución R-2481"**; subtítulo **"Humo diario · Producción · Programada por Programador · 05 nov 21:30"**;
  acciones: ghost **"← Ejecuciones"**, destructivo **"Cancelar"** (`CircleX`).
- **Meta bajo título**: badge **● CORRIENDO** + mono **"commit a3f9c21 · Chromium · reintentos 1"**.
- **5 `KpiCard` de contadores**: **"EN COLA" 0**, **"CORRIENDO" 1**, **"PASADOS" 2** (verde), **"FALLIDOS" 1** (rojo),
  **"OMITIDOS" 0**.
- **Card "Resultados por test"**, columnas: **CASO · TEST · INTENTOS · DURACIÓN · ESTADO**.

  | Caso | Test | Intentos | Duración | Estado |
  | --- | --- | --- | --- | --- |
  | C1201 | Login con usuario shipper válido | 1 | 11.8s | PASADO |
  | C1310 | Filtrar órdenes de carga · Abastecimiento | 1 | 21.4s | PASADO |
  | C1311 | Filtrar órdenes de carga · Directa | 2 | 30.0s | FALLIDO |
  | C1420 | Listar instalaciones en Configuración | 1 | – | ● CORRIENDO |

  Bajo C1311, recuadro de error mono rojo sobre `#FBE9E9`:
  **"TimeoutError: loadingOrder/filter no respondió en 20 000 ms"**.
- **Card lateral "Evidencia (C1311)"**: lista con icono + texto + `ExternalLink`: **"Video del intento 2"**,
  **"Traza de Playwright"**, **"Captura sanitizada"**, **"Reporte HTML"**.
- **Card lateral "Publicación a TestRail"**: **"Corrida" → "#3392"**, **"Estado" → PENDIENTE**; nota
  **"Los resultados se publican al terminar; si TestRail no responde, se reintentan sin bloquear la ejecución."**
- **Interacciones**: SSE global (un canal por pestaña) invalida/actualiza contadores y filas (contadores derivados de
  registros persistidos, no de mensajes); seleccionar fila cambia el panel de evidencia; abrir evidencia pide URL firmada
  ≤ 5 min en el origen separado de reportes (`:3001`); "Cancelar" → confirmación → `POST /runs/{id}/cancel` → estado
  `cancelando` hasta confirmación del servidor (sin éxito optimista).
- **RF/RNF**: RF-EJE-02, RF-EJE-03, RF-EJE-08, RF-RES-01, RF-RES-02, RF-RES-05, RF-TR-04, RF-TR-05, RF-TR-08,
  RNF-SEG-05, ESP §13.2, §13.3, §17.2.
- **No mostrado y exigido**: estados `en_cola`/`preparando`/`finalizando`/`cancelando`; **resultados por intento**
  (expandir fila: intento 1 fallido, intento 2…, tipo `retry`/`recuperacion`); **agregado por caso** (case_result:
  cobertura completa/parcial/ninguna) separado de resultados por test; causas legibles de omisión/bloqueo; distinción
  falla de app vs runner vs publicación; evidencia deshabilitada por política del ambiente, expirada, fallida o retenida
  por seguridad; corrida sin fila seleccionada (panel de evidencia vacío); "no se pudo confirmar la detención del worker"
  tras cancelar; reconexión SSE ("Reconectando…") y fallback cada 5 s; 404/403 por recurso; plan resuelto congelado
  (snapshot) visible.

### 3.15 `15-ejecucion-finalizada.png` — Ejecución finalizada

- **Ruta**: `/ejecuciones/$runId` (p. ej. `/ejecuciones/R-2480`).
- **Cabecera**: H1 **"Ejecución R-2480"**; subtítulo **"Regresión OC · Staging · Manual por Ana Rojas · 05 nov 18:04"**;
  acciones: ghost **"← Ejecuciones"**, outline **"Repetir fallidos"** (`RotateCcw`).
- Meta: badge **FALLIDO** + **"commit a3f9c21 · Chromium · reintentos 1"**.
- KPIs: **EN COLA 0 · CORRIENDO 0 · PASADOS 2 · FALLIDOS 1 · OMITIDOS 0**.
- Tabla "Resultados por test", evidencia (C1311) y error idénticos a 14 (incluida la fila C1420 **● CORRIENDO** — error
  del mockup, ver §6).
- "Publicación a TestRail": **"Corrida" → "#3392"**, **"Estado" → PUBLICADO**; misma nota.
- **Interacciones**: "Repetir fallidos" crea una **nueva** corrida (`POST /runs` con `caseIds` de los fallidos) pasando por
  la pantalla de nueva ejecución con el preview; nunca reabre la corrida terminada; los tests de escritura no se repiten
  automáticamente.
- **RF/RNF**: RF-RES-01, RF-RES-02, RF-RES-05, RF-TR-04, RF-TR-05, RF-TR-08, ESP §13.2, §13.4.
- **No mostrado y exigido**: outcomes `pasado`/`inestable`/`bloqueado`/`incompleto` y estados terminales
  `cancelada`/`interrumpida`/`omitida` con causa; TestRail `requiere_intervencion` con enlace a `/testrail`; evidencia
  incompleta; enlace al destino en TestRail; exportar CSV/PDF de la corrida; duración de pared vs. tiempo de trabajo
  (ESP §13.4); "Repetir fallidos" deshabilitado si no hay fallidos.

### 3.16 `16-programaciones.png` — Programaciones

- **Ruta**: `/programaciones` con `?ambiente=&activa=&cursor=` — rol `qa`.
- **Cabecera**: H1 **"Programaciones"**; subtítulo
  **"Máximo una ejecución activa por programación; las ocurrencias solapadas se omiten"**; acción primaria
  **"Nueva programación"** (`Plus`).
- **Tabla**, columnas: **ACTIVA · NOMBRE · OBJETIVO · AMBIENTE · HORARIO · PRÓXIMA · [acciones]**.

  | Activa | Nombre / código | Objetivo | Ambiente | Horario (texto / cron · zona) | Próxima | Acciones |
  | --- | --- | --- | --- | --- | --- | --- |
  | on | **Humo mañana** / P-01 | Humo diario | Producción | Lunes a viernes 08:00 / `0 8 * * 1-5 · America/La_Paz` | 06 nov 08:00 | Pausar · Duplicar · Borrar |
  | on | **Rendimiento horario laboral** / P-02 | Rendimiento DXMon | Producción | L–V 08:00–18:00 cada 30 min / `*/30 8-17 * * 1-5 · America/La_Paz` | 06 nov 08:00 | Pausar · Duplicar · Borrar |
  | on | **Regresión nocturna OC** / P-03 | Regresión OC | Staging | Todos los días 22:00 / `0 22 * * * · America/La_Paz` | 05 nov 22:00 | Pausar · Duplicar · Borrar |
  | off | **Agendamientos fin de semana** / P-04 | @agendamiento | Staging | Sábados 10:00 / `0 10 * * 6 · America/La_Paz` | – | Reanudar · Duplicar · Borrar |

- **Interacciones**: toggle y Pausar/Reanudar → `POST /schedules/{id}/pause` (reflejar confirmación del servidor, sin
  optimista); Duplicar → `/programaciones/nueva?desde=$id`; Borrar → `AlertDialog` (borrado lógico; cancela corridas no
  iniciadas, no detiene en curso); fila → `/programaciones/$scheduleId`.
- **RF/RNF**: RF-PRG-01, RF-PRG-03, RF-PRG-04, ESP §13.5.
- **No mostrado y exigido**: **historial de cambios con autor** y revisión (RF-PRG-03) — pantalla de detalle no mostrada;
  **ocurrencias omitidas** con motivo (`solapamiento`, `sin_capacidad`, caída) (RF-PRG-04); varias expresiones cron por
  programación (ver §6); vacío; carga; error; tooltips en los iconos; programación pausada mostrando "Pausada por X el …";
  aviso de casos con revisión pendiente que impiden programar.

### 3.17 `17-programacion-intervalo.png` — Nueva programación (rango con intervalo)

- **Ruta**: `/programaciones/nueva` (y `/programaciones/$scheduleId/editar` con el mismo formulario) — rol `qa`.
- **Cabecera**: H1 **"Nueva programación"**; subtítulo **"Define qué, dónde y cuándo"**; acción ghost **"Cancelar"**.
- **Card "Objetivo"** (3 columnas): **"Nombre"** (input, valor `Rendimiento horario laboral`), **"Suite"** (select,
  `Humo diario`), **"Ambiente"** (select, `Staging`).
- **Card "Horario"**:
  - **"Días"**: círculos **L M X J V** activos, **S D** inactivos.
  - Segmented **"Hora fija"** | **"Rango con intervalo"** (activo).
  - **"Desde"** (`08:00 AM`), **"Hasta"** (`06:00 PM`), **"Cada"** (select `30 min`).
  - **"Zona horaria"** (select `America/La_Paz (UTC-4)`).
- **Panel lateral "Vista previa"**: etiqueta **"EXPRESIÓN CRON"** + bloque ink con texto naranja mono
  **`*/30 8-17 * * 1-5`**; etiqueta **"PRÓXIMAS 5 EJECUCIONES"** + lista con viñetas: **"Vie 06 nov 08:00"**,
  **"Vie 06 nov 08:30"**, **"Vie 06 nov 09:00"**, **"Vie 06 nov 09:30"**, **"Vie 06 nov 10:00"**; botón primario ancho
  completo **"Guardar programación"**.
- **Interacciones**: TanStack Form; la vista previa usa el **mismo servicio** que admisión (`@katalyst/shared/schedule`,
  validado en servidor con `GET /schedules/{id}/next?count=5` o endpoint de preview); intervalo mínimo 5 min; no ejecuta al
  guardar.
- **RF/RNF**: RF-PRG-01, RF-PRG-02, ESP §13.5, RNF-USA-01, RNF-USA-02.
- **No mostrado y exigido**: objetivo por **casos / etiquetas** (no sólo suite); reintentos (0..2); notificaciones;
  múltiples expresiones (rango 08:00–18:00 c/30 = `0,30 8-17 * * 1-5` + `0 18 * * 1-5`, 21 ocurrencias); horas en 24 h;
  validaciones (Hasta > Desde, al menos un día, cruce de medianoche requiere días explícitos); advertencias DST;
  errores 422 de servidor por campo; dirty guard; versión remota cambiada al editar; ventanas de exclusión (RF-PRG-05,
  Puede).

### 3.18 `18-programacion-hora-fija.png` — Nueva programación (hora fija)

- **Ruta**: `/programaciones/nueva`.
- Igual a 17 salvo: segmented **"Hora fija"** activo; campo único **"Hora"** (`08:00 AM`); **"Zona horaria"**
  `America/La_Paz (UTC-4)`.
- Vista previa: cron **`0 8 * * 1-5`**; próximas 5: **"Vie 06 nov 08:00"**, **"Lun 09 nov 08:00"**,
  **"Mar 10 nov 08:00"**, **"Mié 11 nov 08:00"**, **"Jue 12 nov 08:00"**; botón **"Guardar programación"**.
- **RF/RNF**: RF-PRG-01, RF-PRG-02.
- **No mostrado y exigido**: los mismos que 17; formato de día abreviado en español con mayúscula inicial
  (`Lun`, `Mar`, `Mié`, `Jue`, `Vie`, `Sáb`, `Dom`).

### 3.19 `19-rendimiento.png` — Rendimiento (DXMon)

- **Ruta**: `/rendimiento` con `?periodo=hoy|7d|30d&ambiente=&agrupar=hora|dia&comparar=` — rol `qa` (editar umbrales y
  marcas: `dev`).
- **Cabecera**: H1 **"Rendimiento"**; subtítulo **"Mediciones DXMon · Producción · hoy por hora"**; segmented
  **"Hoy"** (activo) | **"7 días"** | **"30 días"**.
- **KPIs**:
  1. **"P95 AGENDAMIENTOS"** → **"14,2 s"** (rojo) · **"umbral 10 s"**.
  2. **"ESPERA POR CURRENT"** → **"2,2 s"** (verde) · **"150 KB comprimido"**.
  3. **"ERRORES HTTP"** → **"3"** (marrón `#3E2104`) · **"2× 504, 1× 500"**.
  4. **"RESPUESTAS > 29 S"** → **"1"** (rojo) · **"17:12:04 · scheduling"**.
- **Card "p95 por hora (segundos)"**: gráfico de líneas (Recharts `LineChart`, curvas `monotone`, trazo 2 px), eje Y
  0–16 (ticks 0, 4, 8, 12, 16), eje X **08:00 … 18:00** por hora; series: **"Agendamientos lista"** (rojo, sube de ~4 a
  ~12.5 s), **"Órdenes de carga"** (naranja, ~3–4 s), **"current"** (verde, ~2–2.5 s); línea horizontal discontinua roja
  en 10 con etiqueta **"Umbral"**; línea vertical azul en 13:00 con etiqueta **"Despliegue v4.12"**; leyenda centrada
  inferior con marcador línea+círculo; grid discontinuo `#EDEDEF`. Datos hasta ~14:20 (hora actual del mock).
- **Card "Por pantalla y servicio"**, columnas: **PANTALLA · SERVICIO · PROMEDIO · P95 · MÁXIMO · EN RED · DESCOMPRIMIDO · UMBRAL P95**.

  | Pantalla | Servicio (mono) | Promedio | P95 | Máximo | En red | Descomprimido | Umbral p95 (input) |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | Agendamientos · lista | warehouse/list/scheduling | 8.9 s | **14.2 s** (rojo) | 61.0 s | 112 KB | 586 KB | 10 s |
  | Arranque | users/api/users/current | 2.2 s | 2.6 s | 4.1 s | 150 KB | 1.2 MB | 5 s |
  | Órdenes de carga | loadingOrder/filter | 3.5 s | 4.2 s | 20.0 s | 48 KB | 310 KB | 8 s |
  | Instalaciones | warehouse/api/warehouse | 0.9 s | 1.3 s | 2.0 s | 12 KB | 64 KB | 5 s |

- **Interacciones**: periodo/ambiente en URL; gráfico cargado con `import()` dinámico; editar umbral → diálogo/Sheet
  completo (métrica, ventana, mínimo de muestras) — rol `dev`; agregar marca de evento (RF-REN-04).
- **RF/RNF**: RF-REN-01, RF-REN-02, RF-REN-03, RF-REN-04, RF-REN-05, RF-NOT-02, ESP §13.8, ESP §17.4 (≤ 1000
  puntos/serie, agregados del backend), RNF-OPT-03.
- **No mostrado y exigido**: **selector de ambiente** (el subtítulo fija "Producción"); **conteo de muestras, calidad y
  "muestra insuficiente"** por serie/fila (< 20 muestras: no mostrar p95 inventado); p95 diario no disponible fuera de 90
  días; comparación entre períodos (RF-REN-02); vista por día; tooltip con valor, n y hora; timeouts aparte de errores
  HTTP; separación por origen/caché; vacío ("Sin mediciones en este período"); carga del gráfico (skeleton); error;
  inputs de umbral deshabilitados para `qa`; formato decimal con coma consistente (`14,2 s`).

### 3.20 `20-testrail.png` — TestRail

- **Ruta**: `/testrail` con `?estado=&tipo=&cursor=` — rol `qa` para ver; **`admin`** para "Sincronizar ahora" y
  "Reintentar".
- **Cabecera**: H1 **"TestRail"**; subtítulo **"Sincronización de casos y publicación de resultados"**; acción primaria
  **"Sincronizar ahora"** (`RefreshCw`).
- **KPIs**:
  1. **"ÚLTIMA SINCRONIZACIÓN"** → **"21:00"** (verde) · **"Completa · 412 casos"**.
  2. **"CASOS CAMBIADOS"** → **"3"** (marrón) · **"1 requiere revisión"**.
  3. **"ENTREGAS PENDIENTES"** → **"1"** (ink).
  4. **"ENTREGAS CON ERROR"** → **"1"** (rojo).
- **Card "Cola de entregas"**, columnas: **ID · TIPO · EJECUCIÓN · DESTINO · INTENTOS · DETALLE · ESTADO · [acción]**.

  | ID | Tipo | Ejecución | Destino | Intentos | Detalle | Estado | Acción |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | OB-552 | Resultados | R-2478 | TestRail run #3391 | 3 | HTTP 429 · reintento 22:10 | ERROR | **Reintentar** (`RotateCcw`) |
  | OB-551 | Cierre de corrida | R-2480 | TestRail run #3390 | 1 | OK | ENTREGADO | — |
  | OB-550 | Notificación | R-2480 | Slack #qa-deltax | 1 | OK | ENTREGADO | — |
  | OB-549 | Resultados | R-2481 | TestRail | 0 | Esperando fin de ejecución | PENDIENTE | — |

- **Interacciones**: "Sincronizar ahora" → `POST /testrail/sync`; "Reintentar" →
  `POST /integrations/testrail/deliveries/{id}/retry` (reconciliar antes de reenviar, auditado); enlaces a ejecución.
- **RF/RNF**: RF-TR-02, RF-TR-07, RF-TR-08, RNF-CON-02, ESP §13.4, RNF-OBS-02.
- **No mostrado y exigido**: sincronización en curso / fallida (con causa); lista de **casos cambiados** con enlace a
  revisión; estados `enviando`, `requiere_intervencion`, `vencida` (24 h); `Retry-After` en 429 como "reintentando a las
  HH:MM" (no como error terminal); filtros y paginación; vacío ("No hay entregas"); detalle de entrega (payload
  sanitizado, último error); acciones ocultas a no-admin; conexión no configurada (CTA a Configuración).

### 3.21 `21-auditoria.png` — Auditoría

- **Ruta**: `/auditoria` con `?actor=&accion=&entidad=&desde=&hasta=&cursor=` — rol **`admin`**.
- **Cabecera**: H1 **"Auditoría"**; subtítulo **"Registro de acciones en el panel"**. Sin acciones.
- **Tabla**, columnas: **FECHA · ACTOR · ACCIÓN · OBJETO**.

  | Fecha (mono) | Actor | Acción | Objeto (muted) |
  | --- | --- | --- | --- |
  | 05 nov 21:30 | Programador | Inició ejecución | R-2481 · Humo diario |
  | 05 nov 19:12 | Carlos Méndez | Aprobó test | C1312 · PR #84 |
  | 05 nov 18:04 | Ana Rojas | Inició ejecución | R-2480 · Regresión OC |
  | 05 nov 16:40 | Kevin Subieta | Cambió umbral | Agendamientos lista p95 → 10 s |
  | 05 nov 11:02 | Ana Rojas | Pausó programación | P-04 · Agendamientos fin de semana |
  | 04 nov 09:15 | Kevin Subieta | Agregó usuario de prueba | Staging · qa.shipper2 |

- **RF/RNF**: RF-USR-02, ESP §9 (`GET /audit-log` admin), índice `(created_at, id)`.
- **No mostrado y exigido**: filtros (actor, acción, entidad, rango de fechas) y paginación por cursor; detalle/diff
  (JSON sanitizado) en `Sheet` lateral; vacío; carga; error; **403 para no-admin** (el mockup lo muestra a un QA);
  enlaces del objeto a su pantalla.

### 3.22 `22-configuracion-testrail.png` — Configuración · TestRail

- **Ruta**: `/configuracion/testrail` (`/configuracion` redirige aquí) — rol **`admin`**.
- **Cabecera** (común a 22–26): H1 **"Configuración"**; subtítulo **"Solo administradores"**.
- **Tabs (rutas)**: **"TestRail"** (activa) · **"Ambientes"** · **"Usuarios de prueba"** · **"Notificaciones"** ·
  **"Usuarios del panel"**.
- **Card "Conexión"** (formulario de 632 px de ancho):
  - **"URL"** → `https://deltax.testrail.io` (ancho completo).
  - **"Usuario de servicio"** → `qa-runner@deltax.la` | **"API key"** → `•••••••••` (password).
  - **"Proyecto"** → `FMS DeltaX` | **"Suite"** → `Master`.
  - Botones: outline **"Probar conexión"** (`CircleCheck`), primario **"Guardar"**.
- **Interacciones**: `GET/PUT /testrail/connection` (sólo referencias de secretos); "Probar conexión" →
  `POST /testrail/connection/test` con resultado inline (versión, proyecto encontrado, permisos).
- **RF/RNF**: RF-TR-01, RNF-SEG-01, ESP §7 (`secret_ref`), ESP §17.4.
- **No mostrado y exigido**: la API key **nunca se devuelve**: mostrar "Referencia del secreto" (p. ej. ruta SSM) o campo
  de sólo escritura con estado "Configurada · actualizar"; Proyecto/Suite como selects cargados tras probar la conexión;
  resultado de prueba (éxito/fallo con causa); guardando; errores por campo; dirty guard; última sincronización y estado;
  habilitar/deshabilitar conexión; 403 para no-admin.

### 3.23 `23-configuracion-ambientes.png` — Configuración · Ambientes

- **Ruta**: `/configuracion/ambientes` — rol **`admin`**.
- Tabs con **"Ambientes"** activa.
- **Card "Ambientes"** con acción primaria pequeña **"Agregar"** (`Plus`). Tabla, columnas:
  **NOMBRE · URL APP · URL API · CONCURRENCIA · PRODUCCIÓN**.

  | Nombre | URL app (mono) | URL API (mono) | Concurrencia | Producción (switch) |
  | --- | --- | --- | --- | --- |
  | Staging | https://staging.deltax.la | https://staging-api.deltax.la | 4 | off |
  | Producción | https://cbc.deltax.la | https://fmsapi.deltax.la | 1 | on |

- **Interacciones**: "Agregar"/fila → `Dialog`/`Sheet` con formulario (`GET/POST/PUT /environments`).
- **RF/RNF**: RF-AMB-01, RF-EJE-04, RF-EJE-06, RNF-OPT-05.
- **No mostrado y exigido**: formulario de alta/edición; estado habilitado/deshabilitado; política de evidencia por
  ambiente (captura/video/traza permitidos); confirmación fuerte al marcar/desmarcar **Producción**; validación de URL
  (HTTPS); concurrencia con límite del sistema y aviso de capacidad; no borrar ambientes referenciados (sólo
  deshabilitar); vacío; carga; error.

### 3.24 `24-configuracion-usuarios-prueba.png` — Configuración · Usuarios de prueba

- **Ruta**: `/configuracion/usuarios-prueba` (`?ambiente=`) — rol **`admin`**.
- Tabs con **"Usuarios de prueba"** activa.
- **Card "Usuarios de prueba"** con **"Agregar"**. Columnas: **USUARIO · AMBIENTE · PERMISOS · CONTRASEÑA**.

  | Usuario (mono) | Ambiente | Permisos | Contraseña (muted 12.5 px) |
  | --- | --- | --- | --- |
  | qa.shipper1 | Staging | Lectura y escritura | Cifrada · solo la lee el ejecutor |
  | qa.shipper2 | Staging | Lectura y escritura | Cifrada · solo la lee el ejecutor |
  | qa.readonly | Producción | Solo lectura | Cifrada · solo la lee el ejecutor |

- **RF/RNF**: RF-AMB-02, RF-AMB-03, RNF-SEG-01, ESP §13.7 (`/environments/{id}/users`, nunca devuelve secretos).
- **No mostrado y exigido**: formulario de alta (etiqueta, usuario, referencia del secreto o carga de secreto write-only);
  rotar secreto; deshabilitar; producción sólo admite usuarios de solo lectura (validación); vacío; carga; error.

### 3.25 `25-configuracion-notificaciones.png` — Configuración · Notificaciones

- **Ruta**: `/configuracion/notificaciones` — rol **`admin`**.
- Tabs con **"Notificaciones"** activa.
- **Card "Canales"**: filas con borde y switch a la derecha (ancho 536 px):
  - **"Slack · #qa-deltax"** (on)
  - **"Correo · qa@deltax.la"** (off)
  - **"Microsoft Teams"** (off)
- Etiqueta mono **"AVISAR CUANDO"** y filas con switch:
  - **"Ejecución termina con fallas"** (on)
  - **"Ejecución interrumpida"** (on)
  - **"Se supera un umbral de rendimiento (máx. 1 por hora)"** (on)
- **RF/RNF**: RF-NOT-01, RF-NOT-02 (RF-NOT-03 preferencias por usuario: no mostrado, Debería/bloque 3).
- **No mostrado y exigido**: configuración de cada canal (webhook/SMTP como referencia de secreto), "Enviar prueba",
  estado de la última entrega; canal pendiente de decisión (ESP §12) — habilitar sólo adaptadores configurados; guardado
  explícito o confirmación por cambio (no optimista); errores; preferencias por usuario (bloque 3).

### 3.26 `26-configuracion-usuarios-panel.png` — Configuración · Usuarios del panel

- **Ruta**: `/configuracion/usuarios` — rol **`admin`**.
- Tabs con **"Usuarios del panel"** activa.
- **Card "Usuarios del panel"** con primario pequeño **"Invitar"** (`Plus`). Columnas: **NOMBRE · CORREO · ROL**.

  | Nombre | Correo | Rol (select) |
  | --- | --- | --- |
  | Kevin Subieta | kevin@deltax.la | Administrador |
  | Carlos Méndez | carlos@deltax.la | Desarrollador |
  | Ana Rojas | ana@deltax.la | QA |
  | Luis Paz | luis@deltax.la | QA |

- **RF/RNF**: RF-USR-01, RF-USR-02 (auditar cambios de rol), RF-USR-03 (tokens revocables — no mostrado).
- **No mostrado y exigido**: flujo "Invitar" (diálogo: correo, nombre, rol); deshabilitar usuario (no borrar); cambio de
  rol con confirmación y sin optimismo; impedir quitarse el último rol admin; **tokens de API** (crear/revocar con
  alcances y vencimiento, mostrar el token una sola vez); estado (activo/deshabilitado/invitación pendiente); vacío;
  carga; error.

---

## 4. Inventario de componentes reutilizables

Todos sobre primitivas shadcn/ui (Radix) + Tailwind; sin MUI. Los nombres de props son sugerencias tipadas.

| Componente | Uso (capturas) | Props sugeridas |
| --- | --- | --- |
| `AppShell` | Todas excepto 01 | `children` ; lee sesión/rol desde Query (`useSession()`) |
| `AppSidebar` | Todas excepto 01 | `items: NavItem[]` (`{ to, label, icon: LucideIcon, minRole: Role }`), `user: { name, role, initials }`, `onLogout()` |
| `Topbar` | Todas excepto 01 | `search: ReactNode`, `status: ReactNode`, `notifications: ReactNode` |
| `GlobalSearch` | Topbar | `placeholder="Buscar casos, ejecuciones..."`, `debounceMs=300`, `onSelect(result)` |
| `TestRailStatusPill` | Topbar | `state: 'ok' \| 'syncing' \| 'error' \| 'pending'`, `lastSyncAt: Date`, `pendingCount?: number` |
| `NotificationBell` | Topbar | `unread: number`, `items: Notification[]` |
| `BrandLogo` | Sidebar, login | `variant: 'sidebar' \| 'login'`, `showProductName = true` |
| `AuthLayout` / `BrandPanel` | 01 | `children` ; titular y pie fijos |
| `PageHeader` | Todas | `title`, `subtitle?`, `actions?: ReactNode`, `meta?: ReactNode` (badge + mono), `backTo?: { to, label }` |
| `Section` / `CardSection` | Todas | `title`, `action?: ReactNode`, `meta?: string` (p. ej. commit), `padded = true`, `children` |
| `KpiCard` | 02, 14, 15, 19, 20 | `label: string` (mono mayúsculas), `value: ReactNode`, `tone?: 'default' \| 'passed' \| 'failed' \| 'flaky' \| 'running'`, `hint?: string`, `loading?`, `href?` |
| `KpiGrid` | idem | `columns: 4 \| 5`, `children` |
| `AlertBanner` | 02 | `tone: 'danger' \| 'warning' \| 'info'`, `title: ReactNode`, `children`, `action?: { label, to }`, `onDismiss?` |
| `Callout` | 13, 14 (nota TestRail) | `tone`, `icon?`, `title`, `children` |
| `StatusBadge` | 02, 03, 05, 09, 10, 14, 15, 20 | `kind: 'run-status' \| 'run-outcome' \| 'result' \| 'sync' \| 'delivery' \| 'last-result'`, `value: <enum ESP>`, `size?: 'sm' \| 'md'` — mapea enum → etiqueta española + tono + icono (punto pulsante para activos) |
| `TagChip` / `TagList` | 03, 05, 09, 12 | `tag: string`, `variant: 'table' \| 'filter'`, `selected?`, `onToggle?` / `tags: string[]`, `max?` |
| `AutomationStatus` | 03 | `state: 'automatizado' \| 'requiere_revision' \| 'sin_test' \| 'borrador'`, `flaky?: { num, den, env }` |
| `ResultCounts` | 02, 10 | `passed`, `failed`, `skipped`, `total?` → `2✓ 0✗ 0– / 4` |
| `RunProgress` | 10 | `done`, `total`, `counts` (barra 112×5 + `ResultCounts`) |
| `IdLink` | 02, 03, 10, 14, 20 | `kind: 'run' \| 'case' \| 'schedule' \| 'delivery'`, `id`, `to` (mono naranja) |
| `DataTable<T>` | 02, 03, 10, 14, 16, 19, 20, 21, 23, 24, 26 | `columns: ColumnDef<T>[]`, `data: T[]`, `getRowId: (row) => uuid`, `state: { sorting, pagination }`, `onSortingChange`, `cursor: { hasNext, hasPrev, onNext, onPrev }`, `pageSize: 25 \| 50 \| 100`, `isLoading`, `isFetching`, `error?`, `empty: { title, description?, action? }`, `selection?: { selectedIds: Set<string>, onChange, disabled?: (row) => boolean, outsidePageCount }`, `onRowClick?`, `rowDensity?: 'comfortable' \| 'compact'`, `columnVisibilityKey?` (localStorage) |
| `FilterPanel` | 03 | `sections: TreeNode[]`, `activeSection`, `tags: string[]`, `activeTags: string[]`, `onChange(search)` |
| `FilterBar` | 10, 16, 20, 21 | `filters: FilterDef[]`, `value`, `onChange` (sincronizado con search params) |
| `SelectionBar` | 04 | `count`, `outsidePageCount`, `onExecute`, `onSchedule`, `onClear`, `maxCount = 500` |
| `StepList` | 05, 07, 08 | `steps: { n, action, expected }[]`, `revision: string` ("v3"), `diffFrom?: CaseRevision` |
| `CodeViewer` (lazy) | 05, 08 | `code`, `language='ts'`, `filePath`, `commit`, `maxHeight?`, `ligatures = true` |
| `HistoryBars` (lazy) | 05, 07, 08 | `items: { runId, status, durationMs, at }[]` (≤ 20), `successRate`, `avgDurationMs`, `onSelect(runId)` |
| `EmptyState` | 07 y todos los vacíos | `icon?`, `title`, `description?`, `action?` |
| `RecordingDialog` | 06 | `recordingId`, `caseId`, `state: RecordingSession`, `steps: RecordedStep[]`, `onDiscard`, `onAddAssertion`, `onStop`, `onSubmitPr`, `assistantHealth: 'ok' \| 'not_installed' \| 'offline'` |
| `SuiteCard` | 09 | `suite: { id, name, description, tags, caseCount, testCount?, scheduleLabel?, lastOutcome? }`, `onExecute`, `onSchedule` |
| `SegmentedControl` | 11, 12, 17, 18, 19 | `options: { value, label }[]`, `value`, `onValueChange`, `size?` (sobre `ToggleGroup` type single) |
| `RadioCardGroup` / `RadioCard` | 11, 12, 13 | `value`, `onValueChange`, `items: { value, title, description?, badge?, disabled?, reason? }[]` |
| `EnvironmentPicker` | 11–13, 17, 18 | `environments: Environment[]`, `value`, `onChange` (RadioCard con chip "Solo lectura" si producción) |
| `RetriesPicker` | 11–13 | `value: 0 \| 1 \| 2`, `onChange`, `disabledReason?` |
| `CasePickList` | 12, 13 | `cases: CaseRow[]`, `selectedIds`, `onChange`, `mode: 'casos' \| 'etiquetas'`, `blockedReasons?: Map<id, reason>` |
| `RunPlanPanel` | 11, 12, 13 | `plan: { caseCount, testCount, blocked: { caseId, reason }[], coverage, commit, workers, estimatedDurationMs?, revision }`, `isLoading`, `isStale`, `error?`, `onExecute`, `isSubmitting` |
| `BlockedList` | 13 | `items: { caseId, title, reason: BlockReason }[]`, `environment` |
| `ResultsTable` | 14, 15 | `results: RunResult[]`, `selectedId`, `onSelect`, `expandAttempts?: boolean` (usa `DataTable`) |
| `ErrorSnippet` | 14, 15 | `message` (sanitizado), `category?: 'app' \| 'infra' \| 'auth'` |
| `EvidenceList` | 14, 15 | `caseId`, `artifacts: { id, kind: 'video' \| 'trace' \| 'screenshot' \| 'report', label, status: 'ok' \| 'disabled' \| 'failed' \| 'expired' \| 'withheld' }[]`, `onOpen(artifactId)` (URL firmada) |
| `PublicationCard` | 14, 15 | `trRunId?`, `syncStatus`, `note`, `deliveriesHref` |
| `ConfirmDialog` | 14 (cancelar), 16 (borrar), 23, 26 | `title`, `description`, `confirmLabel`, `tone: 'danger' \| 'default'`, `onConfirm`, `pending` |
| `Switch` (toggle) | 16, 23, 25 | `checked`, `onCheckedChange`, `pending?`, `aria-label` |
| `RowActions` | 16 | `actions: { icon, label, onClick, tone?, hidden?, disabled? }[]` (icon buttons con tooltip) |
| `CronEditor` | 17, 18 | `value: { days: Weekday[], mode: 'fixed' \| 'range', at?: 'HH:mm', from?: 'HH:mm', to?: 'HH:mm', everyMin?: number, timezone: string }`, `onChange`, `minIntervalMin = 5`, `errors?` — produce `cronExpressions: string[]` |
| `DayPicker` | 17, 18 | `value: Weekday[]`, `onChange`, `labels = ['L','M','X','J','V','S','D']` |
| `TimeField` | 17, 18 | `value: 'HH:mm'`, `onChange`, `format24h = true` |
| `TimezoneSelect` | 17, 18 | `value`, `onChange`, `options` (IANA con offset actual) |
| `CronPreview` | 17, 18 | `expressions: string[]`, `nextRuns: Date[]`, `timezone`, `isLoading`, `error?` |
| `NextRunsList` | 02, 17, 18 | `items: { label?, at: Date, env? }[]`, `variant: 'bullets' \| 'list'` |
| `PeriodSelect` | 19 | `value: 'hoy' \| '7d' \| '30d'`, `onChange` |
| `PerfLineChart` (lazy, Recharts) | 19 | `series: { key, label, color, points: { t, p95, n, quality }[] }[]`, `thresholds: { value, label }[]`, `events: { t, label }[]`, `yUnit='s'`, `insufficientLabel='muestra insuficiente'` |
| `PerfTable` | 19 | `rows: { screen, endpoint, avgMs, p95Ms, maxMs, bytesWire, bytesBody, n, threshold? }[]`, `canEditThresholds`, `onEditThreshold(row)` |
| `ThresholdField` / `ThresholdDialog` | 19 | `value`, `unit`, `metric`, `windowMin`, `minSamples`, `onSave`, `disabled` |
| `DeliveryQueueTable` | 20 | `rows: Delivery[]`, `canRetry`, `onRetry(id)` |
| `AuditTable` | 21 | `rows: AuditEntry[]`, `onOpenDiff(id)` |
| `SettingsTabs` | 22–26 | `items: { to, label }[]` (Tabs como links de router) |
| `SecretRefField` | 22, 24, 25 | `label`, `configured: boolean`, `refValue?`, `onReplace(newSecret)` (write-only, nunca muestra el valor) |
| `ConnectionTestButton` | 22 | `onTest()`, `result?: { ok, message, details }` |
| `ChannelToggleRow` | 25 | `label`, `checked`, `onCheckedChange`, `configureHref?` |
| `RoleSelect` | 26 | `value: 'qa' \| 'dev' \| 'admin'`, `onChange`, `disabled?` (etiquetas "QA", "Desarrollador", "Administrador") |
| `PermissionGate` | Global | `minRole`, `fallback?: 'hide' \| 'disable' \| ReactNode` |
| `QueryBoundary` | Global | `query`, `loading: ReactNode`, `error: (e, retry) => ReactNode`, `empty?` |
| `ForbiddenPage` / `NotFoundPage` | Global | `title`, `description`, `backTo` |
| `Toaster` (sonner) | Global | confirmaciones de servidor (no optimistas) |

---

## 5. Mapa de rutas del panel

TanStack Router (file-based), search params validados con Zod y defaults explícitos (ESP §17.1). Rol mínimo según ESP §3
y §9; donde la página es visible a un rol menor pero contiene acciones de mayor rol, se indica.

| Ruta | Captura(s) | Rol mínimo | Notas |
| --- | --- | --- | --- |
| `/ingresar` | 01 | público | `?redirect=` interno; SSO condicional |
| `/` | 02 | qa | Inicio |
| `/catalogo` | 03, 04 | qa | `?seccion&etiqueta&q&estado&automatizacion&sort&cursor&limit`; "Sincronizar" = admin |
| `/catalogo/$caseId` | 05, 07, 08 | qa | "Generar con IA" = dev; "Marcar revisado" = dev |
| `/catalogo/$caseId?grabacion=$recordingId` | 06 | qa | Diálogo de grabación (asistente local) |
| `/suites` | 09 | qa | |
| `/suites/nueva` | — (no hay captura) | qa | Formulario de suite (RF-CAT-03) |
| `/suites/$suiteId` | — | qa | Edición/eliminación de suite |
| `/ejecuciones` | 10 | qa | `?ambiente&estado&origen&desde&hasta&q&cursor&limit`; exportar CSV/PDF |
| `/ejecuciones/nueva` | 11, 12, 13 | qa | `?modo=suite\|casos&suiteId&caseId`; selección masiva desde Store |
| `/ejecuciones/$runId` | 14, 15 | qa | `?resultado=$resultId` (fila seleccionada para evidencia) |
| `/programaciones` | 16 | qa | |
| `/programaciones/nueva` | 17, 18 | qa | `?suiteId&modo&desde=$scheduleId` (duplicar) |
| `/programaciones/$scheduleId` | — | qa | Detalle: historial de revisiones/autor, ocurrencias omitidas |
| `/programaciones/$scheduleId/editar` | 17, 18 (mismo formulario) | qa | |
| `/rendimiento` | 19 | qa | `?periodo&ambiente&agrupar&comparar`; umbrales y marcas = dev |
| `/testrail` | 20 | qa | Ver; "Sincronizar ahora"/"Reintentar" = admin |
| `/auditoria` | 21 | admin | |
| `/configuracion` | → redirect | admin | Redirige a `/configuracion/testrail` |
| `/configuracion/testrail` | 22 | admin | |
| `/configuracion/ambientes` | 23 | admin | |
| `/configuracion/usuarios-prueba` | 24 | admin | `?ambiente` |
| `/configuracion/notificaciones` | 25 | admin | |
| `/configuracion/usuarios` | 26 | admin | Incluye tokens de API (RF-USR-03) |
| `/asistente` | — | qa | Estado/instalación del asistente local de grabación (ESP §9, §13.6) |
| `/sin-permiso` (o componente 403) | — | autenticado | Ruta o `errorComponent` para 403 |
| `*` (404) | — | autenticado | `notFoundComponent` |

---

## 6. Discrepancias y ambigüedades entre capturas y ESP

### 6.1 Conteos y datos que NO deben inferirse

1. **Casos vs tests (ESP §17.3)**: en 11 la suite "Humo diario" dice **"4 casos"** pero el plan resuelto muestra
   **"Tests 3"**; en el catálogo sólo C1201, C1310 y C1420 llevan `@humo` (3). La ESP lo explica: "Selección de 4 casos
   puede resolver 3 tests por vínculos N:M: mostrar ambos conteos y cobertura para evitar ambigüedad de los mockups". El
   `RunPlanPanel` debe mostrar **Casos**, **Tests**, **Bloqueados** y **Cobertura** por separado; las tarjetas de suite
   deben decir "4 casos · 3 tests".
2. **Workers**: 11/12 muestran **4**, 13 (producción) **1**; Configuración · Ambientes muestra concurrencia **4/1**.
   RNF-OPT-05 fija concurrencia global inicial de navegadores **1** y bloque 1 usa capacidad 1 por ambiente (§13.5). El
   valor proviene de `POST /runs/preview`; no copiar 4 del mockup.
3. **Duración estimada "~2 min"**: igual en las tres variantes del formulario; debe venir del servidor (o omitirse) y no
   inventarse.
4. **Commit `main@a3f9c21`**: dato de ejemplo; el backend resuelve el commit permitido (ESP §9); el cliente no lo elige.
5. **Inconsistencias de datos de ejemplo** (no replicar lógica a partir de ellas):
   - R-2481: en 02 y 10 aparece `2✓ 0✗ 0–`, pero el detalle 14 tiene 2 pasados y **1 fallido**.
   - 15 (R-2480, **finalizada**) conserva la fila C1420 en **CORRIENDO** y contadores que suman 3 de 4 filas; además,
     "Regresión OC" (@oc) muestra C1201 y C1420, que no son @oc. Una corrida terminada **no** puede tener resultados en
     curso (§13.2).
   - 07 (caso **sin test**) muestra historial de 20 ejecuciones y "Éxito 75%"; 07/08 repiten pasos y código de C1501.
     08 (clasificación escritura) muestra código con `description: 'lectura'`.
   - 14/15 muestran "reintentos 1" aunque el formulario usa 0 por defecto (ESP: por defecto 0).
   - 14: "Corrida #3392" para R-2481 y 20: OB-549 R-2481 sin destino aún ("TestRail").
   - Login usa `ana.rojas@deltax.la`; Usuarios del panel lista `ana@deltax.la`.
   - 17/18: "Rendimiento horario laboral" con suite "Humo diario" y "Staging"; en 16 esa programación es "Rendimiento
     DXMon" en "Producción".
   - 19: KPI "P95 AGENDAMIENTOS 14,2 s" mientras la serie horaria no supera ~12,5 s; si el KPI es p95 del día debe
     rotularse ("p95 del período") y calcularse sobre muestras crudas (no promediando p95 horarios, ESP §7).

### 6.2 Reglas de la ESP que el mockup contradice o simplifica

6. **Cron del rango 08:00–18:00 c/30 min**: 16 (P-02) y 17 muestran `*/30 8-17 * * 1-5`, que **excluye 18:00**
   (20 ocurrencias). ESP §13.5 exige **21 ocurrencias** con `0,30 8-17 * * 1-5` **y** `0 18 * * 1-5` (prohíbe
   `*/30 8-18`). El `CronPreview` debe mostrar **varias expresiones** y el total diario.
7. **Casos sin automatización**: 03/04 deshabilitan sus checkboxes y 12 los omite de la lista; ESP §13.1: "no desaparecen
   de la selección" y quedan **bloqueados** `sin_automatizacion` en el plan (pueden publicarse Blocked a TestRail).
8. **Permisos por rol**: el usuario de los mockups es **QA** (Ana Rojas) pero ve "Auditoría" y "Configuración" (admin),
   "Sincronizar"/"Sincronizar ahora" (admin, `POST /testrail/sync`), "Reintentar" entregas (admin) y "Generar con IA"
   (dev). Ocultar o deshabilitar según rol; el subtítulo "Solo administradores" lo confirma.
9. **API key de TestRail** (22) como campo password con puntos: la ESP guarda sólo `secret_ref` y nunca devuelve
   secretos. Usar `SecretRefField` (referencia o reemplazo write-only).
10. **Etiquetas de estado vs enums ESP §13.2**: el mockup mezcla `status` y `outcome` en la columna "ESTADO" y usa nombres
    distintos. Mapeo propuesto (etiqueta UI ← enum):
    - `status`: EN COLA ← `en_cola`, PREPARANDO ← `preparando`, CORRIENDO ← `corriendo`, FINALIZANDO ← `finalizando`,
      CANCELANDO ← `cancelando`, CANCELADA ← `cancelada` (el mockup dice "CANCELADO"), INTERRUMPIDA ← `interrumpida`,
      OMITIDA ← `omitida`; si `terminada`, mostrar el `outcome`.
    - `outcome`: PASADO, FALLIDO, INESTABLE, BLOQUEADO, INCOMPLETO.
    - `sync_status`: NO APLICA ← `no_aplica`, PENDIENTE ← `pendiente`, ENVIANDO ← `enviando`, PUBLICADO ←
      `sincronizada` (mockup), REQUIERE INTERVENCIÓN ← `requiere_intervencion` (el mockup dice "ERROR").
    - `run_result.status`: PENDIENTE, CORRIENDO, PASADO, INESTABLE, FALLIDO, BLOQUEADO, OMITIDO, CANCELADO, ERROR INFRA.
    - Outbox: PENDIENTE, ENVIANDO, ENTREGADO, REQUIERE INTERVENCIÓN, VENCIDA.
    Registrar este mapeo en `docs/decisiones.md`.
11. **HTTP 429 como "ERROR"** (20): ESP §13.4 indica respetar `Retry-After` y reintentar con backoff; sólo 401/403/
    validación pasan a intervención. Un 429 con "reintento 22:10" debería verse como PENDIENTE/REINTENTANDO.
12. **Programación sólo por suite** (17/18): RF-PRG-01 admite casos/etiquetas además de suites; faltan reintentos y
    notificaciones (modelo `schedule.retries`, `schedule.notify`).
13. **Selects nativos y horas 12 h** (17, 18, 26): usar componentes shadcn y formato 24 h (RNF-USA-01).
14. **"Publicar resultados en TestRail"** (checkbox en 11–13): la ESP no define desactivar la publicación por corrida;
    `sync_status = no_aplica` existe. Ambigüedad → registrar decisión (¿opción por corrida o sólo por ambiente?).
15. **"Excluir tests inestables"** marcado por defecto: RF-CAT-04 es Debería; el criterio de flaky (≥ 10 observaciones,
    score ≥ 0,20, §13.1) debe mostrarse; el default debe decidirse y registrarse.
16. **"Repetir fallidos"** (15): no está en la ESP como acción; implementarlo como **nueva corrida** con preview (nunca
    reabrir) y sin repetir automáticamente tests de escritura.
17. **Evidencia en producción** (14: video y traza de una corrida en Producción): la evidencia depende de la política del
    ambiente (RF-RES-02, RF-TR-05); el panel debe mostrar "deshabilitada por política" cuando aplique.
18. **Rendimiento sin conteos ni calidad** (19): ESP §11 (2B) exige conteo, calidad y "muestra insuficiente" por serie; el
    subtítulo fija "Producción" sin selector; los umbrales inline simplifican `perf_threshold` (métrica, ventana, mínimo
    de muestras, selector de serie) y son rol dev.
19. **Programación de rendimiento**: ESP §11 pide `@rendimiento` cada 5 min; los mockups muestran c/30 min. Es sólo dato.
20. **Usuarios de prueba · "PERMISOS"** (24): el modelo `test_user` no tiene columna de permisos (sólo `label`); derivarla
    del ambiente o añadir campo con decisión registrada (producción exige usuario de solo lectura, RF-EJE-06).
21. **Concurrencia de ambientes y switch de producción inline** (23): cambio crítico sin confirmación; añadir
    `ConfirmDialog` y auditar.
22. **Cambio de rol inline** (26) sin confirmación ni auditoría visible; añadir confirmación y registrar en auditoría.
23. **"Aprobó test · PR #84"** (21): la aprobación válida es PR/MR con revisión, checks y merge protegido (§13.1); el
    evento de auditoría debe reflejar el merge, no un botón del panel.
24. **SSO en login** (01): el IdP corporativo es decisión abierta (§12); mostrar el botón sólo si está configurado.

### 6.3 Defectos visuales del mockup a no replicar

25. **Diálogo de grabación (06) desbordado**: el texto descriptivo, el recuadro de pasos y la fila de botones salen del
    ancho del diálogo (512 px → hasta x≈1140). Implementar con ancho `max-w-xl`, texto con salto y botones con
    `flex-wrap`/pie alineado a la derecha.
26. **Pluralización** "1 casos seleccionados" (04).
27. **Separador decimal inconsistente** en 19: KPI "14,2 s" (coma) vs tabla "14.2 s" / duraciones "11.8s" (punto).
    Formatear siempre con `Intl.NumberFormat('es-BO')` (coma decimal) y espacio antes de la unidad (`11,8 s`).
28. **Cuadrícula del login** demasiado contrastada (`#DADADE` sobre ink); usar `white/6–8 %`.
29. **Inputs del login** con fondo igual a la página (`#F6F7F8`) y en Configuración blancos: unificar (blanco).

### 6.4 Pantallas o funciones exigidas por la ESP sin captura

- Formulario de suite (crear/editar/eliminar) — RF-CAT-03.
- Detalle de programación con historial de revisiones y autores, ocurrencias omitidas — RF-PRG-03, RF-PRG-04.
- Detalle de intentos por test y agregado por caso con cobertura — RF-RES-05, §13.4.
- Historial por test con tendencia de éxito **y duración** — RF-RES-03 (05 sólo muestra barras).
- Estado e instalación del asistente local; flujo de vínculo de dispositivo — RF-GRB-01, §13.6.
- Revisión de borrador generado con IA y revisión asistida — RF-GRB-03, RF-GRB-04 (bloque 3).
- Gestión completa de umbrales y marcas de eventos — RF-REN-03, RF-REN-04.
- Comparación entre períodos y agregación por día — RF-REN-02.
- Exportación PDF — RF-RES-04.
- Tokens de API revocables — RF-USR-03.
- Preferencias de notificación por usuario — RF-NOT-03 (bloque 3).
- Ventanas de exclusión — RF-PRG-05 (Puede).
- Ejecutar Test Plan o corrida existente de TestRail (con opción explícita de cierre, §8) — RF-TR-06.
- Centro de notificaciones (campana), resultados de búsqueda global, páginas 403/404, sesión expirada.
- Estados transversales en **todas** las pantallas: cargando (skeleton, conservando datos previos al paginar), vacío,
  error con reintento, sin permiso (ocultar/deshabilitar con motivo), SSE desconectado/reconectando (ESP §17.1–§17.5).
