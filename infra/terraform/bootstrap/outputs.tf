# Katalyst — salidas del bootstrap (sin secretos). Requisitos: RNF-INF-01.

output "state_bucket_name" {
  description = "Bucket del state remoto. Usar en internal/backend.hcl y bootstrap/backend.tf."
  value       = aws_s3_bucket.state.bucket
}

output "state_bucket_arn" {
  description = "ARN del bucket del state (para políticas IAM mínimas de administradores y CI)."
  value       = aws_s3_bucket.state.arn
}

output "state_encryption" {
  description = "Algoritmo de cifrado por defecto del bucket."
  value       = local.use_kms ? "aws:kms" : "AES256"
}

output "backend_config_internal" {
  description = "Contenido sugerido para infra/terraform/internal/backend.hcl."
  value       = <<-EOT
    bucket = "${aws_s3_bucket.state.bucket}"
    region = "${var.aws_region}"
  EOT
}
