# Katalyst — pruebas offline del root internal con provider simulado (sin credenciales ni llamadas AWS).
# Requisitos: RNF-INF-01 (validación), RNF-SEG-03/05 (red e IMDS), RNF-CON-04 (retenciones).
# Ejecutar: terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }

  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }

  mock_data "aws_ec2_instance_type" {
    defaults = {
      supported_architectures         = ["x86_64"]
      default_vcpus                   = 2
      memory_size                     = 8192
      burstable_performance_supported = true
    }
  }

  mock_data "aws_ec2_instance_type_offerings" {
    defaults = { locations = ["us-east-1b", "us-east-1a"] }
  }

  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  mock_resource "aws_ebs_volume" {
    defaults = { id = "vol-0123456789abcdef0" }
  }

  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/katalyst-internal-host" }
  }

  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::katalyst-mock" }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:000000000000:log-group:/katalyst/internal/host" }
  }

  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:000000000000:katalyst-internal-alarms" }
  }

  mock_resource "aws_eip" {
    defaults = { public_ip = "198.51.100.10" }
  }
}

variables {
  aws_region            = "us-east-1"
  aws_account_id        = "000000000000"
  owner                 = "qa"
  cost_center           = "cc-qa"
  allowed_cidrs         = ["203.0.113.0/24"]
  panel_hostname        = "katalyst.example.com"
  reports_hostname      = "katalyst-reportes.example.com"
  alarm_contact_emails  = ["oncall@example.com"]
  budget_contact_emails = ["lead@example.com"]
  monthly_budget_usd    = 100
}

run "plan_base" {
  # apply con provider simulado: offline, permite evaluar valores calculados (user-data).
  command = apply

  assert {
    condition     = aws_instance.host.metadata_options[0].http_tokens == "required" && aws_instance.host.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "IMDSv2 obligatorio con hop limit 1."
  }

  assert {
    condition     = aws_instance.host.root_block_device[0].encrypted && aws_ebs_volume.data.encrypted && aws_ebs_volume.data.type == "gp3"
    error_message = "Discos gp3 cifrados."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.https) == 1 && aws_vpc_security_group_ingress_rule.https["203.0.113.0/24"].from_port == 443
    error_message = "Solo HTTPS desde allowed_cidrs."
  }

  assert {
    condition     = local.availability_zone == "us-east-1a"
    error_message = "AZ elegida de forma determinista."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.disk) == 4 && length(aws_cloudwatch_metric_alarm.cpu_credits_low) == 1
    error_message = "Alarmas de disco 80/90 en / y /data y de CPU credits."
  }

  assert {
    condition     = length(aws_budgets_budget.monthly.notification) == 4
    error_message = "Budget con 4 avisos (real 50/80/100, pronóstico 100)."
  }

  assert {
    condition     = length(aws_route53_record.panel) == 0 && length(aws_iam_role_policy.acme_dns01) == 0
    error_message = "Sin zona Route 53 no se crean registros ni permisos DNS-01."
  }

  assert {
    condition     = !strcontains(aws_instance.host.user_data, "PASSWORD") && strcontains(aws_instance.host.user_data, "nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0")
    error_message = "user-data sin secretos y monta el volumen de datos por ID."
  }
}

run "rechaza_cidr_abierto" {
  command = plan

  variables {
    allowed_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.allowed_cidrs]
}

run "rechaza_cidr_demasiado_amplio" {
  command = plan

  variables {
    allowed_cidrs = ["10.0.0.0/7"]
  }

  expect_failures = [var.allowed_cidrs]
}

run "rechaza_mismo_hostname" {
  command = plan

  variables {
    reports_hostname = "katalyst.example.com"
  }

  expect_failures = [var.reports_hostname]
}

run "con_zona_route53" {
  command = apply

  variables {
    route53_zone_id = "Z0123456789ABCDEFGHIJ"
  }

  assert {
    condition     = length(aws_route53_record.panel) == 1 && length(aws_iam_role_policy.acme_dns01) == 1
    error_message = "Con zona existente se crean registros A y permiso DNS-01 acotado."
  }
}

run "rechaza_arm64" {
  command = plan

  override_data {
    target = data.aws_ec2_instance_type.host
    values = {
      supported_architectures         = ["arm64"]
      default_vcpus                   = 2
      memory_size                     = 8192
      burstable_performance_supported = true
    }
  }

  expect_failures = [aws_instance.host]
}
