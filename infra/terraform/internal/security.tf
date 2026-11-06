# Katalyst — security group del host. Requisitos: RNF-SEG-03, RNF-SEG-05, ESP §18, ARQ §4.
# Entrada: solo HTTPS 443 desde allowed_cidrs. Sin SSH (administración por SSM Session Manager).
# PostgreSQL/Redis/Docker no se exponen (además no publican puertos en Compose).
# Salida: solo los puertos TCP de egress_tcp_ports. DNS de la VPC (Route 53 Resolver) y Amazon Time
# Sync (169.254.169.123) no pasan por reglas de security group.

resource "aws_security_group" "host" {
  name        = "${var.name_prefix}-host"
  description = "Katalyst host: HTTPS restringido a CIDRs corporativos, sin SSH"
  vpc_id      = local.vpc_id

  tags = {
    Name = "${var.name_prefix}-host"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(var.allowed_cidrs)

  security_group_id = aws_security_group.host.id
  description       = "HTTPS desde CIDR corporativo autorizado"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "tcp" {
  for_each = toset([for p in var.egress_tcp_ports : tostring(p)])

  security_group_id = aws_security_group.host.id
  description       = "Salida TCP ${each.value}"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}
