# Estado del proyecto — 6 de noviembre de 2026

Implementación integrada completa a nivel local. Verificación final: `pnpm -r typecheck` OK, `pnpm lint` 0 errores,
tests api 236 · runner 82 · shared 248 · web 78 · recorder 84 (728 en verde), JS inicial del panel 203,1 KiB gzip
(≤ 250), gitleaks sin fugas. Trazabilidad: `docs/trazabilidad.md` (43 validado, 25 validado (local), 5 pendiente,
3 bloqueado). Actas de aceptación local en `docs/aceptacion/`.

## Cómo retomar
```bash
export PATH=/opt/homebrew/opt/node@24/bin:$HOME/.local/katalyst-bin:/opt/homebrew/opt/postgresql@16/bin:$PATH
brew services start postgresql@16 && brew services start redis
pnpm install && pnpm -r typecheck && pnpm -r test
pnpm dev:stack   # stack local completo (ver README.md y docs/aceptacion/e2e-local.md)
```

## Pendiente de código propio (5)
- RF-TR-05 / RF-RES-02 / RNF-SEG-02: enmascaramiento visual de capturas PNG y sanitización de video (hoy
  `captura`, `traza`, `video` deshabilitados por defecto, ESP §13.7).
- RF-PRG-05 (Puede): pantalla del panel para ventanas de exclusión (API lista).
- RNF-OPT-03: perfil del panel con 5.000 casos (bundle ya validado).
- Abiertos menores: `GET /tests/:id/source` (cómo obtener el código), reglas globales de notificación (producto).

## Bloqueado por decisiones externas (ESP §12)
DXMon legado (RF-REN-01) · TestRail real (IDs, API) · staging DeltaX + usuario de prueba/MFA · plataforma Git ·
canal de notificación · proveedor/clave IA · región/presupuesto AWS (RNF-INF-02, RNF-MAN-02 en host real) ·
IdP del panel · Windows 11 para el instalador del grabador.
