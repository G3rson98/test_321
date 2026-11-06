# Operación del host — Katalyst `internal`

Requisitos: RNF-CON-04 (backup diario cifrado, 7 días, RPO ≤ 24 h, RTO objetivo ≤ 4 h, restauración demostrada),
RNF-INF-03 (host único sin HA, límites y alertas externas), RNF-OBS-02, RNF-MAN-02 (instalación < 30 min),
RNF-SEG-01/05, ESP §7 (retenciones), §13.3, §13.7, §18, ARQ §4–§7.
Infraestructura: [`infra/terraform/README.md`](../infra/terraform/README.md) ·
Arquitectura y mapeo: [`docs/infraestructura.md`](infraestructura.md) · Costos: [`docs/costos.md`](costos.md).

Rutas en el host: versión activa `/opt/katalyst/current` (→ `/opt/katalyst/releases/<versión>`), anterior
`/opt/katalyst/previous`, scripts `/opt/katalyst/current/deploy/scripts/`, configuración no secreta
`/etc/katalyst/{infra,site}.env`, datos `/data` (EBS), secretos en tmpfs `/run/katalyst/secrets`, logs
`/var/log/katalyst/*.log` (también en CloudWatch `/katalyst/internal/host`, 14 días).

Acceso administrativo: **solo** `aws ssm start-session --target <instance_id>` (sin SSH). Todos los comandos de
este documento se ejecutan como root (`sudo -i`) dentro de esa sesión, salvo indicación.

## 1. Responsables y modelo de servicio

| Tema | Valor |
| --- | --- |
| Responsable de incidentes | PENDIENTE (ESP §12, "Capacidad y operación") |
| Disponibilidad | Host único sin HA; mantenimientos con interrupción anunciada |
| RPO / RTO | ≤ 24 h / objetivo ≤ 4 h, demostrados en §3 |
| Ventana de mantenimiento sugerida | PENDIENTE (fuera de programaciones críticas) |

## 2. Backups diarios

- `katalyst-backup.timer` ejecuta `backup-postgres.sh` a las **07:30 UTC (03:30 America/La_Paz)**,
  `Persistent=true` (si el host estaba apagado, corre al arrancar).
- El script exporta un snapshot de PostgreSQL, cuenta filas de tablas críticas **en ese mismo snapshot**,
  ejecuta `pg_dump --snapshot`, verifica con `pg_restore --list`, cifra con la clave **pública** GPG
  (`<prefijo>/backup/gpg_public_key`), calcula SHA-256, sube volcado + manifiesto a
  `s3://<backups>/postgres/daily/AAAA/MM/DD/` y registra el éxito en `/data/backups/state/last-success`.
- Retención: 7 días como versión actual + 7 días como versión no actual (bucket versionado). El rol del host
  no puede borrar backups ni cambiar versionado/lifecycle (bucket policy).
- Alarma `backup-vencido` si el último éxito supera **26 h** (métrica `BackupAgeHours`; datos faltantes = alarma).
- Backup manual (p. ej. antes de un cambio destructivo): `backup-postgres.sh --reason manual`.
  `deploy.sh` hace `--reason pre-deploy` automáticamente.
- Redis no se respalda: es transporte reconstruible (§12).

## 3. Restauración (RPO/RTO)

### 3.1 Prueba de restauración (mensual y antes de operar en producción)

1. En una estación administrativa, preparar un `GNUPGHOME` temporal con la clave **privada** de backups
   (desde el gestor de secretos del equipo); copiarlo al host en tmpfs (`/dev/shm/katalyst-gpg`, 0700) por la
   sesión SSM. Nunca guardarla en `/data`, SSM legible por el host ni en el repositorio.
2. Ejecutar: `restore-postgres.sh --gnupghome /dev/shm/katalyst-gpg --latest`
   - verifica SHA-256 (cifrado y texto plano), restaura en un contenedor `postgres` temporal con
     `--network none`, compara conteos con el manifiesto y muestra `restore_seconds`/`total_seconds`.
3. `shred -u` / borrar `/dev/shm/katalyst-gpg`.
4. Registrar en la bitácora:

| Fecha | Backup (key) | Edad del backup (RPO observado) | total_seconds | ¿Conteos OK? | Responsable |
| --- | --- | --- | --- | --- | --- |
| PENDIENTE (primera prueba antes de operar) | | | | | |

