# Everything Zach runs by hand. OpenTofu lives in tofu/, the instance is reached
# through SSM, and the instance ID always comes from the state rather than memory.

# Exported, not passed as --profile, so `tofu` picks it up too: the AWS provider
# reads AWS_PROFILE from the environment. Override for a one-off run with
# `make status AWS_PROFILE=SHPO`.
export AWS_PROFILE ?= ZACH-ROOT

# Recursive assignment on purpose: `make help` should not need a built instance.
INSTANCE_ID = $(shell tofu -chdir=tofu output -raw instance_id)
GATEWAY_PORT = 18789

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | expand -t 12

init: ## Install providers and write the lock file
	tofu -chdir=tofu init

check: ## Formatting and validation
	tofu -chdir=tofu fmt -check
	tofu -chdir=tofu validate

plan: ## Show what would change
	tofu -chdir=tofu plan

apply: ## Build or update the infrastructure
	tofu -chdir=tofu apply

shell: ## Interactive shell on the box, as ssm-user
	aws ssm start-session --target $(INSTANCE_ID)

openclaw: ## Shell as the openclaw service account
	aws ssm start-session --target $(INSTANCE_ID) \
	  --document-name AWS-StartInteractiveCommand \
	  --parameters command="sudo -iu openclaw"

ui: ## Forward the Gateway to http://127.0.0.1:18789
	aws ssm start-session --target $(INSTANCE_ID) \
	  --document-name AWS-StartPortForwardingSession \
	  --parameters '{"portNumber":["$(GATEWAY_PORT)"],"localPortNumber":["$(GATEWAY_PORT)"]}'

status: ## Ask SSM whether the instance is online
	aws ssm describe-instance-information \
	  --filters Key=InstanceIds,Values=$(INSTANCE_ID) --output table

state: ## Is the instance running or stopped?
	aws ec2 describe-instances --instance-ids $(INSTANCE_ID) \
	  --query 'Reservations[0].Instances[0].State.Name' --output text

stop: ## Stop the instance and wait until it is really stopped
	@id=$(INSTANCE_ID); \
	  aws ec2 stop-instances --instance-ids $$id --output table; \
	  echo "waiting for stopped..."; \
	  aws ec2 wait instance-stopped --instance-ids $$id; \
	  echo "stopped."

# The EC2 waiter only proves the VM is up. SSM comes back a minute or so later,
# and every other target here needs SSM, so wait for that instead of guessing.
start: ## Start the instance and wait until SSM answers
	@id=$(INSTANCE_ID); \
	  aws ec2 start-instances --instance-ids $$id --output table; \
	  echo "waiting for running..."; \
	  aws ec2 wait instance-running --instance-ids $$id; \
	  echo "waiting for SSM..."; \
	  for i in $$(seq 60); do \
	    ping=$$(aws ssm describe-instance-information \
	      --filters Key=InstanceIds,Values=$$id \
	      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null); \
	    [ "$$ping" = "Online" ] && echo "online." && exit 0; \
	    sleep 5; \
	  done; \
	  echo "SSM never came online; try 'make console'." >&2; exit 1

ip: ## Print the Elastic IP
	@tofu -chdir=tofu output -raw public_ip; echo

# Boot output from the hypervisor. The one thing still readable when SSM is not.
console: ## Dump the serial console
	aws ec2 get-console-output --instance-id $(INSTANCE_ID) --output text

alarms: ## Current state of every ichabod alarm
	aws cloudwatch describe-alarms --alarm-name-prefix ichabod- \
	  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

# Same query as the comment in variables.tf. Paste the ID into terraform.tfvars.
ami: ## Latest Canonical Ubuntu 24.04 AMI for us-east-2
	aws ec2 describe-images --region us-east-2 --owners 099720109477 \
	  --filters "Name=name,Values=ubuntu/images/hvm-ssd*/ubuntu-noble-24.04-amd64-server-*" \
	            "Name=state,Values=available" \
	  --query 'sort_by(Images,&CreationDate)[-1].[ImageId,Name]' --output text

.PHONY: help init check plan apply shell openclaw ui status state stop start ip console alarms ami
