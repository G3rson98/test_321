# worker
API de supervisor/ejecutor: claim de lease atómico, heartbeat, intentos, resultados, artefactos, muestras DXMon y fin de shard con fencing — RF-EJE-08, RNF-CON-01, RNF-SEG-05.
Rutas (ver `ROUTES` de @katalyst/shared): POST /api/v1/worker/claim, POST /api/v1/worker/catalog/listing, POST /api/v1/worker/heartbeat, POST /api/v1/worker/attempts, POST /api/v1/worker/results, POST /api/v1/worker/artifacts/upload, POST /api/v1/worker/artifacts/:id/finalize, POST /api/v1/worker/perf/samples, POST /api/v1/worker/complete.