### 3.2 Restauración real sobre el servicio (objetivo RTO ≤ 4 h)

1. Declarar incidente; `compose.sh stop api control reports supervisor caddy` (detiene nuevas corridas).
2. Backup del estado actual si la BD aún arranca: `backup-postgres.sh --reason pre-restore`.
3. Descargar/verificar/descifrar el backup elegido (mismos pasos que `restore-postgres.sh --keep`, que deja el
   volcado verificado en `/data/restore-work/...`).
4. Recrear la base: `compose.sh exec postgres dropdb -U katalyst katalyst && compose.sh exec postgres createdb -U katalyst katalyst`.
5. `docker cp <volcado> $(docker ps -qf label=com.docker.compose.service=postgres):/tmp/restore.dump` y
   `compose.sh exec postgres pg_restore -U katalyst -d katalyst --exit-on-error --single-transaction /tmp/restore.dump`; borrar el volcado.
6. Vaciar Redis (transporte) y dejar que el control reconcilie desde PostgreSQL:
   `compose.sh stop redis && rm -rf /data/redis/* && compose.sh up -d redis` (§12).
7. `compose.sh up -d --wait` y `smoke-test.sh --host`; verificar en el panel corridas, programaciones y outbox.
8. Las corridas activas al momento del backup quedarán `interrumpida`/recuperadas según ESP §13.3; las
   ocurrencias perdidas se registran como omitidas por la reconciliación (ESP §13.5), sin ráfagas atrasadas.
9. Eliminar `/data/restore-work/*` y el contenedor temporal; registrar tiempos en la bitácora.

Pérdida del host completo o de la AZ: reemplazar instancia/volumen según `infra/terraform/README.md` §6 y luego
§11 + §3.2 de este documento.

## 4. Alarmas y respuesta

Todas notifican por SNS a `alarm_contact_emails` (confirmar suscripción tras el apply).

| Alarma | Significado | Primera respuesta |
| --- | --- | --- |
| `ec2-status-check-system` | Falla AWS (hardware/red) | Acción `recover` automática; verificar que la instancia volvió con la misma EIP; `smoke-test.sh --host` |
| `ec2-status-check-instance` | SO/kernel/red del host | Consola serie / reinicio desde consola; si persiste, reemplazo (README §6) |
| `cpu-alta` | CPU > umbral 15 min | Revisar corridas/concurrencia; con `t3`, ver créditos; dimensionar con benchmark |
| `cpu-credits-bajos` | Créditos `t3` por agotarse | Muestras DXMon con contención; evaluar `unlimited` o `m7i.large` (costos.md) |
| `disco-root-*` / `disco-data-*` | Uso ≥ 80 % (aviso) / 90 % (crítico) | `rotate-logs.sh`, `cleanup-runner-state.sh`, `du -xh /data | sort -h`; ampliar EBS si es crecimiento real |
| `memoria-baja` | Memoria disponible < 10 % | `docker stats`; revisar límites por servicio y ejecutor |
| `heartbeat-host-perdido` | Sin métricas del host 10 min | Host caído, sin red o `katalyst-metrics.timer` detenido |
| `backup-vencido` | Último backup > 26 h | `journalctl -u katalyst-backup`, `/var/log/katalyst/backup-postgres.log`; ejecutar manual |
| `outbox-vencida` | Entregas TestRail/notificación vencidas | Estado de TestRail/canal; panel de sincronización; no reintentar a mano fuera de la outbox |
| `cola-atrasada` | Corrida en cola > umbral | Capacidad saturada (1 navegador) o supervisor detenido; ver `compose.sh ps`, logs del supervisor |
| `heartbeat-worker-perdido` | Leases vencidos | Ejecutor caído; el control recupera una sola vez (ESP §13.3); revisar contenedores `katalyst.role=executor` |
| `metricas-app-no-disponibles` | No se lee `/metrics` | API caída o contrato de métricas incompleto |

## 5. Despliegue de la aplicación sin reprovisionar y rollback

La infraestructura (Terraform) y la aplicación (imágenes + Compose) se despliegan por separado. Actualizar la SPA
o el backend **no** cambia Terraform.

