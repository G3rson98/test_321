# Estimación de costos — Katalyst `internal`

Requisitos: RNF-INF-02 (estimación regional con techo acordado antes de apply; sin Free Tier como supuesto ni
ahorro porcentual sin medición), ESP §18, ARQ §6. Infraestructura descrita en
[`infra/terraform/`](../infra/terraform/README.md) y [`docs/infraestructura.md`](infraestructura.md).

> **Estado: PENDIENTE.** Ningún precio de este documento ha sido cotizado. No se inventan montos: cada campo
> `PENDIENTE` se completa con la cotización de AWS Pricing Calculator para la región elegida y la fecha de
> consulta. El primer `terraform apply` está bloqueado hasta que la sección 1 esté completa y aprobada.

## 1. Datos de la estimación (completar antes del primer apply)

| Campo | Valor |
| --- | --- |
| REGIÓN AWS | PENDIENTE (ESP §12) |
| FECHA de cotización | PENDIENTE (AAAA-MM-DD) |
| Enlace a la estimación guardada en Pricing Calculator | PENDIENTE |
| MONEDA | USD |
| COSTO MENSUAL ESTIMADO (USD) | PENDIENTE |
| TECHO MENSUAL ACORDADO (USD) = `monthly_budget_usd` | PENDIENTE |
| Aprobado por / fecha | PENDIENTE |
| Tipo de instancia cotizado | `t3.large` (por defecto) y `m7i.large` (alternativa) — ambos PENDIENTE |
| Revisión de facturación real tras la primera semana | PENDIENTE (fecha y desvío vs. estimación) |

## 2. Supuestos de uso (ajustar con datos del equipo)

| Supuesto | Valor inicial | Fuente / comentario |
| --- | --- | --- |
| Horas del host por mes (`H`) | 730 (24×7) | Host encendido para cron/monitoreo; sin apagado nocturno ni Spot (RNF-INF-03) |
| Tipo de instancia | 2 vCPU / 8 GiB x86_64 On-Demand | ARQ §4; redimensionar tras benchmark |
| Modo de CPU credits (si `t3`) | `standard` | `unlimited` agrega cargo por créditos excedentes (ver §3.1) |
| Disco raíz (`R`) | 30 GiB gp3 | `root_volume_size_gib` |
| Disco de datos (`D`) | 100 GiB gp3, 3000 IOPS / 125 MiB/s incluidos | `data_volume_size_gib`; sin IOPS/throughput extra por defecto |
| IPv4 públicas | 1 EIP asociada todo el período | Cobro por IPv4 pública también si el host está detenido |
| Evidencia sanitizada ingerida por día (`Ev`) | PENDIENTE GiB/día | Depende de política de evidencia (ESP §13.7); tope 250 MiB por corrida |
| Corridas por día (`N`) | PENDIENTE | Programaciones + manuales; frecuencia mínima 5 min si se habilita |
| Retención de evidencia | 30 días | ESP §7 |
| Tamaño de backup diario cifrado (`B`) | PENDIENTE GiB | Medir tras primera semana |
| Backups retenidos | 7 actuales + hasta 7 días de versiones no actuales | RNF-CON-04; `backup_noncurrent_retention_days` |
| Logs ingeridos a CloudWatch (`L`) | PENDIENTE GiB/mes | Pino JSON sin cuerpos/tokens; ejecutores no envían logs crudos |
| Retención de logs | 14 días | ESP §18 |
| Egreso a Internet (`E`) | PENDIENTE GiB/mes | Tráfico a DeltaX, TestRail, descargas de evidencia por URL firmada, imágenes |
| Uso de IA (`T`) | PENDIENTE tokens/mes | Presupuesto propio por usuario/día/solicitud (ESP §13.7) |

No se asume Free Tier, créditos promocionales ni descuentos (Savings Plans / Reserved) — si existen en la cuenta,
se registran aparte como ajuste, no como base.

## 3. Partidas y fórmulas

`Costo total mensual = Cómputo + Almacenamiento/Backup + IPv4 + S3 requests/egreso + Logs/métricas/alarmas +
Identidad/DNS/secretos + IA/canales + Operación (horas persona)`

