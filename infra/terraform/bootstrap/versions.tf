# Katalyst — bootstrap del estado remoto de Terraform.
# Requisitos: RNF-INF-01, ESP §18, ARQ §5.
# Versiones fijadas con `~>` estrecho (solo parches). Subir de minor es un cambio revisado
# que regenera `.terraform.lock.hcl` con `terraform providers lock` (ver ../README.md).

terraform {
  required_version = "~> 1.17.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72.0"
    }
  }
}