1. CI construye y publica imágenes (`deploy/docker/*.Dockerfile`), genera `release.env` con **tag + digest**
   (ver `deploy/release.env.example`) y empaqueta `deploy/` del mismo commit.
2. Copiar el paquete al host en `/opt/katalyst/releases/<versión>/` (mecanismo PENDIENTE según plataforma Git/CI,
   p. ej. SSM Run Command desde CI con rol OIDC).
3. `deploy.sh /opt/katalyst/releases/<versión>`: valida digests, descarga imágenes, backup `pre-deploy`,
   `migrate` (Prisma `migrate deploy`), cambia `current`, reinstala units, `up -d --wait`, `smoke-test.sh --host`.
4. **Rollback**: `deploy.sh --rollback` vuelve a las imágenes de `/opt/katalyst/previous`. Las migraciones no se
   revierten: deben ser *expand/contract* (compatibles con la versión anterior). Si una migración incompatible
   falló, restaurar el backup `pre-deploy` (§3.2).
5. Tras desplegar: `smoke-test.sh --external https://<panel> https://<reportes>` desde un CIDR permitido.

## 6. Parches

| Componente | Cadencia | Procedimiento |
| --- | --- | --- |
| SO (Amazon Linux 2023) | Mensual o ante aviso crítico | `dnf check-release-update`; `dnf upgrade --security -y` (o `--releasever=<versión>`), `needs-restarting -r`; reinicio en ventana; `smoke-test.sh --host` |
| Docker / Compose | Con el SO / al cambiar `docker_compose_version` | Compose: actualizar versión **y** SHA-256 en tfvars (cambia user-data: plan muestra stop/start) o instalar el binario verificado manualmente igual que user-data |
| CloudWatch agent | Con el SO | `dnf upgrade amazon-cloudwatch-agent` |
| Imágenes base (Node, Playwright, Postgres 16, Redis 7, Caddy) | Mensual / CVE | Nueva versión de aplicación con digests nuevos (§5). Playwright: misma versión exacta en imagen, runner y qa-tests |
| AMI | Cuando AL2023 lo requiera | Reemplazo planificado `-replace=aws_instance.host` (README §6) |

## 7. Rotación de secretos (SSM Parameter Store)

Los valores nunca pasan por Terraform, argumentos de procesos ni logs (ESP §13.7). Cargar siempre por stdin:
`... | aws ssm put-parameter --name <nombre> --type SecureString --overwrite --value file:///dev/stdin`.

| Secreto | Parámetro | Rotación | Pasos tras actualizar el parámetro |
| --- | --- | --- | --- |
| Contraseña PostgreSQL | `<p>/host/postgres_password` | Semestral / incidente | `compose.sh exec postgres psql -U katalyst -c "\password katalyst"` (interactivo, con el valor nuevo) → `systemctl restart katalyst-secrets` → `compose.sh up -d --force-recreate api control reports` |
| Contraseña Redis | `<p>/host/redis_password` | Semestral / incidente | `systemctl restart katalyst-secrets` → `compose.sh up -d --force-recreate redis api control supervisor` |
| Sesión del panel / firmas | `<p>/app/...` | Semestral | Reinicio de `api`/`reports` (invalida sesiones) |
| API key TestRail | `<p>/app/testrail/...` | Según política TestRail | Revocar la anterior en TestRail; reinicio de `control` |
| Usuarios de prueba DeltaX | `<p>/test-users/<ambiente>/<label>` | Según política DeltaX | El supervisor lee por asignación; sin reinicio |
| Token del supervisor (servicio) | `<p>/app/...` | Trimestral | Reinicio de `supervisor` |
| Clave GPG de backups | `<p>/backup/gpg_public_key` (+ privada fuera del host) | Anual | Nueva pública en SSM; conservar la privada anterior mientras existan backups cifrados con ella (≥ 14 días) |
| Credenciales AWS del host | Instance profile | Automática (STS) | Broker cada 5 min (`katalyst-aws-credentials.timer`) |

## 8. Limpieza y retenciones

