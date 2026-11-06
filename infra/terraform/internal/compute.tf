# Katalyst — host único EC2 x86_64 On-Demand con disco de datos EBS separado y EIP.
# Requisitos: RNF-INF-01, RNF-INF-03, RNF-SEG-05, RNF-CON-04, ESP §18, ARQ §4.
#
# - IMDSv2 obligatorio, hop limit 1: los contenedores en redes bridge no alcanzan IMDS
#   (ver deploy/ para el bloqueo adicional de 169.254.169.254 desde runner-net y el broker de credenciales).
# - Disco raíz y volumen de datos gp3 cifrados y separados; el volumen de datos y la EIP sobreviven al
#   reemplazo de la instancia (prevent_destroy). user-data mínimo, sin secretos, sin remote-exec.
# - Sin Spot (RNF-INF-03).

data "aws_ssm_parameter" "al2023_ami" {
  count = var.ami_id == null ? 1 : 0
  name  = var.ami_ssm_parameter
}

locals {
  ami_id = var.ami_id != null ? var.ami_id : nonsensitive(data.aws_ssm_parameter.al2023_ami[0].value)

  cloudwatch_agent_config = jsonencode({
    agent = {
      metrics_collection_interval = 60
      run_as_user                 = "root"
      logfile                     = "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log"
    }
    metrics = {
      namespace = "CWAgent"
      append_dimensions = {
        InstanceId = "$${aws:InstanceId}"
      }
      aggregation_dimensions = [["InstanceId", "path"]]
      metrics_collected = {
        mem = {
          measurement = ["mem_used_percent", "mem_available_percent"]
        }
        disk = {
          resources                = ["/", "/data"]
          measurement              = ["used_percent", "inodes_free"]
          drop_device              = true
          ignore_file_system_types = ["sysfs", "devtmpfs", "tmpfs", "overlay", "squashfs"]
        }
        swap = {
          measurement = ["swap_used_percent"]
        }
      }
    }
    logs = {
      logs_collected = {
        files = {
          collect_list = [
            {
              # Logs JSON (Pino) de los servicios Compose. Los ejecutores de shard usan log-driver none.
              file_path         = "/var/lib/docker/containers/*/*-json.log"
              log_group_name    = local.log_group_name
              log_stream_name   = "{instance_id}/containers"
              retention_in_days = var.log_retention_days
            },
            {
              file_path         = "/var/log/katalyst/*.log"
              log_group_name    = local.log_group_name
              log_stream_name   = "{instance_id}/host-scripts"
              retention_in_days = var.log_retention_days
            },
            {
              file_path         = "/var/log/katalyst-bootstrap.log"
              log_group_name    = local.log_group_name
              log_stream_name   = "{instance_id}/bootstrap"
              retention_in_days = var.log_retention_days
            },
          ]
        }
      }
    }
  })

  # Valores NO secretos que el host necesita; deploy/ los lee desde /etc/katalyst/infra.env.
  infra_env = {
    AWS_REGION                  = var.aws_region
    KATALYST_ENVIRONMENT        = "internal"
    KATALYST_PANEL_HOST         = var.panel_hostname
    KATALYST_REPORTS_HOST       = var.reports_hostname
    KATALYST_S3_EVIDENCE_BUCKET = local.evidence_bucket_name
    KATALYST_S3_BACKUPS_BUCKET  = local.backups_bucket_name
    KATALYST_BACKUP_PREFIX      = local.backup_object_prefix
    KATALYST_SSM_PREFIX         = var.ssm_parameter_prefix
    KATALYST_LOG_GROUP          = local.log_group_name
    KATALYST_METRICS_NAMESPACE  = local.metrics_namespace
    KATALYST_DATA_DIR           = "/data"
    KATALYST_ROUTE53_ZONE_ID    = var.route53_zone_id != null ? var.route53_zone_id : ""
  }

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    data_volume_id          = replace(aws_ebs_volume.data.id, "-", "")
    docker_compose_version  = var.docker_compose_version
    docker_compose_sha256   = var.docker_compose_sha256
    cloudwatch_agent_config = local.cloudwatch_agent_config
    infra_env               = join("\n", [for k in sort(keys(local.infra_env)) : "${k}=${local.infra_env[k]}"])
  })
}

resource "aws_instance" "host" {
  ami                         = local.ami_id
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  availability_zone           = local.availability_zone
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = false
  ebs_optimized               = true
  monitoring                  = false # monitoreo básico; status checks son por minuto igualmente

  user_data                   = local.user_data
  user_data_replace_on_change = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  dynamic "credit_specification" {
    for_each = local.burstable ? [1] : []
    content {
      cpu_credits = var.cpu_credits
    }
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gib
    encrypted             = true
    kms_key_id            = var.ebs_kms_key_arn
    delete_on_termination = true

    tags = {
      Name = "${var.name_prefix}-root"
    }
  }

  tags = {
    Name = "${var.name_prefix}-host"
  }

  lifecycle {
    # Un AMI nuevo publicado en el parámetro SSM no reemplaza el host por sorpresa; el reemplazo es
    # explícito (`terraform apply -replace=aws_instance.host`, ver README §6).
    ignore_changes = [ami]

    precondition {
      condition     = contains(data.aws_ec2_instance_type.host.supported_architectures, "x86_64")
      error_message = "instance_type debe soportar x86_64 (Chromium Linux x86_64, ARQ §3)."
    }

    precondition {
      condition     = data.aws_ec2_instance_type.host.default_vcpus >= 2 && data.aws_ec2_instance_type.host.memory_size >= 4096
      error_message = "instance_type debe tener al menos 2 vCPU y 4 GiB (punto inicial recomendado 2 vCPU/8 GiB)."
    }

    precondition {
      condition     = length(data.aws_ec2_instance_type_offerings.host.locations) > 0
      error_message = "instance_type no se ofrece en ninguna AZ de la región."
    }
  }
}

resource "aws_ebs_volume" "data" {
  availability_zone = local.availability_zone
  type              = "gp3"
  size              = var.data_volume_size_gib
  iops              = var.data_volume_iops
  throughput        = var.data_volume_throughput_mibps
  encrypted         = true
  kms_key_id        = var.ebs_kms_key_arn
  final_snapshot    = true

  tags = {
    Name = "${var.name_prefix}-data"
    Role = "katalyst-data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.host.id
  stop_instance_before_detaching = true
}

resource "aws_eip" "host" {
  domain = "vpc"

  tags = {
    Name = "${var.name_prefix}-eip"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_eip_association" "host" {
  allocation_id = aws_eip.host.id
  instance_id   = aws_instance.host.id
}