| # | Partida | Recurso Terraform | Fórmula | Precio unitario (región/fecha) | USD/mes |
| --- | --- | --- | --- | --- | --- |
| 3.1 | EC2 On-Demand | `aws_instance.host` | `H × precio_hora(tipo)` | PENDIENTE | PENDIENTE |
| 3.1b | CPU credits excedentes (solo `t3` + `unlimited`) | `credit_specification` | `vCPU·h excedentes × tarifa_crédito` | PENDIENTE | PENDIENTE |
| 3.2 | EBS raíz gp3 | `root_block_device` | `R × precio_GiB_mes_gp3` | PENDIENTE | PENDIENTE |
| 3.3 | EBS datos gp3 | `aws_ebs_volume.data` | `D × precio_GiB_mes_gp3 + max(0, IOPS−3000) × precio_IOPS + max(0, MiBps−125) × precio_MiBps` | PENDIENTE | PENDIENTE |
| 3.4 | Snapshot final de EBS (solo al destruir) | `final_snapshot = true` | `GiB_snapshot × precio_snapshot` (no recurrente) | PENDIENTE | 0 en operación normal |
| 3.5 | IPv4 pública (EIP) | `aws_eip.host` | `H × precio_IPv4_hora` | PENDIENTE | PENDIENTE |
| 3.6 | S3 evidencia (almacenamiento) | `aws_s3_bucket.evidence` | `≈ Ev × 30 × precio_GiB_mes_Standard` (estado estable con expiración a 30 días) | PENDIENTE | PENDIENTE |
| 3.7 | S3 backups (almacenamiento) | `aws_s3_bucket.backups` | `≈ B × (7 + 7) × precio_GiB_mes_Standard` (actuales + no actuales) | PENDIENTE | PENDIENTE |
| 3.8 | S3 state | bootstrap | `GiB_state × precio` (despreciable; versiones acotadas a 90 días / 20 versiones) | PENDIENTE | PENDIENTE |
| 3.9 | S3 solicitudes | 3 buckets | `PUT/COPY/POST/LIST/1000 × precio + GET/1000 × precio` (artefactos por corrida × N × 30 + backups + lifecycle) | PENDIENTE | PENDIENTE |
| 3.10 | Transferencia de datos (egreso) | host + S3 | `E × precio_GiB_egreso` (la entrada es sin cargo; considerar descargas por URL firmada) | PENDIENTE | PENDIENTE |
| 3.11 | CloudWatch Logs | `aws_cloudwatch_log_group.host` | `L × precio_ingesta_GiB + L × (14/30) × precio_almacenamiento_GiB_mes` | PENDIENTE | PENDIENTE |
| 3.12 | CloudWatch métricas personalizadas | CWAgent + `Katalyst` | `n_métricas × precio_métrica_mes` + `PutMetricData` (1/min ≈ 43 800 llamadas/mes) | PENDIENTE | PENDIENTE |
| 3.13 | CloudWatch alarmas | `monitoring.tf` | `n_alarmas × precio_alarma_estándar` | PENDIENTE | PENDIENTE |
| 3.14 | SNS correo | `aws_sns_topic.alarms` | notificaciones × precio | PENDIENTE | PENDIENTE |
| 3.15 | AWS Budgets | `aws_budgets_budget.monthly` | según política vigente de Budgets (1 presupuesto) | PENDIENTE | PENDIENTE |
| 3.16 | SSM Parameter Store | parámetros bajo prefijo | Standard: verificar cuotas/cargos vigentes (parámetros, throughput); Advanced solo si se justifica | PENDIENTE | PENDIENTE |
| 3.17 | KMS (solo si se pasan CMKs existentes) | `*_kms_key_arn` | `solicitudes/10 000 × precio` (la CMK ya existe; no se crea) | PENDIENTE | PENDIENTE / 0 |
| 3.18 | Route 53 | registros en zona existente | consultas × precio (la zona ya existe y no se cobra a Katalyst si es compartida) | PENDIENTE | PENDIENTE |
| 3.19 | Session Manager | SSM | sin cargo adicional por sesión estándar; registro de sesiones a S3/CloudWatch no habilitado | PENDIENTE (verificar) | PENDIENTE |
| 3.20 | Registro de imágenes | fuera de Terraform | según plataforma Git/registro elegido (ESP §12) | PENDIENTE | PENDIENTE |
| 3.21 | IA (proveedor pendiente) | adaptador `AiProvider` | `T × precio_token` con límite por usuario/día/solicitud | PENDIENTE | PENDIENTE |
| 3.22 | Canal de notificación | SMTP/Slack/Teams | según canal elegido | PENDIENTE | PENDIENTE |
| 3.23 | Operación | — | `horas/mes (parches, backups, restauración, incidentes) × tarifa interna` | PENDIENTE | PENDIENTE |
| | **Total** | | | | **PENDIENTE** |

