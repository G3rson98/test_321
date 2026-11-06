# Katalyst — salidas del ambiente `internal`. Requisitos: RNF-INF-01.
# Sin secretos: solo identificadores, nombres y ARNs.

output "instance_id" {
  description = "ID de la instancia EC2 (administración: aws ssm start-session --target <id>)."
  value       = aws_instance.host.id
}

output "public_ip" {
  description = "EIP del host: IPv4 de entrada HTTPS y de salida estable (allowlist en DeltaX/TestRail)."
  value       = aws_eip.host.public_ip
}

output "availability_zone" {
  description = "AZ del host y del volumen de datos."
  value       = local.availability_zone
}

output "data_volume_id" {
  description = "Volumen EBS de datos (/data). Protegido con prevent_destroy."
  value       = aws_ebs_volume.data.id
}

output "security_group_id" {
  description = "Security group del host."
  value       = aws_security_group.host.id
}

output "vpc_id" {
  description = "VPC usada (creada o existente)."
  value       = local.vpc_id
}

output "subnet_id" {
  description = "Subnet pública usada (creada o existente)."
  value       = local.subnet_id
}

output "host_role_arn" {
  description = "ARN del rol del host."
  value       = aws_iam_role.host.arn
}

output "evidence_bucket" {
  description = "Bucket privado de evidencia sanitizada."
  value       = aws_s3_bucket.evidence.bucket
}

output "backups_bucket" {
  description = "Bucket privado de backups de PostgreSQL."
  value       = aws_s3_bucket.backups.bucket
}

output "log_group_name" {
  description = "Log group de CloudWatch del host (14 días)."
  value       = aws_cloudwatch_log_group.host.name
}

output "alarm_topic_arn" {
  description = "Topic SNS de alarmas (las suscripciones por correo requieren confirmación)."
  value       = aws_sns_topic.alarms.arn
}

output "ssm_parameter_prefix" {
  description = "Prefijo SSM donde se cargan los SecureString fuera de Terraform."
  value       = var.ssm_parameter_prefix
}

output "panel_url" {
  description = "URL del panel."
  value       = "https://${var.panel_hostname}"
}

output "reports_url" {
  description = "URL base del visor de reportes (origen separado)."
  value       = "https://${var.reports_hostname}"
}

output "ssm_session_command" {
  description = "Comando para abrir una sesión administrativa sin SSH."
  value       = "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.host.id}"
}