| Dato | Retención | Mecanismo |
| --- | --- | --- |
| Evidencia sanitizada (S3) | 30 días | Lifecycle del bucket + limpieza diaria de la app (no borra resultados en BD) |
| Backups (S3) | 7 días + 7 días no actuales | Lifecycle del bucket |
| Logs CloudWatch | 14 días | Retención del log group |
| Logs locales | 7 rotaciones diarias; contenedores 20 MiB × 5 | `katalyst-logrotate.timer` / Docker json-file |
| storageState / secretos de asignación | Hasta fin del shard | tmpfs; `cleanup-runner-state.sh` al arrancar y cada hora |
| Temporales de corrida (`/data/runner/runs`) | Hasta fin de corrida (+90 min de gracia) | `cleanup-runner-state.sh` |
| Imágenes Docker sin uso | 7 días | `rotate-logs.sh` (`docker image prune`) |
| Resultados, auditoría, muestras | ESP §7 (365 / 90 días) | Limpieza diaria del proceso `control` |

## 9. Cuotas por corrida

- **Evidencia: 250 MiB** por corrida (`KATALYST_RUN_EVIDENCE_QUOTA_BYTES`). **Temporal: 1 GiB** por corrida
  (`KATALYST_RUN_TMP_QUOTA_BYTES`, `/tmp` tmpfs del ejecutor de 1 GiB).
- Al superarlas: se detiene la captura, el resultado se conserva y se marca evidencia incompleta; no se borra
  nada de la BD (ESP §18). Verificar en la aceptación con una corrida sintética que genere más de 250 MiB.
- Videos/trazas solo en fallas/reintentos y solo con sanitización demostrada (ESP §13.7).

## 10. Capacidad y benchmark

- Inicial: `global_browser_concurrency = 1`, ejecutor 1,5 vCPU / 2,5 GiB, presupuesto por servicio en
  `deploy/docker-compose.yml`. No replicar los 4 workers del mockup sin medición (ARQ §4).
- Ensayo RNF-REN-01: 5.000 casos, 10 usuarios, 5 min, p95 listados < 1 s con API/BD/Chromium activos; registrar
  CPU, memoria, disco y créditos (CloudWatch) y el tipo de instancia. Repetir con `m7i.large` si `t3.large`
  agota créditos o degrada p95; registrar decisión y costo en `docs/costos.md`.
- Ventana exclusiva para rendimiento (DXMon): sin pruebas funcionales simultáneas; contención de host invalida
  muestras.

## 11. Instalación en servidor limpio (< 30 min, RNF-MAN-02)

Prerrequisitos (fuera de este procedimiento): Terraform aplicado (README §2–§4), DNS de los dos hostnames
apuntando a la EIP, permiso DNS-01, parámetros SSM cargados (README §5), CIDR del operador en `allowed_cidrs`,
imágenes publicadas con digests, paquete de versión disponible.

1. `aws ssm start-session --target <instance_id>`; `sudo -i`.
2. Verificar user-data: `tail /var/log/katalyst-bootstrap.log` (debe terminar en `fin`), `mountpoint /data`,
   `docker compose version`, `cat /etc/katalyst/infra.env`.
3. `cp <paquete>/deploy/site.env.example /etc/katalyst/site.env` y completar `ACME_EMAIL` (y excepciones de red
   solo si están registradas).
4. Colocar la versión en `/opt/katalyst/releases/<versión>/` y ejecutar
   `/opt/katalyst/releases/<versión>/deploy/scripts/deploy.sh /opt/katalyst/releases/<versión>`.
5. Primer backup y prueba de restauración: `backup-postgres.sh --reason inicial` y §3.1.
6. `smoke-test.sh --external ...` desde un equipo autorizado; desde uno no autorizado HTTPS debe fallar.
7. Registrar el tiempo total de instalación (objetivo < 30 min) en la bitácora de §3.1 o en el acta de aceptación.

## 12. Reconstrucción de la cola (Redis)

Redis usa AOF (`appendfsync everysec`) en `/data/redis`; PostgreSQL es la fuente de verdad. Si Redis pierde datos
o se vacía deliberadamente, el reconciliador del proceso `control` recrea los job schedulers y reencola shards
pendientes desde la BD (ESP §13.5); las ocurrencias perdidas se registran como omitidas, sin ráfagas atrasadas.
Probarlo en la aceptación: con una programación activa, `compose.sh stop redis && rm -rf /data/redis/* &&
compose.sh up -d redis` y verificar en el panel que no hay duplicados ni ejecuciones atrasadas.
