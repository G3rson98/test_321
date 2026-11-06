# Terraform de Katalyst — ambiente único `internal`

Requisitos: RNF-INF-01/02/03, RNF-SEG-03/05, RNF-CON-04, ESP §18, ARQ §5–§7. Diagrama y mapeo
requisito→recurso: [`docs/infraestructura.md`](../../docs/infraestructura.md). Operación del host:
[`docs/operacion.md`](../../docs/operacion.md). Estimación de costos: [`docs/costos.md`](../../docs/costos.md).

> Esta carpeta **no** ha sido aplicada contra AWS. Antes del primer `apply` deben estar resueltas las decisiones
> de ESP §12 (región, techo mensual, CIDRs, dominio/zona, contactos) y registrada la estimación en `docs/costos.md`.

## 1. Estructura

```text
infra/terraform/
  bootstrap/                 # bucket S3 del state (privado, cifrado, versionado, TLS-only, prevent_destroy)
    backend.tf.example       # paso 2: migrar el state del bootstrap a la clave katalyst/bootstrap/
  internal/                  # ÚNICO root/estado de aplicación: katalyst/internal/terraform.tfstate
    backend.tf               # backend S3 parcial, use_lockfile = true, sin DynamoDB
    backend.hcl.example      # bucket/región del state (no secretos)
    versions.tf providers.tf # Terraform ~> 1.17.0, AWS ~> 6.72.0, default_tags
    main.tf                  # datos y locales compartidos (índice de archivos por dominio)
    network.tf security.tf compute.tf iam.tf storage.tf monitoring.tf budget.tf dns.tf
    templates/user-data.sh.tftpl
    variables.tf outputs.tf terraform.tfvars.example
    tests/plan_offline.tftest.hcl   # pruebas con provider simulado (sin AWS)
```

Sin workspaces por rama, sin copias staging/prod. No se aprovisionan ALB, API Gateway, ECS/Fargate, RDS/Aurora,
ElastiCache, SQS, EventBridge, OpenSearch, Timestream, CloudFront ni NAT Gateway (ESP §18).

### Variables obligatorias (`internal`)

| Variable | Descripción | Estado |
| --- | --- | --- |
| `aws_region`, `aws_account_id` | Cuenta y región existentes; el provider rechaza otra cuenta | PENDIENTE ESP §12 |
| `owner`, `cost_center` | Tags `Owner` / `CostCenter` | PENDIENTE |
| `allowed_cidrs` | CIDRs corporativos para HTTPS; sin default, rechaza `0.0.0.0/0` y prefijos < /8 | PENDIENTE |
| `panel_hostname`, `reports_hostname` | FQDN del panel/API y del visor de reportes (deben ser distintos) | PENDIENTE |
| `alarm_contact_emails` | Suscriptores SNS de alarmas | PENDIENTE |
| `budget_contact_emails` | Destinatarios de AWS Budgets | PENDIENTE |
| `monthly_budget_usd` | Techo mensual acordado | PENDIENTE (registrar en costos.md) |

Opcionales relevantes: `existing_vpc_id`/`existing_subnet_id` (juntos), `route53_zone_id` (zona existente:
registros A + permiso DNS-01 acotado), `instance_type` (`t3.large` por defecto; `m7i.large` alternativa no
burstable), `cpu_credits`, `ami_id`, tamaños de disco, CMKs opcionales (`*_kms_key_arn`), retenciones.

Bootstrap: `aws_region`, `aws_account_id`, `owner`, `cost_center` obligatorias; `state_kms_key_arn` y
`state_admin_principal_arns` opcionales.

### Cifrado del state (decisión)

El bucket de state usa **SSE-S3 (AES-256) con bucket key** por defecto: sin costo de CMK ni de solicitudes KMS
por cada lectura/escritura/lock, y sin riesgo de perder el state por deshabilitar o programar el borrado de una
clave. El control de acceso lo dan IAM y la bucket policy (TLS ≥ 1.2 obligatorio y, opcionalmente, lista cerrada
de principales con `state_admin_principal_arns`). Si la organización exige separación de funciones por key
policy, pasar una CMK **existente** en `state_kms_key_arn` (SSE-KMS). Lo mismo aplica a evidencia/backups
(`s3_kms_key_arn`).

## 2. Bootstrap del state (una sola vez, identidad administrativa temporal)

```bash
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars        # completar; NO versionar
terraform init                                       # state local SOLO en este paso
terraform plan -out=bootstrap.tfplan
terraform show bootstrap.tfplan                      # revisar: 1 bucket + controles, sin destroy
terraform apply bootstrap.tfplan
```

Migrar el state del bootstrap a su **clave administrativa separada** (`katalyst/bootstrap/terraform.tfstate`):

