# Katalyst — bucket S3 del state remoto de Terraform.
# Requisitos: RNF-INF-01, ESP §18 (state S3 privado/cifrado/versionado, use_lockfile, sin DynamoDB,
# prevent_destroy, sin force_destroy), ARQ §5.
#
# Cifrado: por defecto SSE-S3 (AES-256) con bucket key. Justificación (registrar en docs/decisiones.md):
#  - Sin costo mensual de CMK ni cargos por solicitud KMS en cada lectura/escritura/lock del state.
#  - Sin riesgo de perder el state por programar el borrado o deshabilitar una CMK.
#  - El control de acceso real lo dan IAM + bucket policy (TLS-only, principales opcionales).
#  Si la organización exige separación de funciones vía key policy, pasar `state_kms_key_arn`
#  con una CMK existente (SSE-KMS); este root no crea claves KMS.

data "aws_caller_identity" "current" {}

locals {
  bucket_name = coalesce(var.state_bucket_name, "katalyst-tfstate-${var.aws_account_id}-${var.aws_region}")
  use_kms     = var.state_kms_key_arn != null
}

resource "aws_s3_bucket" "state" {
  bucket = local.bucket_name
  # force_destroy queda en su valor por defecto (false) a propósito: nunca borrar el state con objetos.

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.use_kms ? "aws:kms" : "AES256"
      kms_master_key_id = local.use_kms ? var.state_kms_key_arn : null
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  # La versión actual del state nunca expira; solo se acotan versiones no actuales y residuos.
  rule {
    id     = "acotar-versiones-no-actuales"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = var.noncurrent_version_retention_days
      newer_noncurrent_versions = var.noncurrent_versions_to_keep
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "limpiar-marcadores-de-borrado-expirados"
    status = "Enabled"

    filter {}

    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state" {
  statement {
    sid     = "DenegarTransporteInseguro"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid     = "DenegarTLSAntiguo"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }

  dynamic "statement" {
    for_each = length(var.state_admin_principal_arns) > 0 ? [1] : []

    content {
      sid     = "SoloPrincipalesAdministrativos"
      effect  = "Deny"
      actions = ["s3:*"]
      resources = [
        aws_s3_bucket.state.arn,
        "${aws_s3_bucket.state.arn}/*",
      ]

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "StringNotLike"
        variable = "aws:PrincipalArn"
        values = concat(
          var.state_admin_principal_arns,
          ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"],
        )
      }
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}
