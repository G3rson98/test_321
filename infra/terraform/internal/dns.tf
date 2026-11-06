# Katalyst — registros DNS opcionales sobre una zona Route 53 EXISTENTE (referenciada por ID).
# Requisitos: RNF-SEG-03 (HTTPS), ESP §13.7 (origen separado de reportes), ARQ §4/§5.
# La zona no se crea ni se destruye; al retirar Katalyst solo se eliminan estos dos registros.

locals {
  manage_dns = var.route53_zone_id != null && var.manage_dns_records
}

resource "aws_route53_record" "panel" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.panel_hostname
  type    = "A"
  ttl     = 300
  records = [aws_eip.host.public_ip]
}

resource "aws_route53_record" "reports" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.reports_hostname
  type    = "A"
  ttl     = 300
  records = [aws_eip.host.public_ip]
}