```bash
cp backend.tf.example backend.tf                     # reemplazar <STATE_BUCKET> y <REGION>
terraform init -migrate-state                        # responder "yes" a copiar el state
terraform state list                                 # debe listar los recursos del bucket
aws s3api head-object --bucket <STATE_BUCKET> --key katalyst/bootstrap/terraform.tfstate
shred -u terraform.tfstate terraform.tfstate.backup bootstrap.tfplan 2>/dev/null || rm -f terraform.tfstate terraform.tfstate.backup bootstrap.tfplan
```

Restringir por IAM `katalyst/bootstrap/*` a administradores; el rol de CI de la aplicación solo necesita
`katalyst/internal/*`. Política mínima sugerida para el rol de CI/plan del root `internal`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<STATE_BUCKET>",
      "Condition": { "StringLike": { "s3:prefix": ["katalyst/internal/*"] } } },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::<STATE_BUCKET>/katalyst/internal/terraform.tfstate*" },
    { "Effect": "Allow", "Action": "s3:DeleteObject",
      "Resource": "arn:aws:s3:::<STATE_BUCKET>/katalyst/internal/terraform.tfstate.tflock" }
  ]
}
```

(Un rol de solo plan puede omitir `PutObject` del state pero necesita escribir/borrar el `.tflock`.)

## 3. Inicializar el root `internal`

```bash
cd infra/terraform/internal
cp backend.hcl.example backend.hcl                   # valores de la salida backend_config_internal
cp terraform.tfvars.example terraform.tfvars         # completar; NO versionar (sin secretos igualmente)
terraform init -backend-config=backend.hcl
```

`.terraform.lock.hcl` está versionado con hashes para `linux_amd64` y `darwin_arm64`. Para subir de versión:
editar `versions.tf` y ejecutar `terraform init -upgrade && terraform providers lock -platform=linux_amd64
-platform=darwin_arm64`, revisar el diff del lockfile y pasar por PR.

## 4. Plan revisado y apply solo de ese plan

```bash
terraform fmt -check -recursive ..                   # CI
terraform validate                                   # CI
terraform test                                       # CI (provider simulado, sin AWS)
terraform plan -out=internal.tfplan                  # identidad temporal (SSO / OIDC)
terraform show -no-color internal.tfplan > internal.plan.txt   # para revisión; es SENSIBLE
terraform apply internal.tfplan                      # solo el plan aprobado, nunca `apply` directo
```

Reglas (ESP §18, ARQ §5):

- CI ejecuta `fmt -check`, `validate`, `test` y `plan` con rol temporal OIDC; **no** aplica al abrir un PR.
  El apply lo dispara una aprobación explícita sobre el artefacto de plan exacto (`apply <plan>`), con el
  lock del backend (`use_lockfile`) y concurrencia del pipeline limitada a 1.
- State, planes (`*.tfplan`, `*.plan.txt`) y `crash.log` son sensibles: nunca a Git ni a artefactos públicos;
  si CI los guarda, que sea en almacenamiento privado cifrado con retención corta.
- Revisar en cada plan: ningún `destroy`/`replace` de `aws_ebs_volume.data`, `aws_eip.host`, buckets o log
  group; ninguna regla de entrada distinta de 443 desde `allowed_cidrs`; ningún servicio de la lista excluida.
- Cambios destructivos requieren backup verificado reciente (`docs/operacion.md` §2) y plan explícito.

Después del primer apply:

1. Confirmar las suscripciones SNS recibidas por correo (las alarmas no notifican hasta confirmar).
2. Activar `Project` como *cost allocation tag* en Billing (si `budget_filter_by_project_tag = true`).
3. Cargar los parámetros SSM (fuera de Terraform; ver §5).
4. Desplegar la aplicación (`docs/operacion.md` §11): Terraform no despliega Compose ni usa `remote-exec`.
5. Ejecutar y registrar la primera prueba de restauración antes de operar (RNF-CON-04).

## 5. Secretos: solo referencias SSM

Terraform conoce el prefijo (`ssm_parameter_prefix`, por defecto `/katalyst/internal`) y concede lectura al rol
del host bajo ese prefijo; nunca crea ni lee valores. Carga inicial desde una estación administrativa con
identidad temporal; el valor entra por stdin, no por argumentos:

```bash
P=/katalyst/internal
openssl rand -hex 32 | aws ssm put-parameter --name "$P/host/postgres_password" --type SecureString --value file:///dev/stdin
openssl rand -hex 32 | aws ssm put-parameter --name "$P/host/redis_password"    --type SecureString --value file:///dev/stdin
# Clave pública GPG de backups (String). La privada se genera y custodia FUERA del host (gestor de secretos del equipo).
gpg --armor --export katalyst-backups@example.com | aws ssm put-parameter --name "$P/backup/gpg_public_key" --type String --value file:///dev/stdin
```

Los secretos de aplicación (sesión del panel, API key de TestRail, token del supervisor, usuarios de prueba,
proveedor IA, token DNS si no es Route 53) se cargan igual bajo `$P/app/...` / `$P/test-users/...` y la app los
lee por `secret_ref` con `SecretProvider=ssm`. Rotación: `docs/operacion.md` §7.

## 6. Recuperación preservando EIP, EBS de datos y buckets

Recursos con `prevent_destroy`: bucket de state, `aws_s3_bucket.evidence`, `aws_s3_bucket.backups`,
`aws_ebs_volume.data`, `aws_eip.host`. Ningún bucket usa `force_destroy`.

| Escenario | Procedimiento |
| --- | --- |
| Falla de hardware/hipervisor | Alarma `ec2-status-check-system` ejecuta la acción `recover`: misma instancia, misma EIP y EBS. |
| SO dañado / AMI nueva / cambio de tipo | `terraform plan -replace=aws_instance.host -out=r.tfplan` → revisar que solo se reemplazan instancia, `aws_volume_attachment.data` y `aws_eip_association.host` → `terraform apply r.tfplan`. user-data monta el volumen existente sin reformatear; luego `install-host.sh` + `deploy.sh` (operacion.md §11). |
| Volumen de datos corrupto | Restaurar PostgreSQL desde el último backup S3 sobre el mismo volumen (operacion.md §3). |
| Pérdida de la AZ | El EBS está ligado a su AZ. `terraform state rm aws_ebs_volume.data aws_volume_attachment.data` (el volumen viejo queda en AWS, no se borra), fijar `availability_zone` (y subnet si es existente), plan/apply crea volumen y host nuevos; restaurar desde S3 (operacion.md §3). Retirar el volumen viejo manualmente cuando la AZ vuelva. |
| Borrado accidental en S3 | Backups con versionado: recuperar la versión no actual (retención `backup_noncurrent_retention_days`); el rol del host no puede borrar backups. |

Ensayar el reemplazo de instancia con datos de prueba antes de uso real (ARQ §5) y registrar duración (RTO).

## 7. Rotación y mantenimiento de la infraestructura

- **Credenciales**: no hay AWS keys; humanos con SSO, CI con OIDC (sesiones ≤ 1 h). El rol del host usa
  credenciales temporales del instance profile.
- **Versiones**: Terraform/provider se suben por PR con lockfile regenerado; `docker_compose_version` y su
  `docker_compose_sha256` se actualizan juntos (el cambio de user-data detiene/arranca la instancia: planificar).
- **AMI**: `ignore_changes = [ami]` evita reemplazos sorpresa; parches mensuales con `dnf` (operacion.md §6) y
  reemplazo planificado con `-replace` cuando se requiera una AMI nueva.
- **Retiro de Katalyst**: quitar `prevent_destroy` en un PR revisado, vaciar buckets de forma deliberada tras
  exportar lo que deba conservarse, y destruir. Zona DNS, VPC/subnet existentes y CMKs no se destruyen (solo
  referencias).

## 8. Costos y presupuesto

AWS Budgets mensual con avisos de gasto real 50/80/100 % y pronóstico 100 % a `budget_contact_emails`; avisa,
no corta. Tags `Project=Katalyst`, `Environment=internal`, `Owner`, `CostCenter`, `ManagedBy=Terraform` en todos
los recursos vía `default_tags`. Estimación y techo: `docs/costos.md` (debe completarse antes del primer apply).

## 9. Pruebas offline

```bash
cd infra/terraform/internal
terraform init -backend=false
terraform validate
terraform test        # mock_provider: IMDSv2 hop 1, discos cifrados, SG 443, alarmas, budget, validaciones
```

## 10. Checklist de aceptación (ARQ §7)

| # | Criterio | Cómo se verifica | Estado |
| --- | --- | --- | --- |
| 1 | Un root/estado `internal`, sin copias staging/prod ni servicios omitidos | `terraform state list` (sin ALB/ECS/RDS/…); un solo key `katalyst/internal/` en el bucket | [ ] |
| 2 | Plan validado; estimación/techo registrados; credenciales temporales; secretos fuera de config/state | CI fmt/validate/test/plan; `docs/costos.md` completo; `terraform show -json` sin valores de SSM; tfvars sin secretos | [ ] |
| 3 | HTTPS restringido; BD/Redis/SSH/Docker/IMDS inaccesibles; secretos por asignación probados | `smoke-test.sh --external` desde CIDR permitido y fallo desde uno no permitido; `smoke-test.sh --host` (sonda de runner-net) | [ ] |
| 4 | Un navegador, 5.000 casos y 10 usuarios cumplen objetivos del panel | Ensayo RNF-REN-01 con métricas de host registradas (operacion.md §10) | [ ] |
| 5 | Restauración y reconstrucción de cola probadas; datos/buckets sobreviven reemplazo; retenciones/cuotas funcionan | `restore-postgres.sh` (bitácora operacion.md §3); `-replace=aws_instance.host` ensayado; lifecycle S3 verificado; cuotas 250 MiB/1 GiB | [ ] |
| 6 | Reinicio sin duplicaciones ni ráfagas; IA respeta presupuesto; evidencia no borra resultados | Reinicio de host con cron activo; pruebas de reconciliación de la app | [ ] |
