# Katalyst — variables del ambiente `internal`.
# Requisitos: RNF-INF-01/02/03, RNF-SEG-05, RNF-CON-04, ESP §18, ARQ §5.
# Ninguna variable admite secretos: solo identificadores, nombres y prefijos de SSM.

# ---------------------------------------------------------------------------
# Cuenta, región y etiquetas
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "Región AWS de la cuenta existente (PENDIENTE ESP §12)."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region debe ser un código de región AWS válido, por ejemplo us-east-1."
  }
}

variable "aws_account_id" {
  description = "ID (12 dígitos) de la cuenta AWS existente; el provider rechaza otra cuenta."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id debe tener exactamente 12 dígitos."
  }
}

variable "owner" {
  description = "Responsable del ambiente (tag Owner)."
  type        = string

  validation {
    condition     = length(trimspace(var.owner)) > 0
    error_message = "owner no puede estar vacío."
  }
}

variable "cost_center" {
  description = "Centro de costo (tag CostCenter)."
  type        = string

  validation {
    condition     = length(trimspace(var.cost_center)) > 0
    error_message = "cost_center no puede estar vacío."
  }
}

variable "extra_tags" {
  description = "Etiquetas adicionales. No pueden sobrescribir Project/Environment/Owner/CostCenter/ManagedBy."
  type        = map(string)
  default     = {}

  validation {
    condition     = length(setintersection(keys(var.extra_tags), ["Project", "Environment", "Owner", "CostCenter", "ManagedBy"])) == 0
    error_message = "extra_tags no puede redefinir las etiquetas obligatorias."
  }
}

variable "name_prefix" {
  description = "Prefijo de nombres de recursos."
  type        = string
  default     = "katalyst-internal"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix: minúsculas, dígitos y guiones, 3-31 caracteres, empieza con letra."
  }
}

# ---------------------------------------------------------------------------
# Red (ARQ §4: subnet pública + EIP, sin NAT Gateway, HTTPS restringido)
# ---------------------------------------------------------------------------

variable "existing_vpc_id" {
  description = "VPC existente a reutilizar. null = crear VPC/subnet/IGW/rutas propias."
  type        = string
  default     = null

  validation {
    condition     = var.existing_vpc_id == null || can(regex("^vpc-[0-9a-f]{8,17}$", var.existing_vpc_id))
    error_message = "existing_vpc_id debe tener la forma vpc-xxxxxxxx."
  }

  validation {
    condition     = (var.existing_vpc_id == null) == (var.existing_subnet_id == null)
    error_message = "existing_vpc_id y existing_subnet_id se informan juntos o ninguno."
  }
}

variable "existing_subnet_id" {
  description = "Subnet PÚBLICA existente (ruta 0.0.0.0/0 a un Internet Gateway) dentro de existing_vpc_id."
  type        = string
  default     = null

  validation {
    condition     = var.existing_subnet_id == null || can(regex("^subnet-[0-9a-f]{8,17}$", var.existing_subnet_id))
    error_message = "existing_subnet_id debe tener la forma subnet-xxxxxxxx."
  }
}

variable "vpc_cidr" {
  description = "CIDR de la VPC creada (solo si no se reutiliza una existente). No debe solaparse con redes Docker del host."
  type        = string
  default     = "10.80.0.0/24"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 28
    error_message = "vpc_cidr debe ser un CIDR IPv4 válido entre /16 y /28."
  }
}

variable "public_subnet_cidr" {
  description = "CIDR de la subnet pública creada, contenido en vpc_cidr."
  type        = string
  default     = "10.80.0.0/26"

  validation {
    condition     = can(cidrhost(var.public_subnet_cidr, 0))
    error_message = "public_subnet_cidr debe ser un CIDR IPv4 válido."
  }
}

variable "availability_zone" {
  description = "AZ del host y del volumen de datos. null = la subnet existente o la primera AZ que ofrece el tipo de instancia."
  type        = string
  default     = null
}

variable "allowed_cidrs" {
  description = <<-EOT
    CIDRs corporativos autorizados a HTTPS (443). OBLIGATORIO, sin valor por defecto.
    Se rechaza 0.0.0.0/0 y cualquier prefijo más amplio que /8 (ESP §18, ARQ §4).
  EOT
  type        = list(string)

  validation {
    condition     = length(var.allowed_cidrs) > 0
    error_message = "allowed_cidrs debe contener al menos un CIDR corporativo."
  }

  validation {
    condition     = alltrue([for c in var.allowed_cidrs : can(cidrhost(c, 0)) && can(regex("^[0-9.]+/[0-9]+$", c))])
    error_message = "Cada elemento de allowed_cidrs debe ser un CIDR IPv4 válido (a.b.c.d/n)."
  }

  validation {
    condition     = alltrue([for c in var.allowed_cidrs : c != "0.0.0.0/0" && try(tonumber(split("/", c)[1]) >= 8, false)])
    error_message = "allowed_cidrs no admite 0.0.0.0/0 ni prefijos más amplios que /8: el acceso HTTPS debe estar restringido."
  }
}

