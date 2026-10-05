# Domain docs

## Layout and reading rules

This is a single-context repository.

Before exploring the codebase:
- Read root `GLOSSARY.md` if it exists.
- Read ADRs in `docs/adr/` relevant to the area being explored.

If domain documents are absent, proceed silently.
The domain-modeling skill creates them lazily when terms or decisions
are resolved.

## Vocabulary

Use glossary terms when naming domain concepts in issues, proposals,
hypotheses, and tests.

If a needed concept is missing, reconsider whether it belongs to the
project's vocabulary; note genuine gaps for domain-modeling.

## ADR conflicts

Explicitly identify any proposal that contradicts an existing ADR,
including the ADR identifier and why the decision merits reopening.
