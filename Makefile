# Everything Zach runs by hand. OpenTofu lives in tofu/, the instance is reached
# through SSM, and the instance ID always comes from the state rather than memory.

# Exported, not passed as --profile, so `tofu` picks it up too: the AWS provider
# reads AWS_PROFILE from the environment. Override for a one-off run with
# `make status AWS_PROFILE=SHPO`.
export AWS_PROFILE ?= ZACH-ROOT

# AWS CLI v2 pipes anything long through `less` by default, so a `--output table`
# result sits there until you `:q`. Empty means "no pager, just print it".
export AWS_PAGER =

# Recursive assignment on purpose: `make help` should not need a built instance.
INSTANCE_ID = $(shell tofu -chdir=tofu output -raw instance_id)
GATEWAY_PORT = 18789

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | expand -t 16

init: ## Install providers and write the lock file
	tofu -chdir=tofu init

check: ## Formatting and validation
	tofu -chdir=tofu fmt -check
	tofu -chdir=tofu validate

plan: ## Show what would change
	tofu -chdir=tofu plan

apply: ## Build or update the infrastructure
	tofu -chdir=tofu apply

# The box's state, as this repo declares it. Order is not cosmetic: a scheduled
# job names the agent that owns it, and configure-automations reads the prompt
# files off the box rather than out of the checkout. Every script here is
# idempotent, so rerunning sync is the way back to a known box.
sync: ## Push agents, workspace and scheduled passes to the box
	scripts/configure-agents
	scripts/deploy-workspace
	scripts/configure-automations

# Kept out of sync: this one needs IMAP_PASSWORD in the secret store, and it
# leaves a timestamped openclaw.json backup on the box every run.
imap: ## Write the IMAP intake config (needs IMAP_PASSWORD)
	scripts/configure-imap

# Also kept out of sync: install-plugin ships built output, and building it
# needs an `openclaw` CLI on this laptop. The script says so if dist/ is stale.
plugins: ## Install all three plugins from their built dist/
	@for p in mailbox smtp-send triage-guard; do \
	  echo "== $$p"; \
	  scripts/install-plugin $$p || exit 1; \
	done

sandbox-image: ## Rebuild the Docker image agents are sandboxed in
	scripts/build-sandbox-image

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

# Two separate questions with one answer: EC2 knows whether the machine is on,
# SSM knows whether it is reachable. A running box whose agent is dead shows as
# "running / not answering", which is the case worth spotting.
status: ## Power state, and whether SSM is answering
	@id=$(INSTANCE_ID); \
	  power=$$(aws ec2 describe-instances --instance-ids $$id \
	    --query 'Reservations[0].Instances[0].State.Name' --output text); \
	  ping=$$(aws ssm describe-instance-information \
	    --filters Key=InstanceIds,Values=$$id \
	    --query 'InstanceInformationList[0].PingStatus' --output text); \
	  [ "$$ping" = "Online" ] || ping="not answering"; \
	  echo "instance: $$power"; \
	  echo "ssm:      $$ping"

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
	  echo "SSM never came online; check the console in the EC2 web UI." >&2; exit 1

ip: ## Print the Elastic IP
	@tofu -chdir=tofu output -raw public_ip; echo

alarms: ## Current state of every ichabod alarm
	aws cloudwatch describe-alarms --alarm-name-prefix ichabod- \
	  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

.PHONY: help init check plan apply sync imap plugins sandbox-image shell openclaw ui status stop start ip alarms
