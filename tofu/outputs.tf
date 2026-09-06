# `make` reads instance_id, so the name matters. No output holds a credential.

output "instance_id" {
  description = "EC2 instance ID, used as the SSM session target."
  value       = aws_instance.ichabod.id
}

output "public_ip" {
  description = "Elastic IP the apex and wildcard A records point at."
  value       = aws_eip.ichabod.public_ip
}

output "security_group_id" {
  description = "Security group holding the public 80/443 rules."
  value       = aws_security_group.ichabod.id
}