variable "egress_tcp_ports" {
  description = <<-EOT
    Puertos TCP de salida permitidos hacia Internet (DeltaX, TestRail, SSM, S3, CloudWatch, registros de imágenes,
    repositorios de paquetes, ACME). Agregar 587/465 solo si el canal de notificación elegido es SMTP (ESP §12).
  EOT
  type        = list(number)
  default     = [80, 443]

  validation {
    condition     = length(var.egress_tcp_ports) > 0 && alltrue([for p in var.egress_tcp_ports : p >= 1 && p <= 65535 && floor(p) == p])
    error_message = "egress_tcp_ports debe contener puertos TCP enteros entre 1 y 65535."
  }

  validation {
    condition     = !contains(var.egress_tcp_ports, 22)
    error_message = "No se permite salida SSH (22) por defecto; registrar la necesidad en docs/decisiones.md si aplica."
  }
}

# ---------------------------------------------------------------------------
# Cómputo (ARQ §4: 2 vCPU / 8 GiB x86_64 On-Demand como punto inicial)
# ---------------------------------------------------------------------------

variable "instance_type" {
  description = <<-EOT
    Tipo de instancia x86_64 On-Demand. Punto inicial 2 vCPU/8 GiB:
      - t3.large  (burstable, baseline 30 % por vCPU; ver cpu_credits),
      - m7i.large (no burstable, rendimiento sostenido; mayor costo por hora).
    Redimensionar solo tras benchmark (ARQ §4) y registrar costo en docs/costos.md.
  EOT
  type        = string
  default     = "t3.large"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.instance_type))
    error_message = "instance_type debe tener la forma familia.tamaño; la arquitectura x86_64 se verifica con una precondición."
  }
}

variable "cpu_credits" {
  description = <<-EOT
    Modo de créditos CPU para tipos burstable (t3/t3a): "standard" (costo predecible; se limita al baseline
    al agotar créditos, lo que degrada Chromium y la calidad de muestras DXMon) o "unlimited" (sin
    limitación; cargo adicional por créditos excedentes). Ignorado en tipos no burstable.
  EOT
  type        = string
  default     = "standard"

  validation {
    condition     = contains(["standard", "unlimited"], var.cpu_credits)
    error_message = "cpu_credits debe ser standard o unlimited."
  }
}

variable "ami_id" {
  description = "AMI x86_64 fija (opcional). null = Amazon Linux 2023 vía parámetro público SSM (ami_ssm_parameter)."
  type        = string
  default     = null

  validation {
    condition     = var.ami_id == null || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id debe tener la forma ami-xxxxxxxx."
  }
}

variable "ami_ssm_parameter" {
  description = "Parámetro público SSM con la AMI Amazon Linux 2023 x86_64."
  type        = string
  default     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"

  validation {
    condition     = can(regex("^/aws/service/ami-amazon-linux-latest/al2023-.*x86_64$", var.ami_ssm_parameter))
    error_message = "ami_ssm_parameter debe apuntar a una AMI Amazon Linux 2023 x86_64."
  }
}

variable "root_volume_size_gib" {
  description = "Tamaño del disco de sistema gp3 (SO, Docker, imágenes)."
  type        = number
  default     = 30

  validation {
    condition     = var.root_volume_size_gib >= 20 && var.root_volume_size_gib <= 200
    error_message = "root_volume_size_gib debe estar entre 20 y 200."
  }
}

variable "data_volume_size_gib" {
  description = "Tamaño del volumen EBS gp3 de datos montado en /data (PostgreSQL, Redis AOF, Caddy, temporales)."
  type        = number
  default     = 100

  validation {
    condition     = var.data_volume_size_gib >= 20 && var.data_volume_size_gib <= 2000
    error_message = "data_volume_size_gib debe estar entre 20 y 2000."
  }
}

variable "data_volume_iops" {
  description = "IOPS gp3 del volumen de datos (3000 = baseline incluido; valores mayores tienen costo extra)."
  type        = number
  default     = 3000

  validation {
    condition     = var.data_volume_iops >= 3000 && var.data_volume_iops <= 16000
    error_message = "data_volume_iops debe estar entre 3000 y 16000."
  }
}

