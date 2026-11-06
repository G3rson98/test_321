# runs
Vista previa, creación idempotente (Idempotency-Key), snapshot inmutable, resultados por intento/test/caso y cancelación — RF-EJE-01, RF-EJE-03, RF-EJE-07, RF-RES-01, RF-RES-05.
Rutas (ver `ROUTES` de @katalyst/shared): POST /api/v1/runs/preview, POST /api/v1/runs, GET /api/v1/runs, GET /api/v1/runs/summary (KPIs del inicio, WEB→API-B), GET /api/v1/runs/:id, GET /api/v1/runs/:id/results, GET /api/v1/runs/:id/results/:resultId/attempts, GET /api/v1/runs/:id/case-results, GET /api/v1/runs/:id/targets, POST /api/v1/runs/:id/cancel.
