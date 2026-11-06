# Katalyst — almacenamiento S3 (evidencia y backups, buckets separados del state) y log group.
# Requisitos: RNF-SEG-05 (privado, URLs firmadas ≤5 min), RNF-CON-04 (backup diario 7 días),
# RNF-INF-02 (retenciones), ESP §7, §13.7, §18, ARQ §6.
#
# Cifrado: SSE-S3 (AES-256) por defecto, sin costo de KMS por solicitud y compatible con URLs firmadas
# sin permisos KMS adicionales; SSE-KMS con CMK existente vía s3_kms_key_arn.
# Clase STANDARD sin transiciones: los objetos son de vida corta (ARQ §6: no archivar en clases con
# permanencia mínima que encarezca la eliminación).

locals {
  s3_sse_algorithm = var.s3_kms_key_arn != null ? "aws:kms" : "AES256"

  cors_origins = [
    "https://${var.panel_hostname}",
    "https://${var.reports_hostname}",
  ]
}

# ===========================================================================
# Evidencia sanitizada (30 días)
# ===========================================================================

resource "aws_s3_bucket" "evidence" {
  bucket = local.evidence_bucket_name

  tags = {
    Name    = local.evidence_bucket_name
    Purpose = "evidencia-sanitizada"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.s3_sse_algorithm
      kms_master_key_id = var.s3_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  rule {
    id     = "expirar-evidencia"
    status = "Enabled"

    filter {}

    expiration {
      days = var.evidence_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# CORS mínimo: solo lectura (GET/HEAD) desde el panel y el visor de reportes, para descargas por URL
# firmada iniciadas con fetch(). Las cargas del ejecutor usan URL firmada servidor a servidor (sin CORS).
resource "aws_s3_bucket_cors_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = local.cors_origins
    allowed_headers = ["Range"]
    expose_headers  = ["Content-Length", "Content-Range", "Content-Type", "ETag"]
    max_age_seconds = 300
  }
}

data "aws_iam_policy_document" "evidence" {
  statement {
    sid       = "DenegarTransporteInseguro"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]

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
    sid       = "DenegarTLSAntiguo"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]

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

  # RNF-SEG-05: URLs firmadas de máximo 5 minutos (300 000 ms desde la firma SigV4).
  statement {
    sid       = "DenegarUrlFirmadaMayorA5Min"
    effect    = "Deny"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.evidence.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:authType"
      values   = ["REST-QUERY-STRING"]
    }

    condition {
      test     = "NumericGreaterThan"
      variable = "s3:signatureAge"
      values   = ["300000"]
    }
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket     = aws_s3_bucket.evidence.id
  policy     = data.aws_iam_policy_document.evidence.json
  depends_on = [aws_s3_bucket_public_access_block.evidence]
}

# ===========================================================================
# Backups de PostgreSQL (7 días diarios + versiones no actuales acotadas)
# ===========================================================================

resource "aws_s3_bucket" "backups" {
  bucket = local.backups_bucket_name

  tags = {
    Name    = local.backups_bucket_name
    Purpose = "backups-postgresql"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.s3_sse_algorithm
      kms_master_key_id = var.s3_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  # La versión actual expira a los N días (crea marcador de borrado); la versión pasa a no actual y se
  # conserva backup_noncurrent_retention_days más. La alarma de backup > 26 h avisa mucho antes de que
  # la falta de backups nuevos pueda vaciar la ventana recuperable.
  rule {
    id     = "retencion-backups-diarios"
    status = "Enabled"

    filter {
      prefix = local.backup_object_prefix
    }

    expiration {
      days = var.backup_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.backup_noncurrent_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "limpiar-marcadores-de-borrado"
    status = "Enabled"

    filter {}

    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

data "aws_iam_policy_document" "backups" {
  statement {
    sid       = "DenegarTransporteInseguro"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]

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
    sid       = "DenegarTLSAntiguo"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]

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

  # Un host comprometido no puede borrar backups ni suspender el versionado.
  statement {
    sid    = "DenegarBorradoDesdeHost"
    effect = "Deny"
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:PutBucketVersioning",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
    ]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.host.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket     = aws_s3_bucket.backups.id
  policy     = data.aws_iam_policy_document.backups.json
  depends_on = [aws_s3_bucket_public_access_block.backups]
}

# ===========================================================================
# CloudWatch Logs (14 días)
# ===========================================================================

resource "aws_cloudwatch_log_group" "host" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}
