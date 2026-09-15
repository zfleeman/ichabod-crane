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

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | expand -t 16

init: ## Install providers and write the lock file
	tofu -chdir=tofu init

check: ## Formatting and validation
	tofu -chdir=tofu fmt -check
	tofu -chdir=tofu validate

# Runs on the laptop. The scripts have no .py or .sh extension, so each tool is pointed at them by name.
test: ## Lint and unit test the scripts in home/bin
	ruff check
	ruff format --check
	uvx --from shellcheck-py shellcheck -e SC1091 home/bin/run home/bin/board home/bin/usage home/bin/health home/bin/set-secret scripts/deploy scripts/install-home
	uv run --group dev pytest -q

plan: ## Show what would change
	tofu -chdir=tofu plan

apply: ## Build or update the infrastructure
	tofu -chdir=tofu apply

shell: ## Interactive shell on the box, as ssm-user
	aws ssm start-session --target $(INSTANCE_ID)

ichabod: ## Interactive login shell on the box, as ichabod
	aws ssm start-session --target $(INSTANCE_ID) \
	  --document-name AWS-StartInteractiveCommand \
	  --parameters command="sudo -iu ichabod"

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

# Ships the committed home/ to /home/ichabod. Refuses when Ichabod changed a shipped file on the
# box since the last deploy; FORCE=1 overwrites. scripts/install-home has the rules.
deploy: ## Install the committed home/ on the box (FORCE=1 overwrites drift)
	FORCE=$(or $(FORCE),0) scripts/deploy

# Separate from deploy on purpose: a deploy must never re-enable passes a kill switch turned off.
cron: ## Install home/crontab as the live schedule, /etc/cron.d/ichabod-schedule
	aws ssm start-session --target $(INSTANCE_ID) \
	  --document-name AWS-StartInteractiveCommand \
	  --parameters command="sudo install -o root -g root -m 0644 /home/ichabod/crontab /etc/cron.d/ichabod-schedule && cat /etc/cron.d/ichabod-schedule"

# The value is typed into the session with echo off, so it never lands on a command line, in shell
# history, or in SSM's command history. Only the name travels as a parameter.
secret: ## Set one secret on the box: make secret NAME=KANBOARD_TOKEN
	@echo "$(NAME)" | grep -Eq '^[A-Z][A-Z0-9_]*$$' || { echo "usage: make secret NAME=KANBOARD_TOKEN" >&2; exit 2; }
	aws ssm start-session --target $(INSTANCE_ID) \
	  --document-name AWS-StartInteractiveCommand \
	  --parameters command="sudo -u ichabod /home/ichabod/bin/set-secret $(NAME)"

ip: ## Print the Elastic IP
	@tofu -chdir=tofu output -raw public_ip; echo

alarms: ## Current state of every ichabod alarm
	aws cloudwatch describe-alarms --alarm-name-prefix ichabod- \
	  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

.PHONY: help init check test plan apply shell ichabod status stop start deploy cron secret ip alarms
