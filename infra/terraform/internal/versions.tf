# Katalyst — ambiente único `internal`. Requisitos: RNF-INF-01, ESP §18, ARQ §5.
# Versiones fijadas con `~>` estrecho (solo parches). `.terraform.lock.hcl` versionado con hashes
# para linux_amd64 (CI/host) y darwin_arm64 (estaciones de administración).

terraform {
  required_version = "~> 1.17.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72.0"
    }
  }
}
