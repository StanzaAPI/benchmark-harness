SHELL := bash
OUT ?= data/claims.x12
N ?= 255000

.PHONY: help smoke generate bench compare check

help: ## list targets
	@grep -E '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "};{printf "  %-10s %s\n", $$1, $$2}'

smoke: ## generate ~5 MB and run it under the 25 MB cap
	nix run .#smoke

generate: ## full corpus, 500.5 MB / 255,000 transactions
	nix run .#generate -- --transactions $(N) --claims 5 --out $(OUT)

bench: generate ## full run under the cap, then the head-to-head
	nix run .#bench -- $(OUT)
	nix run .#compare -- --file $(OUT) --cap 25

compare: ## head-to-head against node-x12 and x12-parser
	nix run .#compare -- --file $(OUT) --cap 25

check: ## flake checks (smoke run)
	nix flake check --print-build-logs
