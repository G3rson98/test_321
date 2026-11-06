# Katalyst — ambiente único `internal`: datos compartidos y locales.
# Requisitos: RNF-INF-01/02/03, ESP §18, ARQ §5.
#
# Organización por dominio:
#   network.tf    VPC/subnet/IGW/rutas o referencias existentes
#   security.tf   security group (HTTPS solo desde allowed_cidrs, sin SSH)
#   compute.tf    EC2 x86_64 On-Demand, EBS de datos, EIP, user-data
#   iam.tf        rol/instance profile con permisos mínimos
#   storage.tf    buckets S3 de evidencia y backups, log group
#   monitoring.tf SNS y alarmas CloudWatch
#   budget.tf     AWS Budgets mensual
#   dns.tf        registros Route 53 opcionales sobre zona existente
#
# Fuera de alcance por diseño (ESP §18): ALB, API Gateway, ECS/Fargate, RDS/Aurora, ElastiCache,
# SQS, EventBridge, OpenSearch, Timestream, CloudFront, NAT Gateway, cuentas/ambientes extra.

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_ec2_instance_type" "host" {
  instance_type = var.instance_type
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  burstable = data.aws_ec2_instance_type.host.burstable_performance_supported

  evidence_bucket_name = "${var.name_prefix}-evidence-${var.aws_account_id}-${var.aws_region}"
  backups_bucket_name  = "${var.name_prefix}-backups-${var.aws_account_id}-${var.aws_region}"
  log_group_name       = "/katalyst/internal/host"

  ssm_prefix_arn = "arn:${local.partition}:ssm:${var.aws_region}:${var.aws_account_id}:parameter${var.ssm_parameter_prefix}"

  # Prefijos de objeto en el bucket de backups (los scripts de deploy/ los usan).
  backup_object_prefix = "postgres/"

  # Espacio de nombres de métricas propias publicadas por deploy/scripts/publish-metrics.sh.
  metrics_namespace = "Katalyst"
}
