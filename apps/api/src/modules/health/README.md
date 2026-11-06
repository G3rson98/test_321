# health
Liveness (`/healthz`) y readiness (`/readyz`: PostgreSQL `SELECT 1` + Redis `PING`, 503 si falla) sin secretos — RNF-OBS-02.
Rutas (fuera de /api/v1): GET /healthz, GET /readyz, GET /metrics (pendiente: métricas de cola/outbox/leases, RNF-OBS-01).
