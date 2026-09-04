# RFC-02 — Infrastructure: OpenTofu, SSM, and the admin Makefile

| Field | Value |
|---|---|
| **Status** | Draft — awaiting review |
| **Scope** | The OpenTofu module Zach owns and applies, and the SSM-only administrative path that replaces SSH. |
| **Related** | [RFC-01](RFC-01-foundations.md), [RFC-03](RFC-03-host-and-deployment.md) |

## OpenTofu blueprint

OpenTofu provisions the machine and public network. Zach owns and applies it; Ichabod does not.

### Compact repository

```text
tofu/
├── main.tf
├── variables.tf
├── outputs.tf
├── terraform.tfvars.example
├── .gitignore
└── .terraform.lock.hcl
```

The file names keep the `.tf`/`.tfvars`/`.tfstate` convention because OpenTofu reads exactly those. Keep state locally with backups for the pilot, or use an encrypted versioned S3 backend with state locking. Never commit `terraform.tfstate` or `terraform.tfvars`.

### Use the default VPC

Yes, this can run entirely in the account's default VPC, and it should. A default VPC already has a public subnet in every availability zone, an Internet gateway, and a default route, and none of it costs anything. The parts of AWS networking that cost money — NAT gateways, VPC endpoints, extra Elastic IPs, Transit Gateway — are exactly the parts this design does not need, because the box only needs outbound Internet and inbound 80/443.

So: no VPC resources in the module. Look up the default VPC and its subnets, and attach a dedicated security group so Ichabod's rules never sit on `default`:

```hcl
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
```

The instance must sit in a public subnet with a public address (the Elastic IP), because the SSM agent, Let's Encrypt, Docker Hub, GitHub, and the Anthropic API are all reached outbound over the Internet gateway. Private subnets would require either a NAT gateway (~$33/month) or three interface VPC endpoints (~$22/month) — both are the "pay more for networking" outcome to avoid.

### Resources

Create:

- A security group in the default VPC.
- One `t3a.large` Ubuntu 24.04 amd64 instance.
- One encrypted 100 GiB gp3 root volume.
- An IAM role and instance profile whose only policy is `AmazonSSMManagedInstanceCore`.
- An Elastic IP.
- Apex and wildcard Route 53 A records.
- Budget alerts near the expected monthly spend.
- CloudWatch alarms and an SNS email topic (see [RFC-01](RFC-01-foundations.md#alarms)).
- Optional EBS snapshot policy.

No SSH key pair, because there is no SSH. Use the current Canonical Ubuntu AMI for `us-west-2`, selected deliberately rather than copied from an old guide.

### The one IAM role

[RFC-01](RFC-01-foundations.md#openclaw-secretrefs) says not to attach an instance role. This is the single exception, and it is worth being precise about why it is safe: `AmazonSSMManagedInstanceCore` lets the instance talk *to* Systems Manager. It grants no S3, no Secrets Manager, no EC2 mutation, and no ability to reach any other resource in the account. A root-equivalent agent that steals these credentials gains the ability to be managed by SSM, which it already was.

Add the CloudWatch agent policy alongside it only if metrics are published from the host. Nothing else goes on this role.

### Important inputs

```hcl
variable "domain_name" {
  type    = string
  default = "ichabod-crane.net"
}

variable "alert_email" {
  description = "Where budget and CloudWatch alarms are delivered"
  type        = string
}
```

There is no `admin_cidr` and no `key_name`. Access is an IAM question now, not a firewall question, so Zach can administer the box from a laptop, a phone tether, or a hotel network without reapplying anything.

### Network policy

| Port | Source | Purpose |
|---:|---|---|
| 80 | `0.0.0.0/0` | HTTP redirect and ACME HTTP-01 |
| 443 | `0.0.0.0/0` | Public applications |

Inbound port 22 is not open, to anyone, ever. SSM works over the instance's *outbound* connection to the Systems Manager service, so administrative access needs no inbound rule at all. Allow ordinary outbound traffic. Do not expose:

- OpenClaw Gateway `18789`
- Docker API `2375` or `2376`
- arbitrary application host ports

### Instance settings

The high-value portion of the EC2 resource is:

```hcl
instance_type                   = "t3a.large"
associate_public_ip_address     = false
disable_api_termination         = true
iam_instance_profile            = aws_iam_instance_profile.ichabod.name

credit_specification {
  cpu_credits = "standard"
}

metadata_options {
  http_endpoint               = "enabled"
  http_tokens                 = "required"
  http_put_response_hop_limit = 1
}

root_block_device {
  volume_type           = "gp3"
  volume_size           = 100
  encrypted             = true
  delete_on_termination = true
}
```

Associate the Elastic IP separately. A stopped instance retains the address, and the address can move to a replacement instance.

Ubuntu 24.04 AMIs ship the SSM agent preinstalled and enabled, so no user data is required to make the instance manageable. Confirm it registered before assuming so.

This RFC intentionally omits complete provider, alarm, and budget resources. They are ordinary HCL and consume many printed pages. The design constraints above matter more than one generated implementation. Use the current [AWS provider documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs) while writing the module.

Route 53 is authoritative, so create:

```text
ichabod-crane.net      A  <Elastic IP>
*.ichabod-crane.net    A  <Elastic IP>
```

The wildcard does not cover the apex, so both records are required.

### Apply and verify

From Zach's workstation:

```bash
tofu init
tofu fmt -check
tofu validate
tofu plan
tofu apply
```

Before continuing, verify:

- A second plan is empty.
- The instance appears in `aws ssm describe-instance-information`.
- `make shell` (see [below](#private-administration-with-aws-ssm)) opens a session.
- Port 22 is closed from everywhere.
- Ports 80 and 443 are reachable.
- Ports 18789, 2375, and 2376 are not public.
- The apex and a random wildcard hostname resolve to the Elastic IP.
- The root volume is encrypted.
- No credential appears in state, variables, user data, outputs, or Git.
- Budget notifications reach Zach.

## Private administration with AWS SSM

The Gateway is required; public Gateway access is not. Keep it bound to loopback:

```text
127.0.0.1:18789
```

Nothing reaches that port from the network. Administration goes through AWS Systems Manager Session Manager instead: the instance holds an outbound connection to the SSM service, and `aws ssm start-session` meets it there. That gives a shell and port forwarding with no inbound port, no key pair, and no IP allowlist — authorization is IAM, so it works from anywhere Zach is logged into the AWS CLI.

One-time setup on the laptop:

```bash
brew install --cask session-manager-plugin
aws ssm describe-instance-information \
  --query "InstanceInformationList[].[InstanceId,PingStatus]" --output table
```

If the instance is not listed as `Online`, the instance profile or its outbound Internet path is wrong; fix that before anything else, because it is now the only way in.

### The Makefile

Keep this next to the OpenTofu module so the connection details live in version control rather than in memory:

```makefile
INSTANCE_ID := $(shell tofu -chdir=tofu output -raw instance_id)
GATEWAY_PORT := 18789

# Interactive shell on the box (lands as ssm-user).
shell:
	aws ssm start-session --target $(INSTANCE_ID)

# Shell directly as Ichabod's service account.
openclaw:
	aws ssm start-session --target $(INSTANCE_ID) \
	  --document-name AWS-StartInteractiveCommand \
	  --parameters command="sudo -iu openclaw"

# Forward the loopback Gateway to http://127.0.0.1:18789 on the laptop.
ui:
	aws ssm start-session --target $(INSTANCE_ID) \
	  --document-name AWS-StartPortForwardingSession \
	  --parameters '{"portNumber":["$(GATEWAY_PORT)"],"localPortNumber":["$(GATEWAY_PORT)"]}'

status:
	aws ssm describe-instance-information \
	  --filters Key=InstanceIds,Values=$(INSTANCE_ID) --output table

.PHONY: shell openclaw ui status
```

### Open the Control UI

```bash
make ui
```

Leave that terminal open and browse to:

```text
http://127.0.0.1:18789/
```

The SSM tunnel protects the network path, and OpenClaw's own token/password and browser pairing still apply. This is the same shape as the SSH tunnel in OpenClaw's docs, with SSM carrying the forward. See [OpenClaw remote access](https://docs.openclaw.ai/gateway/remote).

### Text-only access

A session reaches the host, not a model session. After connecting:

```bash
make openclaw
openclaw tui
```

The TUI then connects to the Gateway and its sessions. Useful host-side commands include:

```bash
openclaw status --deep
openclaw gateway status
openclaw workboard list
openclaw logs --follow
```

Session Manager can log every session to S3 or CloudWatch Logs — worth enabling later so administrative access to a root-equivalent box is auditable.

Never solve an access problem by opening `18789` to the Internet.