variable "data_volume_throughput_mibps" {
  description = "Throughput gp3 del volumen de datos en MiB/s (125 = baseline incluido)."
  type        = number
  default     = 125

  validation {
    condition     = var.data_volume_throughput_mibps >= 125 && var.data_volume_throughput_mibps <= 1000
    error_message = "data_volume_throughput_mibps debe estar entre 125 y 1000."
  }
}

variable "ebs_kms_key_arn" {
  description = "CMK existente para cifrar EBS. null = clave administrada por AWS (aws/ebs)."
  type        = string
  default     = null

  validation {
    condition     = var.ebs_kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.ebs_kms_key_arn))
    error_message = "ebs_kms_key_arn debe ser un ARN de clave KMS."
  }
}

variable "enable_ec2_auto_recovery" {
  description = "Acción de recuperación automática de EC2 ante falla de status check de sistema (conserva EIP/EBS)."
  type        = bool
  default     = true
}

variable "docker_compose_version" {
  description = "Versión del plugin Docker Compose instalada por user-data (binario oficial verificado por SHA-256)."
  type        = string
  default     = "5.7.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.docker_compose_version))
    error_message = "docker_compose_version debe ser semver sin prefijo v (por ejemplo 5.7.0)."
  }
}

variable "docker_compose_sha256" {
  description = "SHA-256 publicado del binario docker-compose-linux-x86_64 de docker_compose_version."
  type        = string
  default     = "7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2"

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.docker_compose_sha256))
    error_message = "docker_compose_sha256 debe ser un hash SHA-256 hexadecimal de 64 caracteres."
  }
}

# ---------------------------------------------------------------------------
# DNS y hostnames (TLS DNS-01 con zona existente; reportes en hostname separado)
# ---------------------------------------------------------------------------

variable "panel_hostname" {
  description = "FQDN del panel/API (mismo origen), por ejemplo katalyst.interno.example.com (PENDIENTE)."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.panel_hostname))
    error_message = "panel_hostname debe ser un FQDN en minúsculas."
  }
}

variable "reports_hostname" {
  description = "FQDN separado del visor de reportes (origen aislado, sin cookies del panel)."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$", var.reports_hostname))
    error_message = "reports_hostname debe ser un FQDN en minúsculas."
  }

  validation {
    condition     = var.reports_hostname != var.panel_hostname
    error_message = "reports_hostname debe ser distinto de panel_hostname (ESP §13.7: origen separado)."
  }
}

variable "route53_zone_id" {
  description = <<-EOT
    ID de una zona Route 53 EXISTENTE (no se crea ni se destruye). Si se informa: registros A opcionales
    (manage_dns_records) y permiso DNS-01 acotado a TXT _acme-challenge de los dos hostnames.
    null = DNS fuera de Route 53; el plugin DNS de Caddy usa su propio token vía SSM (ver deploy/).
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.route53_zone_id == null || can(regex("^Z[A-Z0-9]{5,32}$", var.route53_zone_id))
    error_message = "route53_zone_id debe ser un ID de zona Route 53 (Z...)."
  }
}

variable "manage_dns_records" {
  description = "Crear registros A de panel/reportes hacia la EIP en route53_zone_id."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Almacenamiento y retenciones (ESP §7, §18; ARQ §6)
# ---------------------------------------------------------------------------

variable "s3_kms_key_arn" {
  description = "CMK existente para SSE-KMS de evidencia/backups. null = SSE-S3 (AES-256)."
  type        = string
  default     = null

  validation {
    condition     = var.s3_kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.s3_kms_key_arn))
    error_message = "s3_kms_key_arn debe ser un ARN de clave KMS."
  }
}

variable "evidence_retention_days" {
  description = "Días de retención de evidencia sanitizada en S3 (ESP §7: 30)."
  type        = number
  default     = 30

  validation {
    condition     = var.evidence_retention_days >= 1 && var.evidence_retention_days <= 365
    error_message = "evidence_retention_days debe estar entre 1 y 365."
  }
}

variable "backup_retention_days" {
  description = "Días que se conservan los backups diarios como versión actual (RNF-CON-04: 7)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 90
    error_message = "backup_retention_days debe estar entre 7 y 90 (RNF-CON-04 exige al menos 7)."
  }
}

variable "backup_noncurrent_retention_days" {
  description = "Días adicionales que se conserva una versión no actual de backup (protege contra sobrescritura/borrado)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_noncurrent_retention_days >= 1 && var.backup_noncurrent_retention_days <= 90
    error_message = "backup_noncurrent_retention_days debe estar entre 1 y 90."
  }
}

