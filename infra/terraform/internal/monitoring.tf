# Katalyst — alarmas CloudWatch con notificación SNS.
# Requisitos: RNF-INF-03 (alertas externas), RNF-OBS-02, RNF-CON-04 (backup), RNF-CON-01 (leases),
# ESP §18, ARQ §6.
#
# Fuentes:
#  - AWS/EC2 (status checks, CPU, CPU credits): medidas por el hipervisor, externas al host.
#  - CWAgent (memoria, disco /, /data): CloudWatch agent del host.
#  - Katalyst (propias): deploy/scripts/publish-metrics.sh cada 60 s con dimensión Environment=internal.
#    HostHeartbeat y BackupAgeHours tratan datos faltantes como alarma: si el host o el publicador
#    caen, la alarma se dispara igualmente (no depende solo del proceso que puede caerse).
#
# El topic SNS no usa SSE: CloudWatch no puede publicar en topics cifrados con la clave administrada
# aws/sns y el contenido de las alarmas no es secreto.

resource "aws_sns_topic" "alarms" {
  name = "${var.name_prefix}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  for_each = toset(var.alarm_contact_emails)

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

locals {
  alarm_actions    = [aws_sns_topic.alarms.arn]
  katalyst_dims    = { Environment = "internal" }
  recover_action   = "arn:${local.partition}:automate:${var.aws_region}:ec2:recover"
  instance_dims    = { InstanceId = aws_instance.host.id }
  disk_paths       = { root = "/", data = "/data" }
  disk_thresholds  = { warning = 80, critical = 90 }
  disk_alarm_pairs = { for pair in setproduct(keys(local.disk_paths), keys(local.disk_thresholds)) : "${pair[0]}-${pair[1]}" => { path = local.disk_paths[pair[0]], threshold = local.disk_thresholds[pair[1]], level = pair[1] } }
}

# --- Salud EC2 externa ---------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "status_check_system" {
  alarm_name          = "${var.name_prefix}-ec2-status-check-system"
  alarm_description   = "Falla de status check de sistema (hardware/red AWS). Recuperación automática si está habilitada; conserva EIP y EBS."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  dimensions          = local.instance_dims
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = concat(local.alarm_actions, var.enable_ec2_auto_recovery ? [local.recover_action] : [])
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "status_check_instance" {
  alarm_name          = "${var.name_prefix}-ec2-status-check-instance"
  alarm_description   = "Falla de status check de instancia (SO/kernel/red del host). Revisar por SSM o consola serie."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  dimensions          = local.instance_dims
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${var.name_prefix}-cpu-alta"
  alarm_description   = "CPU promedio sostenida alta (15 min). Revisar concurrencia de navegadores y redimensionar según benchmark."
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = local.instance_dims
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.cpu_alarm_threshold_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "cpu_credits_low" {
  count = local.burstable ? 1 : 0

  alarm_name          = "${var.name_prefix}-cpu-credits-bajos"
  alarm_description   = "Saldo de CPU credits bajo: con cpu_credits=standard el host quedará limitado al baseline (muestras DXMon con contención)."
  namespace           = "AWS/EC2"
  metric_name         = "CPUCreditBalance"
  dimensions          = local.instance_dims
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.cpu_credit_balance_alarm_threshold
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Recursos del host (CloudWatch agent) ----------------------------------------------

resource "aws_cloudwatch_metric_alarm" "disk" {
  for_each = local.disk_alarm_pairs

  alarm_name          = "${var.name_prefix}-disco-${each.key}"
  alarm_description   = "Uso de disco ${each.value.path} >= ${each.value.threshold} % (${each.value.level}). Revisar limpieza, retenciones y tamaño."
  namespace           = "CWAgent"
  metric_name         = "disk_used_percent"
  dimensions          = merge(local.instance_dims, { path = each.value.path })
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "memory_low" {
  alarm_name          = "${var.name_prefix}-memoria-baja"
  alarm_description   = "Memoria disponible < ${var.memory_available_alarm_percent} % durante 5 min."
  namespace           = "CWAgent"
  metric_name         = "mem_available_percent"
  dimensions          = local.instance_dims
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.memory_available_alarm_percent
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- Métricas propias de Katalyst -----------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "host_heartbeat" {
  alarm_name          = "${var.name_prefix}-heartbeat-host-perdido"
  alarm_description   = "Sin heartbeat del host durante 10 min (host caído, publicador detenido o sin red)."
  namespace           = local.metrics_namespace
  metric_name         = "HostHeartbeat"
  dimensions          = local.katalyst_dims
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "backup_age" {
  alarm_name          = "${var.name_prefix}-backup-vencido"
  alarm_description   = "Último backup exitoso de PostgreSQL con más de ${var.backup_max_age_hours} h (RNF-CON-04, RPO <= 24 h)."
  namespace           = local.metrics_namespace
  metric_name         = "BackupAgeHours"
  dimensions          = local.katalyst_dims
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.backup_max_age_hours
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "outbox_overdue" {
  alarm_name          = "${var.name_prefix}-outbox-vencida"
  alarm_description   = "Entregas de outbox (TestRail/notificaciones) vencidas sin procesar (RNF-CON-02, RNF-OBS-02)."
  namespace           = local.metrics_namespace
  metric_name         = "OutboxOverdue"
  dimensions          = local.katalyst_dims
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "queue_lag" {
  alarm_name          = "${var.name_prefix}-cola-atrasada"
  alarm_description   = "La corrida más antigua en_cola supera ${var.queue_oldest_waiting_alarm_seconds} s (RNF-REN-02, saturación visible)."
  namespace           = local.metrics_namespace
  metric_name         = "QueueOldestWaitingSeconds"
  dimensions          = local.katalyst_dims
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.queue_oldest_waiting_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "worker_heartbeat_lost" {
  alarm_name          = "${var.name_prefix}-heartbeat-worker-perdido"
  alarm_description   = "Leases de worker vencidos por heartbeat perdido en los últimos 5 min (RNF-CON-01, ESP §13.3)."
  namespace           = local.metrics_namespace
  metric_name         = "WorkerLeasesExpired"
  dimensions          = local.katalyst_dims
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "app_metrics_unavailable" {
  alarm_name          = "${var.name_prefix}-metricas-app-no-disponibles"
  alarm_description   = "El publicador no pudo leer /metrics de la API durante 15 min: outbox/cola/leases no se están vigilando."
  namespace           = local.metrics_namespace
  metric_name         = "AppMetricsScrapeOk"
  dimensions          = local.katalyst_dims
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
