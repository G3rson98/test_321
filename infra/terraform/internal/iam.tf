# Katalyst — rol e instance profile del host con permisos mínimos.
# Requisitos: RNF-SEG-01, RNF-SEG-05, RNF-INF-01, ESP §13.7, §18, ARQ §4/§5.
#
# - Session Manager con política propia equivalente a AmazonSSMManagedInstanceCore SIN
#   ssm:GetParameter(s) sobre "*": la lectura de parámetros queda acotada al prefijo de Katalyst.
# - S3 acotado a los buckets de evidencia y backups (backups: sin borrado).
# - CloudWatch: métricas solo en los namespaces CWAgent/Katalyst; logs solo en el log group del host.
# - Route 53 (opcional): solo registros TXT _acme-challenge de los dos hostnames (DNS-01).
# Una EC2 no ofrece aislamiento IAM por contenedor (ARQ §4): los ejecutores de tests NO reciben
# estas credenciales (IMDS hop limit 1 + bloqueo de red; ver deploy/).

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name                 = "${var.name_prefix}-host"
  description          = "Rol del host único de Katalyst (internal)"
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume.json
  max_session_duration = 3600
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name_prefix}-host"
  role = aws_iam_role.host.name
}

# --- Session Manager / Run Command / Patch Manager (sin lectura global de parámetros) ---
data "aws_iam_policy_document" "ssm_managed_instance" {
  statement {
    sid = "SsmAgentCore"
    actions = [
      "ssm:DescribeAssociation",
      "ssm:GetDeployablePatchSnapshotForInstance",
      "ssm:GetDocument",
      "ssm:DescribeDocument",
      "ssm:GetManifest",
      "ssm:ListAssociations",
      "ssm:ListInstanceAssociations",
      "ssm:PutInventory",
      "ssm:PutComplianceItems",
      "ssm:PutConfigurePackageResult",
      "ssm:UpdateAssociationStatus",
      "ssm:UpdateInstanceAssociationStatus",
      "ssm:UpdateInstanceInformation",
    ]
    resources = ["*"]
  }

  statement {
    sid = "SessionManagerChannels"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }

  statement {
    sid = "RunCommandMessages"
    actions = [
      "ec2messages:AcknowledgeMessage",
      "ec2messages:DeleteMessage",
      "ec2messages:FailMessage",
      "ec2messages:GetEndpoint",
      "ec2messages:GetMessages",
      "ec2messages:SendReply",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ssm_managed_instance" {
  name   = "ssm-managed-instance"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.ssm_managed_instance.json
}

# --- Lectura de SSM Parameter Store bajo el prefijo de Katalyst ---
data "aws_iam_policy_document" "ssm_parameters" {
  statement {
    sid = "LeerParametrosKatalyst"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      local.ssm_prefix_arn,
      "${local.ssm_prefix_arn}/*",
    ]
  }

  dynamic "statement" {
    for_each = var.ssm_kms_key_arn != null ? [1] : []
    content {
      sid       = "DescifrarSecureStringConCmk"
      actions   = ["kms:Decrypt"]
      resources = [var.ssm_kms_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["ssm.${var.aws_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "ssm_parameters" {
  name   = "ssm-parameters-katalyst"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.ssm_parameters.json
}

# --- S3: evidencia (lectura/escritura/borrado por limpieza) y backups (sin borrado) ---
data "aws_iam_policy_document" "s3" {
  statement {
    sid       = "EvidenciaListar"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.evidence.arn]
  }

  statement {
    sid = "EvidenciaObjetos"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.evidence.arn}/*"]
  }

  statement {
    sid       = "BackupsListar"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }

  statement {
    sid = "BackupsObjetosSinBorrado"
    actions = [
      "s3:GetObject",
      "s3:GetObjectAttributes",
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]
    resources = ["${aws_s3_bucket.backups.arn}/${local.backup_object_prefix}*"]
  }

  dynamic "statement" {
    for_each = var.s3_kms_key_arn != null ? [1] : []
    content {
      sid       = "CmkS3"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [var.s3_kms_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${var.aws_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "s3" {
  name   = "s3-evidence-backups"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.s3.json
}

# --- CloudWatch: métricas acotadas por namespace y logs del log group del host ---
data "aws_iam_policy_document" "cloudwatch" {
  statement {
    sid       = "MetricasAcotadas"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CWAgent", local.metrics_namespace]
    }
  }

  statement {
    sid = "LogsDelHost"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
      "logs:PutRetentionPolicy",
    ]
    resources = [
      aws_cloudwatch_log_group.host.arn,
      "${aws_cloudwatch_log_group.host.arn}:*",
    ]
  }

  statement {
    sid       = "AgenteDescribe"
    actions   = ["ec2:DescribeTags", "ec2:DescribeVolumes"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "cloudwatch" {
  name   = "cloudwatch-agent-katalyst"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.cloudwatch.json
}

# --- Route 53 DNS-01 (opcional) acotado a TXT _acme-challenge de los dos hostnames ---
data "aws_iam_policy_document" "acme_dns01" {
  count = var.route53_zone_id != null ? 1 : 0

  statement {
    sid       = "Dns01TxtAcotado"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:${local.partition}:route53:::hostedzone/${var.route53_zone_id}"]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["TXT"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values = [
        "_acme-challenge.${var.panel_hostname}",
        "_acme-challenge.${var.reports_hostname}",
      ]
    }
  }

  statement {
    sid       = "Dns01LeerZona"
    actions   = ["route53:ListResourceRecordSets"]
    resources = ["arn:${local.partition}:route53:::hostedzone/${var.route53_zone_id}"]
  }

  statement {
    sid       = "Dns01EstadoCambio"
    actions   = ["route53:GetChange"]
    resources = ["arn:${local.partition}:route53:::change/*"]
  }

  statement {
    sid       = "Dns01BuscarZona"
    actions   = ["route53:ListHostedZonesByName"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "acme_dns01" {
  count = var.route53_zone_id != null ? 1 : 0

  name   = "route53-acme-dns01"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.acme_dns01[0].json
}
