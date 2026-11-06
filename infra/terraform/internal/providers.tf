# Katalyst — provider AWS del ambiente `internal`. Requisitos: RNF-INF-01, RNF-INF-02 (tags), ESP §18.
# Sin AWS keys en variables: humanos con SSO/identidad temporal; CI con OIDC/rol temporal.

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = merge(var.extra_tags, {
      Project     = "Katalyst"
      Environment = "internal"
      Owner       = var.owner
      CostCenter  = var.cost_center
      ManagedBy   = "Terraform"
    })
  }
}
