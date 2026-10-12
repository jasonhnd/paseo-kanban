# Changelog

Versions and release tags belong to this plugin independently of its companion.
No public release is declared by this document.

## Unreleased

### Added

- Default review dispatch includes an independent Codex `gpt-6-sol` slot at `xhigh` on L1 through L4. It matches that exact model and does not use the GPT-6.1 slot.
- Experimental plugin sources, standalone Node commands and English/Simplified Chinese interfaces.
- Public setup, workflow, data, compatibility and manual release documentation.
- Bug, feature and compatibility report templates and private disclosure guidance.

### Changed

- No released baseline yet.

### Fixed

- The sidebar registers one standard item (`id`, `title`, `icon`, `surface`) that shares `board` with the screen. Desktop and compact sidebars open that same panel: nine tabs, settings, the shared language control, and the workspace panel registered on `board`. A physical phone is still unverified.

### Security

- Local privacy, identity, history leak and package-content gates are required.
- Private vulnerability reporting must be enabled by the owner before release.

### Notes

- Intended initial package version: 0.1.0; status: experimental, unreleased.
- Paseo manifest range: >=0.11.0 <0.12.0. Full platform/desktop certification is pending.
- Contract schema: fleet-quota/v1; additive contractVersion: 1.2.0. No contract or data migration is introduced by these documentation changes.
- Minimum released companion version: not established; no supported release pair is declared.
- Tested companion tag/commit and upgrade order: to be recorded in each release after interoperability checks. Do not infer these from matching package versions.
- Git install, package, desktop, first-card and rollback evidence is required before release; see docs/RELEASE.md. Code downgrade does not undo data writes.