variable "log_retention_days" {
  description = "Retención del log group de CloudWatch (ESP §18: 14 días)."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days debe ser 1, 3, 5, 7, 14 o 30 (ESP §18 fija 14)."
  }
}

variable "logs_kms_key_arn" {
  description = "CMK existente para el log group (su key policy debe permitir logs.<región>.amazonaws.com). null = cifrado por defecto."
  type        = string
  default     = null

  validation {
    condition     = var.logs_kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.logs_kms_key_arn))
    error_message = "logs_kms_key_arn debe ser un ARN de clave KMS."
  }
}

# ---------------------------------------------------------------------------
# Secretos por referencia (SSM Parameter Store SecureString)
# ---------------------------------------------------------------------------

variable "ssm_parameter_prefix" {
  description = "Prefijo SSM de los parámetros de Katalyst. Terraform solo conoce el prefijo, nunca valores."
  type        = string
  default     = "/katalyst/internal"

  validation {
    condition     = can(regex("^/[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*$", var.ssm_parameter_prefix))
    error_message = "ssm_parameter_prefix debe empezar con / y no terminar en /."
  }
}

variable "ssm_kms_key_arn" {
  description = "CMK con la que se cifran los SecureString. null = aws/ssm (no requiere permiso KMS explícito)."
  type        = string
  default     = null

  validation {
    condition     = var.ssm_kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.ssm_kms_key_arn))
    error_message = "ssm_kms_key_arn debe ser un ARN de clave KMS."
  }
}

# ---------------------------------------------------------------------------
# Alarmas y presupuesto (ARQ §6, ESP §18)
# ---------------------------------------------------------------------------

variable "alarm_contact_emails" {
  description = "Correos suscritos al topic SNS de alarmas (requieren confirmación manual)."
  type        = list(string)

  validation {
    condition     = length(var.alarm_contact_emails) > 0 && alltrue([for e in var.alarm_contact_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "alarm_contact_emails debe contener al menos un correo válido."
  }
}

variable "budget_contact_emails" {
  description = "Correos que reciben las alertas de AWS Budgets."
  type        = list(string)

  validation {
    condition     = length(var.budget_contact_emails) > 0 && length(var.budget_contact_emails) <= 10 && alltrue([for e in var.budget_contact_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "budget_contact_emails debe contener entre 1 y 10 correos válidos."
  }
}

variable "monthly_budget_usd" {
  description = "Techo mensual acordado en USD (PENDIENTE ESP §12; registrar en docs/costos.md antes de apply)."
  type        = number

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd debe ser mayor que 0."
  }
}

variable "budget_filter_by_project_tag" {
  description = <<-EOT
    true = el budget filtra por la etiqueta Project=Katalyst (requiere activarla como cost allocation tag).
    false = el budget cubre toda la cuenta (solo si la cuenta es exclusiva de Katalyst).
  EOT
  type        = bool
  default     = true
}

variable "cpu_alarm_threshold_percent" {
  description = "Umbral de CPU promedio sostenida (15 min) para alarma."
  type        = number
  default     = 85

  validation {
    condition     = var.cpu_alarm_threshold_percent > 0 && var.cpu_alarm_threshold_percent <= 100
    error_message = "cpu_alarm_threshold_percent debe estar entre 1 y 100."
  }
}

variable "cpu_credit_balance_alarm_threshold" {
  description = "Saldo mínimo de CPU credits (solo burstable) antes de alarmar."
  type        = number
  default     = 50
}

variable "memory_available_alarm_percent" {
  description = "Alarma de memoria baja cuando mem_available_percent cae por debajo de este valor."
  type        = number
  default     = 10

  validation {
    condition     = var.memory_available_alarm_percent > 0 && var.memory_available_alarm_percent < 50
    error_message = "memory_available_alarm_percent debe estar entre 1 y 49."
  }
}

variable "backup_max_age_hours" {
  description = "Edad máxima del último backup exitoso antes de alarmar (ARQ §6: 26 h)."
  type        = number
  default     = 26

  validation {
    condition     = var.backup_max_age_hours >= 24 && var.backup_max_age_hours <= 48
    error_message = "backup_max_age_hours debe estar entre 24 y 48."
  }
}

variable "queue_oldest_waiting_alarm_seconds" {
  description = "Alarma de cola atrasada: antigüedad máxima tolerada de la corrida más vieja en_cola."
  type        = number
  default     = 1800

  validation {
    condition     = var.queue_oldest_waiting_alarm_seconds >= 60
    error_message = "queue_oldest_waiting_alarm_seconds debe ser al menos 60."
  }
}
