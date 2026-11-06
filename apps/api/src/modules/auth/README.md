# auth
Login/logout/identidad del panel (auth propia argon2id u OIDC), sesiones HttpOnly + CSRF y tokens API revocables — RF-USR-01, RF-USR-03.
Rutas (ver `ROUTES` de @katalyst/shared): GET /api/v1/auth/providers, POST /api/v1/auth/login, POST /api/v1/auth/logout, GET /api/v1/auth/me, POST /api/v1/auth/password/reset-request, POST /api/v1/auth/password/reset, POST /api/v1/auth/password/change, GET /api/v1/auth/tokens, POST /api/v1/auth/tokens, DELETE /api/v1/auth/tokens/:id.
