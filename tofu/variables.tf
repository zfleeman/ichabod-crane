# Deliberately only two. Everything else is written directly into the resources,
# because there is one environment and it is this one.

variable "alert_email" {
  description = "Where budget and CloudWatch alarms are delivered."
  type        = string
}

variable "ami_id" {
  description = <<-EOT
    Canonical Ubuntu 24.04 AMI for us-east-2, pinned by hand. A most_recent data
    source would silently replace the instance on a later apply. Refresh with:

    aws ec2 describe-images --region us-east-2 --owners 099720109477 \
      --filters "Name=name,Values=ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*" \
                "Name=state,Values=available" \
      --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text
  EOT
  type        = string
}
