terraform {
  required_version = "~> 1.12"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "us-east-2"

  default_tags {
    tags = {
      Project = "ichabod"
    }
  }
}

# The default VPC already has a public subnet, an Internet gateway, and a route
# to it in every availability zone. Nothing here creates VPC resources.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# The hosted zone was created by hand when the domain was registered.
data "aws_route53_zone" "ichabod" {
  name = "ichabod-crane.net"
}

# Zach's personal zone, also created by hand. Read only for the board record below.
data "aws_route53_zone" "zfleeman" {
  name = "zfleeman.com"
}

# --- Network -----------------------------------------------------------------

resource "aws_security_group" "ichabod" {
  name        = "ichabod"
  description = "Public web traffic for the Ichabod host. No SSH."
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = "ichabod"
  }
}

# Port 80 carries the HTTPS redirect and the Let's Encrypt HTTP-01 challenge.
resource "aws_vpc_security_group_ingress_rule" "http" {
  security_group_id = aws_security_group.ichabod.id
  description       = "HTTP redirect and ACME HTTP-01"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.ichabod.id
  description       = "Public applications"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Administration is SSM, which rides this outbound path. There is no port 22 rule.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.ichabod.id
  description       = "All outbound"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# --- Identity ----------------------------------------------------------------

resource "aws_iam_role" "ichabod" {
  name = "ichabod-instance"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

# Lets the instance talk to Systems Manager. It grants no access to anything
# else in the account, which is why a root-equivalent agent on the box is
# allowed to hold it.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ichabod.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Memory and disk are not EC2-native metrics, so the CloudWatch agent publishes them.
resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.ichabod.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_instance_profile" "ichabod" {
  name = "ichabod-instance"
  role = aws_iam_role.ichabod.name
}

# --- Instance ----------------------------------------------------------------

# 8 GiB is for compilers, Docker layers and headless Chromium, not the sites; a medium runs out of memory on builds.
# Resize only on evidence, such as memory repeatedly above 85% or builds blocked on CPU credits. Prune first.
resource "aws_instance" "ichabod" {
  ami           = var.ami_id
  instance_type = "t3a.large"

  # The subnet set has no stable order, so sort it. An unsorted index can pick a
  # different subnet on a later apply and force the instance to be replaced.
  subnet_id              = sort(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids = [aws_security_group.ichabod.id]
  iam_instance_profile   = aws_iam_instance_profile.ichabod.name

  # The Elastic IP below is the public address; no auto-assigned one is wanted.
  associate_public_ip_address = false
  # Makes `tofu destroy` fail. Set it false and apply once before an intentional teardown.
  disable_api_termination = true

  # Associating the Elastic IP makes AWS report the interface as having a public
  # IP association, so this attribute reads back as true no matter what is set
  # here. Without the ignore, every plan wants to replace the whole instance.
  lifecycle {
    ignore_changes = [associate_public_ip_address]
  }

  # A predictable CPU ceiling instead of a surprise unlimited-mode bill.
  credit_specification {
    cpu_credits = "standard"
  }

  # IMDSv2 with a hop limit of 1: a container on Docker's bridge network cannot reach the role's credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # gp3 gets the same baseline IOPS at any size and grows while running, so 100 GiB is reversible. Docker fills it.
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 100
    encrypted             = true
    delete_on_termination = true
  }

  # No user_data: the Canonical AMI ships the SSM agent enabled.

  tags = {
    Name = "ichabod"
  }
}

# Associated separately so the address survives a stop or an instance rebuild.
resource "aws_eip" "ichabod" {
  domain = "vpc"

  tags = {
    Name = "ichabod"
  }
}

resource "aws_eip_association" "ichabod" {
  instance_id   = aws_instance.ichabod.id
  allocation_id = aws_eip.ichabod.id
}

# --- Backups -----------------------------------------------------------------

# Data Lifecycle Manager takes the snapshots from outside the box, so nothing on it can stop or delete them.
resource "aws_iam_role" "dlm" {
  name = "ichabod-dlm"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "dlm.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

# Snapshots every volume on the instance tagged Name=ichabod each day at 09:00 UTC, and keeps the last seven.
resource "aws_dlm_lifecycle_policy" "ichabod" {
  description        = "ichabod daily snapshots"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["INSTANCE"]
    target_tags    = { Name = "ichabod" }

    schedule {
      name      = "daily"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["09:00"]
      }

      retain_rule {
        count = 7
      }
    }
  }
}

# --- DNS ---------------------------------------------------------------------

# Both records are required: a wildcard does not answer for the apex.
resource "aws_route53_record" "apex" {
  zone_id = data.aws_route53_zone.ichabod.zone_id
  name    = "ichabod-crane.net"
  type    = "A"
  ttl     = 300
  records = [aws_eip.ichabod.public_ip]
}

resource "aws_route53_record" "wildcard" {
  zone_id = data.aws_route53_zone.ichabod.zone_id
  name    = "*.ichabod-crane.net"
  type    = "A"
  ttl     = 300
  records = [aws_eip.ichabod.public_ip]
}

# The board runs on Zach's Synology, not on this box. Only this record is managed
# here; the rest of the zfleeman.com zone is kept by hand.
resource "aws_route53_record" "board" {
  zone_id = data.aws_route53_zone.zfleeman.zone_id
  name    = "ichabod-board.zfleeman.com"
  type    = "CNAME"
  ttl     = 300
  records = ["zfleeman.synology.me"]
}

