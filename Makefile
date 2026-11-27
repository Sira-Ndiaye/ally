# Ally: everyday commands. `make check` is what every pull request must pass.
#   make check       unit tests + all security checks
#   make security    dependency audit, registry signatures, security guards, secret scan
#   make smoke       end-to-end test of the real app (needs a display)
#   make git-hooks   run `make security` before each `git push` on this machine
.PHONY: check test smoke security audit signatures guards secrets git-hooks

check: test security

test:
	npm test

smoke:
	npm run smoke

security: audit signatures guards secrets

# Any known vulnerability, of any severity, in any dependency fails.
audit:
	npm audit --audit-level=low

# Every installed package must carry the npm registry's signature.
signatures:
	npm audit signatures

# The protections from the security review stay in place (scripts/security-check.js).
guards:
	node scripts/security-check.js

# Whole history, secrets redacted in the output. CI always runs it; locally it needs
# gitleaks (brew install gitleaks).
secrets:
	@if command -v gitleaks >/dev/null 2>&1; then \
		gitleaks git --redact --no-banner .; \
	elif [ -n "$$CI" ]; then \
		echo "gitleaks is required in CI" >&2; exit 1; \
	else \
		echo "gitleaks not installed: secret scan of the history skipped (scripts/security-check.js still checked the files)"; \
	fi

git-hooks:
	@printf '#!/bin/sh\n# Installed by make git-hooks\nexec make security\n' > .git/hooks/pre-push
	@chmod +x .git/hooks/pre-push
	@echo "pre-push hook installed: make security runs before each push"
