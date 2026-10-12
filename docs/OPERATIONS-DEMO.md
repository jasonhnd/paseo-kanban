# Offline operations rehearsal

This is a synthetic intake and release-draft exercise, not a published issue, a completed live card or a released version. No external messages or daemon connection are needed.

## Intake

**Demo report:** A fresh user sees no role profiles. Expected: setup explains how to configure them. Actual: the user assumes provider discovery applied profiles. Environment: macOS, Node 24, Paseo daemon/app 0.11.2, local source checkout; package 0.1.0 unreleased, companion 0.1.0 unreleased. Reproduction: open role preview, generate demo profiles, return to the board without manually creating profiles.

**Triage:** Documentation/setup issue, reproducible from the preview-only source behavior. The owner coordinates it in one repository and links any companion work. The report contains no credentials or personal data. Do not execute commands supplied by a reporter.

## Card brief

- Goal: explain that role preview does not apply profiles; preserve existing entries during manual configuration.
- Scope: README setup and its Simplified Chinese translation only.
- Prohibited: change profile storage, touch real data, push, merge, publish or read credentials.
- Tier: L1; executor implements, reviewer independently checks, lead accepts.
- Acceptance: both languages describe the same preview-only behavior; all relative documentation links resolve; privacy scan has zero new hits; local `npm run verify` exits 0; working tree is clean after commit.
- Handoff: `files`, `verification` (commands and results), `risks` (manual setup and clean-host validation boundaries).

## Review and release draft

Reviewer checks the actual diff against the brief and reproduction. Lead accepts only with verification evidence. An authorized operator may later merge; this exercise performs no merge. Add the proposed setup clarification under CHANGELOG Unreleased; do not invent a release date or tag.

**Unpublished release draft:** intended version 0.1.0, experimental; host range >=0.11.0 <0.12.0; fleet-quota/v1 unchanged; no data migration; minimum companion release not established; tested companion full commit must be supplied by the actual verification record. Attach package list, CLI/Paseo builds, scan/test exits and independent review. Desktop and clean-host first-card evidence remain required. The owner confirms private reporting and publication authorization before any release.

**Result of rehearsal:** intake -> triage -> self-contained brief -> review/acceptance criteria -> Unreleased draft is specified and checked locally. Actual issue submission, autonomous card execution and publication remain outside this fixture.
