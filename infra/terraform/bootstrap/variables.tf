# Katalyst — variables del bootstrap del state. Requisitos: RNF-INF-01, RNF-INF-02, ESP §18.
# Ninguna variable contiene secretos.

variable "aws_region" {
  description = "Región AWS de la cuenta existente (PENDIENTE ESP §12). Debe coincidir con la del root internal."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region debe ser un código de región AWS válido, por ejemplo us-east-1."
  }
}

variable "aws_account_id" {
  description = "ID (12 dígitos) de la cuenta AWS existente. El provider rechaza operar sobre otra cuenta."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id debe tener exactamente 12 dígitos."
  }
}

variable "owner" {
  description = "Responsable del ambiente (tag Owner), por ejemplo un alias de equipo."
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

variable "state_bucket_name" {
  description = "Nombre del bucket de state. Si es null se usa katalyst-tfstate-<cuenta>-<región>."
  type        = string
  default     = null

  validation {
    condition     = var.state_bucket_name == null || can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name debe ser un nombre de bucket S3 válido (minúsculas, 3-63 caracteres)."
  }
}

variable "state_kms_key_arn" {
  description = <<-EOT
    ARN de una clave KMS administrada por el cliente YA EXISTENTE para SSE-KMS del state.
    null (por defecto) = SSE-S3 (AES-256). Ver README: justificación de la elección.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.state_kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/.+$", var.state_kms_key_arn))
    error_message = "state_kms_key_arn debe ser un ARN de clave KMS (arn:aws:kms:<región>:<cuenta>:key/<id>)."
  }
}

variable "state_admin_principal_arns" {
  description = <<-EOT
    Opcional. Patrones de ARN (se admite *) de los principales autorizados a usar el bucket de state
    (roles SSO administrativos y rol OIDC de CI). Si la lista no está vacía, la bucket policy niega
    cualquier otro principal. Lista vacía = acceso gobernado solo por IAM. Cuidado: una lista
    incorrecta puede bloquear el acceso; incluir siempre el rol administrativo con el que se aplica.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for p in var.state_admin_principal_arns : can(regex("^arn:aws[a-z-]*:(iam|sts)::[0-9]{12}:", p))])
    error_message = "Cada elemento debe ser un ARN IAM/STS de la cuenta (por ejemplo arn:aws:iam::123456789012:role/...)."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Días que se conservan versiones no actuales del state antes de expirar."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 30 && var.noncurrent_version_retention_days <= 365
    error_message = "noncurrent_version_retention_days debe estar entre 30 y 365."
  }
}

variable "noncurrent_versions_to_keep" {
  description = "Número de versiones no actuales más recientes que se conservan siempre, aunque superen la antigüedad."
  type        = number
  default     = 20

  validation {
    condition     = var.noncurrent_versions_to_keep >= 5 && var.noncurrent_versions_to_keep <= 100
    error_message = "noncurrent_versions_to_keep debe estar entre 5 y 100."
  }
}
