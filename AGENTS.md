Read docs/product.md and docs/architecture.md before making any architectural changes.

Respect the component boundaries defined in docs/architecture.md.

Do not introduce new infrastructure or external dependencies without justifying the requirement they solve.

Do not resolve items in the Open Questions section without explicit direction.

Treat customer data and repository secrets as confidential information.

Never commit credentials, API keys, tokens, passwords, or other secrets to source control.

Do not perform destructive database operations or remove persisted data outside the explicit scope of the task.

When working on a PR, focus on the acceptance criteria and do not unravel scope related to another issue.

Error messages should be descriptive: explain what went wrong.
