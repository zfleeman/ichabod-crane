# Everything Zach runs by hand. OpenTofu lives in tofu/, the instance is reached
# through SSM, and the instance ID always comes from the state rather than memory.

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

.PHONY: help init check plan apply shell openclaw ui status
