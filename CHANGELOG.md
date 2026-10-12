# Changelog

The single plugin has one version and CHANGELOG. This batch distributes through Git.
This document does not declare a versioned release, npm publication or official registry listing.

## Unreleased

### Added

- Default review dispatch includes an independent Codex `gpt-6-sol` slot at `xhigh` on L1 through L4. It matches that exact model and does not use the GPT-6.1 slot.
- Experimental plugin sources, standalone Node commands and English/Simplified Chinese interfaces.
- Public setup, workflow, data, compatibility and manual release documentation.
- Bug, feature and compatibility report templates and private disclosure guidance.

### Changed

- English and Chinese setup now uses the real public `integration/single-plugin-reviewed` ref, explicit-ref check/update, enable/remove and installed revision confirmation.
- User Git installation is separate from developer directory flow; access/adapter inheritance, canonical-root backups and code versus data recovery are documented.
- Command replay checklist, usage-side directory-to-Git runbook and registry draft are prepared, without claiming production switching, installed-product acceptance or external submission is complete.

### Fixed

- The sidebar registers one standard item (`id`, `title`, `icon`, `surface`) that shares `board` with the screen. Desktop and compact sidebars open that same panel: nine tabs, settings, the shared language control, and the workspace panel registered on `board`. A physical phone is still unverified.

### Security

- Local privacy, identity, history leak and package-content gates are required.
- Private vulnerability reporting must be enabled by the owner before release.

### Notes

- Package metadata: 0.1.0; experimental. Public Git source is not evidence of a versioned release or existing tag.
- Paseo daemon/app range: >=0.11.0 <0.12.0; official command/compiler baseline: 0.11.2. Help/docs syntax checks are not installed-product validation; full platform/app/phone/provider first-card evidence remains separate.
- Admission uses immutable paseo-policy/v1; fleet-quota/v1 and contractVersion 1.2.0 remain same-root compatibility interfaces. These documentation changes introduce no contract or data migration.
- Canonical root: KANBAN_DATA_DIR or PASEO_HOME/plugin-data/paseo-kanban. Old Fleet data is not automatically imported.
- Git install, package, desktop, first-card and rollback evidence is required before release; see docs/RELEASE.md. Code downgrade does not undo data writes.
