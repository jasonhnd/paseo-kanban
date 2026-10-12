# Paseo Kanban

> Experimental. Version 0.1 targets Paseo 0.11 (`>=0.11.0 <0.12.0`). Real app/phone and provider first-card acceptance are separate from local compilation and anonymous mounting.

One plugin combines a cross-project board with Fleet roles, quota, decisions and settings. Cards carry a role and a tier; finished work goes to a reviewer with a different nonempty actual model, then to the project lead. Different models in the same family are allowed; the same normalized model across providers/settings is refused.

Fleet publishes an immutable policy revision to Kanban admission. Invalid policy, unresolved model evidence and unknown protected quota readings hold dispatch. The `afc`/`roles` commands use the same persisted root for compatibility.

Data uses `KANBAN_DATA_DIR`, or `PASEO_HOME/plugin-data/paseo-kanban` (default `~/.paseo`), with Fleet in `fleet/`. Old Fleet storage overrides produce configuration diagnostics. Nothing is automatically transferred from an old installation. Read `docs/MANUAL-MIGRATION.md` and `docs/DATA.md` in the source repository.

<https://github.com/jasonhnd/paseo-kanban>
