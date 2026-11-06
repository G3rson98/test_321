# Katalyst — backend remoto del único estado de aplicación. Requisitos: RNF-INF-01, ESP §18, ARQ §5.
#
# Configuración parcial: `bucket` y `region` se pasan con `-backend-config=backend.hcl`
# (copiar backend.hcl.example). La key es fija: un solo estado `katalyst/internal/terraform.tfstate`,
# sin workspaces por rama.
#
# Locking: `use_lockfile = true` (lock nativo de S3 con escritura condicional). No se usa DynamoDB.
# State, planes y crash logs son sensibles: nunca a Git ni a artefactos públicos de CI.

terraform {
  backend "s3" {
    key          = "katalyst/internal/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
