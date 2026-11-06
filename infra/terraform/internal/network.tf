# Katalyst — red del host único. Requisitos: RNF-INF-01, ESP §18, ARQ §4.
# Subnet pública + EIP para salida estable; sin NAT Gateway. Reutiliza VPC/subnet existentes si se informan.

locals {
  create_network = var.existing_subnet_id == null
}

data "aws_subnet" "existing" {
  count = local.create_network ? 0 : 1
  id    = var.existing_subnet_id

  lifecycle {
    postcondition {
      condition     = self.vpc_id == var.existing_vpc_id
      error_message = "existing_subnet_id no pertenece a existing_vpc_id."
    }
  }
}

data "aws_ec2_instance_type_offerings" "host" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

locals {
  availability_zone = coalesce(
    var.availability_zone,
    try(data.aws_subnet.existing[0].availability_zone, null),
    try(sort(data.aws_ec2_instance_type_offerings.host.locations)[0], null),
  )
}

resource "aws_vpc" "main" {
  count = local.create_network ? 1 : 0

  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

# El security group por defecto de la VPC creada queda sin reglas (nada lo usa).
resource "aws_default_security_group" "main" {
  count  = local.create_network ? 1 : 0
  vpc_id = aws_vpc.main[0].id

  tags = {
    Name = "${var.name_prefix}-default-sin-reglas"
  }
}

resource "aws_internet_gateway" "main" {
  count  = local.create_network ? 1 : 0
  vpc_id = aws_vpc.main[0].id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

resource "aws_subnet" "public" {
  count = local.create_network ? 1 : 0

  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = local.availability_zone
  map_public_ip_on_launch = false # la IPv4 pública es la EIP

  tags = {
    Name = "${var.name_prefix}-public"
  }

  lifecycle {
    precondition {
      condition = (
        tonumber(split("/", var.public_subnet_cidr)[1]) >= tonumber(split("/", var.vpc_cidr)[1]) &&
        cidrhost("${cidrhost(var.public_subnet_cidr, 0)}/${split("/", var.vpc_cidr)[1]}", 0) == cidrhost(var.vpc_cidr, 0)
      )
      error_message = "public_subnet_cidr debe estar contenido en vpc_cidr."
    }
  }
}

resource "aws_route_table" "public" {
  count  = local.create_network ? 1 : 0
  vpc_id = aws_vpc.main[0].id

  tags = {
    Name = "${var.name_prefix}-public"
  }
}

resource "aws_route" "public_internet" {
  count = local.create_network ? 1 : 0

  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main[0].id
}

resource "aws_route_table_association" "public" {
  count = local.create_network ? 1 : 0

  subnet_id      = aws_subnet.public[0].id
  route_table_id = aws_route_table.public[0].id
}

locals {
  vpc_id    = local.create_network ? aws_vpc.main[0].id : var.existing_vpc_id
  subnet_id = local.create_network ? aws_subnet.public[0].id : var.existing_subnet_id
}
