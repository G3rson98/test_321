# @katalyst/recorder — Asistente local de grabación

Aplicación de escritorio (Electron 45 + React 19 + TypeScript estricto + Vite/electron-vite + Tailwind 4) que el QA
instala una vez en Windows 11 para grabar flujos con `playwright codegen` (@playwright/test **1.65.0**) y enviarlos a
Katalyst, que abre la rama y el pull request. RF-GRB-01, RF-GRB-02, RF-GRB-06; ESP §9 (2C), §13.6, §13.7, RNF-SEG-01.

## Flujo para el QA (sin terminal)

1. **Vincular**: «Vincular asistente» muestra un código `XXXX-XXXX`; «Abrir el panel para aprobar» abre el panel y el QA
   lo aprueba con su sesión. El código vence a los 5 min; el sondeo respeta `interval` y `slow_down`.
2. **Abrir la grabación**: desde el panel («Grabar» → `katalyst://grabar?session=<id>`) o desde la lista del asistente.
   El enlace solo transporta el ID de sesión. Producción o ambientes sin grabación habilitada quedan **bloqueados**.
3. **Iniciar sesión** en Chromium (MFA incluido) con la **captura en pausa**; «Comenzar a grabar» guarda el
   `storageState` en `%TEMP%\katalyst-recorder\<id>\state.json` (solo el usuario) y abre codegen con `--load-storage`.
4. **Grabar**: el asistente muestra acciones y verificaciones reconocidas, advierte interacciones no soportadas y
   verificaciones pendientes. «Agregar verificación» guía a los botones *Assert visibility/text/value* de codegen.
5. **Detener → revisar → Enviar PR**: título (con el ID del caso), etiquetas y clasificación; validación local (≤ 1 MiB,
   sin secretos, sin `waitForTimeout`; `TODO selector` y verificaciones pendientes como advertencias a confirmar).
   Se muestra la URL del PR. El código y el `storageState` locales se borran tras enviar/descartar; el `storageState`
   vence a las 2 h y el código sin enviar a las 24 h (limpieza al iniciar y cada 5 min).

## Arquitectura

```text
src/shared/        channels.ts (allowlist IPC, sin dependencias) · ipc.ts (Zod de cada mensaje y del estado) · csp.ts
src/preload/       index.ts — contextBridge con API cerrada (`window.katalyst`), CJS para sandbox
src/main/core/     sin Electron, probados con Vitest:
  api-client.ts        /api/v1 (DTO de @katalyst/shared), Bearer solo en rutas autenticadas, redirect: 'error'
  device-flow.ts       inicio + sondeo limitado (interval, slow_down +5 s, vencimiento 5 min)
  credential-store.ts  credencial de dispositivo cifrada con el almacén del SO (safeStorage), revocable
  session-store.ts     carpeta temporal 0700 / storageState 0600 / código; borrado con sobrescritura
  cleanup.ts           limpieza al iniciar, periódica (5 min) y al salir
  codegen-runner.ts    `playwright codegen` en proceso hijo, entorno en lista blanca, lectura incremental, detener
  step-parser.ts       pasos/verificaciones/no soportadas desde la salida real de codegen
  validation.ts        validación previa al envío (verifySanitized/sanitizeText/lintTestSource de shared)
  code-transform.ts    título `C<id> … @tags`, goto relativos al baseURL
  environment-guard.ts bloqueo de producción (bandera, recording_allowed, hosts productivos de DeltaX)
  recording-controller.ts / app-controller.ts   orquestación y estado publicado al renderer
src/main/electron/ window-security.ts (webPreferences + endurecimiento) · ipc-router.ts (validación IPC) ·
                   safe-storage.ts · playwright-host.ts (Chromium, login sin captura, codegen)
src/renderer/      React: Vínculo, Grabaciones, Grabación (estilo Katalyst, docs/ui-capturas.md)
```

Seguridad Electron: `contextIsolation`, `sandbox`, sin `nodeIntegration`, sin `webview`, CSP estricta (sin
`unsafe-inline`/`eval`, `connect-src 'none'`), `setWindowOpenHandler` → deny, navegación/redirecciones bloqueadas,
permisos denegados, instancia única, protocolo `katalyst://`. No abre puertos: solo HTTPS saliente a la API (http
loopback solo con `KATALYST_RECORDER_DEV=1` y sin empaquetar).

## Desarrollo

```bash
pnpm --filter @katalyst/recorder dev          # electron-vite (KATALYST_RECORDER_DEV=1 para API en http://localhost)
pnpm --filter @katalyst/recorder typecheck
pnpm --filter @katalyst/recorder test         # Vitest (servidor API falso + codegen simulado)
pnpm --filter @katalyst/recorder build        # out/main, out/preload, out/renderer
pnpm --filter @katalyst/recorder e2e:smoke    # Electron real + codegen real contra API falsa (abre Chromium)
node apps/recorder/scripts/generate-codegen-fixtures.cjs   # regenera fixtures reales de codegen
```

## Empaquetar para Windows 11 (x64, NSIS por usuario)

En una máquina Windows 11 x64 con Node 24 y pnpm 10:

```powershell
pnpm install
# 1) Dirección del servidor de la organización (opcional; el QA también puede escribirla):
#    apps/recorder/resources/katalyst.config.json  →  { "serverUrl": "https://katalyst.empresa.com" }
# 2) Opcional: incluir Chromium en el instalador (si se omite, se descarga en el primer uso, ~150 MB):
pnpm --filter @katalyst/recorder browsers:fetch
# 3) Instalador:
pnpm --filter @katalyst/recorder dist:win      # → apps/recorder/release/KatalystGrabador-<versión>-x64-setup.exe
```

El instalador NSIS es por usuario (sin administrador), registra `katalyst://` en `HKCU\Software\Classes`, crea accesos
directos y al desinstalar borra `userData` (incluida la credencial cifrada). No se firma en esta fase (SmartScreen
mostrará «editor desconocido»). Construir desde macOS/Linux requiere Wine para `rcedit` o
`-c.win.signAndEditExecutable=false`. Fusibles Electron: `RunAsNode` habilitado (codegen se ejecuta con el ejecutable
de Electron), `NODE_OPTIONS`/`--inspect` deshabilitados, integridad de asar y carga solo desde asar.

**Chromium**: Playwright 1.65.0 usa su Chromium (`chromium-1254`). Se busca primero en `resources/ms-playwright`
(incluido) y si no en `%APPDATA%\Katalyst Grabador\ms-playwright` (descargado con «Instalar Chromium» del asistente,
`playwright install chromium --no-shell`, HTTPS saliente al CDN de Playwright).