# Mail, all of it Fastmail's. These were created by hand in the console during
# the mailbox setup and imported afterwards, so the zone and this file agree.

resource "aws_route53_record" "mx" {
  zone_id = data.aws_route53_zone.ichabod.zone_id
  name    = "ichabod-crane.net"
  type    = "MX"
  ttl     = 300
  records = [
    "10 us1-smtp.messagingengine.com",
    "20 us2-smtp.messagingengine.com",
  ]
}

# ?all rather than ~all or -all is Fastmail's own published value. DMARC below
# is what actually enforces; SPF here is only one of its two inputs.
resource "aws_route53_record" "spf" {
  zone_id = data.aws_route53_zone.ichabod.zone_id
  name    = "ichabod-crane.net"
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:spf.messagingengine.com ?all"]
}

# Three selectors because Fastmail rotates between them. All three must resolve
# or DKIM signing breaks on whichever one it reaches for.
resource "aws_route53_record" "dkim" {
  for_each = toset(["fm1", "fm2", "fm3"])

  zone_id = data.aws_route53_zone.ichabod.zone_id
  name    = "${each.key}._domainkey.ichabod-crane.net"
  type    = "CNAME"
  ttl     = 300
  records = ["${each.key}.ichabod-crane.net.dkim.fmhosted.com"]
}

# p=reject with strict alignment. The domain sends only to Zach, so there are no
# third-party senders to break, and a spoofed ichabod@ichabod-crane.net is
# refused at the receiver rather than landing in his inbox. Reports go to the
# mailbox itself, which means Ichabod can read its own delivery failures.
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.ichabod.zone_id
  name    = "_dmarc.ichabod-crane.net"
  type    = "TXT"
  ttl     = 300
  records = ["v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:ichabod@ichabod-crane.net"]
}

# --- Alerting ----------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "ichabod-alerts"
}

# Stays "pending confirmation" until the link in the first email is clicked.
# Alarms are silent until then.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "status_check_failed" {
  alarm_name          = "ichabod-status-check-failed"
  alarm_description   = "EC2 or system status check failing."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  dimensions          = { InstanceId = aws_instance.ichabod.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Standard credit mode means a drained balance throttles the box to its baseline.
# A fresh host trips this during scripts/build-host, and it clears once the box idles.
resource "aws_cloudwatch_metric_alarm" "cpu_credits_low" {
  alarm_name          = "ichabod-cpu-credit-balance-low"
  alarm_description   = "CPU credits nearly exhausted; the host is about to be throttled."
  namespace           = "AWS/EC2"
  metric_name         = "CPUCreditBalance"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 50
  comparison_operator = "LessThanThreshold"
  dimensions          = { InstanceId = aws_instance.ichabod.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "ebs_byte_balance_low" {
  alarm_name          = "ichabod-ebs-byte-balance-low"
  alarm_description   = "EBS throughput burst balance below 20 percent."
  namespace           = "AWS/EC2"
  metric_name         = "EBSByteBalance%"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 20
  comparison_operator = "LessThanThreshold"
  dimensions          = { InstanceId = aws_instance.ichabod.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# The three CWAgent alarms sit in INSUFFICIENT_DATA until scripts/build-host installs
# the agent, which it configures to collect only "/" and aggregate on InstanceId.
resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "ichabod-memory-high"
  alarm_description   = "Memory above 85 percent."
  namespace           = "CWAgent"
  metric_name         = "mem_used_percent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { InstanceId = aws_instance.ichabod.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "disk_warning" {
  alarm_name          = "ichabod-disk-used-warning"
  alarm_description   = "Root filesystem above 75 percent. Time to clean up images."
  namespace           = "CWAgent"
  metric_name         = "disk_used_percent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 75
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { InstanceId = aws_instance.ichabod.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "disk_urgent" {
  alarm_name          = "ichabod-disk-used-urgent"
  alarm_description   = "Root filesystem above 90 percent."
  namespace           = "CWAgent"
  metric_name         = "disk_used_percent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { InstanceId = aws_instance.ichabod.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# One alarm per scheduled job in home/crontab. Each job touches a marker on success, and home/bin/health
# publishes it as a heartbeat once an hour, so an alarm can fire up to an hour after its limit. Mail can be
# what broke, so these shout through SNS instead: a dead box, a stopped cron, a broken health or broken mail
# all arrive as missing data.
# The value is how many hours a job may go without a success, about three missed runs; change it with the
# crontab. A job still commented out in the crontab sits in ALARM until its line is enabled.
resource "aws_cloudwatch_metric_alarm" "heartbeat" {
  for_each = {
    receive-mail = 2
    usage        = 3
    work         = 3
    read-feeds   = 18
    scout        = 6
    digest       = 26
  }

  alarm_name          = "ichabod-heartbeat-${each.key}"
  alarm_description   = "No successful ${each.key} run for ${each.value} hours."
  namespace           = "ichabod"
  metric_name         = "Heartbeat"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = each.value
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { Job = each.key }
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Expected spend is roughly $67 a month, so $80 leaves headroom before it fires.
resource "aws_budgets_budget" "ichabod" {
  name         = "ichabod-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = "80"
  limit_unit   = "USD"

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }
}
