# Katalyst — presupuesto mensual. Requisitos: RNF-INF-02, ESP §18, ARQ §5/§6.
# Avisos: gasto real 50/80/100 % y pronóstico 100 %. El budget AVISA, no detiene la facturación ni
# reemplaza los límites de IA/cuotas por corrida.
#
# Con budget_filter_by_project_tag=true, la etiqueta `Project` debe estar activada como
# cost allocation tag en Billing (puede tardar hasta 24 h en reflejarse); ver README §8.

locals {
  budget_notifications = {
    real-50       = { type = "ACTUAL", threshold = 50 }
    real-80       = { type = "ACTUAL", threshold = 80 }
    real-100      = { type = "ACTUAL", threshold = 100 }
    pronostico100 = { type = "FORECASTED", threshold = 100 }
  }
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name_prefix}-mensual"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "cost_filter" {
    for_each = var.budget_filter_by_project_tag ? [1] : []
    content {
      name   = "TagKeyValue"
      values = ["user:Project$Katalyst"]
    }
  }

  dynamic "notification" {
    for_each = local.budget_notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = var.budget_contact_emails
    }
  }
}