Conteos de referencia derivados del Terraform (verificar en consola tras el apply):

- **Alarmas**: 15 con tipo burstable (status system, status instance, CPU, CPU credits, disco ×4, memoria,
  heartbeat de host, backup, outbox, cola, leases, scrape de métricas); 14 con tipo no burstable.
- **Métricas personalizadas**: ~6 en `Katalyst` + ~11 en `CWAgent` (memoria 2, swap 1, disco/inodos por
  `/` y `/data` con y sin agregación). La cardinalidad es fija (sin etiquetas por corrida/usuario).

## 4. Excluido por diseño (costo incremental = 0 mientras no se apruebe)

NAT Gateway, ALB, API Gateway, ECS/Fargate, RDS/Aurora, ElastiCache, SQS, EventBridge, OpenSearch, Timestream,
CloudFront, VPN nueva, cuentas/ambientes extra, Secrets Manager (salvo rotación administrada justificada),
VPC Flow Logs, S3 access logs, detailed monitoring de EC2. Agregar cualquiera requiere justificación y costo
incremental registrados aquí y en `docs/decisiones.md` (ESP §18).

## 5. Cómo cotizar en AWS Pricing Calculator

1. Abrir <https://calculator.aws/> → *Create estimate* → seleccionar la REGIÓN de §1.
2. **Amazon EC2**: Linux, `t3.large` (y una segunda estimación con `m7i.large`), On-Demand, 100 % de uso
   mensual (730 h), sin Savings Plans. Para `t3` con `unlimited`, estimar créditos excedentes con el CPU medio
   del benchmark (ARQ §4). EBS raíz: gp3, `R` GiB, sin IOPS/throughput extra.
3. **Amazon EBS** (volumen de datos): gp3, `D` GiB, 3000 IOPS, 125 MiB/s. Snapshots: 0 (solo snapshot final al destruir).
4. **Amazon VPC → Public IPv4 address**: 1 dirección en uso 730 h.
5. **Amazon S3 Standard**: almacenamiento = §3.6 + §3.7 + §3.8; solicitudes PUT/GET mensuales según §3.9;
   transferencia de salida = `E`.
6. **Data Transfer**: egreso a Internet `E` GiB/mes desde la región.
7. **Amazon CloudWatch**: métricas personalizadas (§3 conteos), alarmas estándar (15), Logs: ingesta `L` y
   almacenamiento con retención 14 días, API `PutMetricData` (~43 800/mes).
8. **Amazon SNS** (correo), **AWS Budgets**, **Systems Manager Parameter Store** (Standard),
   **Route 53** (consultas), **KMS** (solo si aplica): agregarlos con su uso esperado aunque resulten mínimos.
9. Guardar y compartir la estimación; copiar el enlace, total mensual, fecha y región en §1, y el detalle por
   partida en §3. Registrar el techo (`monthly_budget_usd`) aprobado por el responsable.
10. IA y canal de notificación se cotizan con la página de precios del proveedor elegido (fuera de AWS).

## 6. Seguimiento

- Tras la primera semana de operación: comparar Cost Explorer (filtro `Project=Katalyst`) con §3 y registrar
  desvíos y causas en §1.
- Revisión mensual: tamaño de instancia vs. CPU/memoria medidos, volumen de evidencia/backups, logs ingeridos.
  No declarar ahorro porcentual sin medición comparativa (RNF-INF-02).
