# Fixture provenance & licensing

Everything in `tests/fixtures/` is indexed by `tests/fixtures/MANIFEST.json`
(origin + sha256 per file).

| Corpus | Origin | License note |
|---|---|---|
| `tasker/enmaas-glm-ask.tsk.xml` | synthesized for this project (hand-written, models a real export's structure) | MIT (ours) |
| `tasker/screen-on-wifi.prf.xml`, `tasker/autoport-demo.prj.xml`, `tasker-edge/*` | synthesized | MIT (ours) |
| `tasker/whsatapp_random_words_demo.tsk.xml` | [sanwebinfo/tasker](https://github.com/sanwebinfo/tasker) (GitHub) | third-party; replace with synthetic equivalent before any redistribution concern |
| `tasker/plugins/*.xml` (AutoInput bundles) | public GitHub repos (see MANIFEST `origin` fields; discovered via code search) | third-party; same caveat |
| `automate/*.flo` | LlamaLab community share API (`llamalab.com/automate/community/api/v1/flows/<id>/data/`) | user-shared flows; kept as test corpus, not for redistribution — regenerate via `scripts/fetch_fixtures.py` if needed |
| `automate/negative/*` | synthesized (random bytes, truncated header) | MIT (ours) |
| `macrodroid/validator-probes/*.json` | recorded from `remote.macrodroid.com/mcp` `validate_macrodroid_macro` responses | factual API behavior |

Rules:
- Never commit APKs or decompiled sources (`downloads/`, `analysis/` are
  gitignored by design).
- The Tasker code tables in `data/taskerCodes.json` are generated from
  publicly published constants (`tasker.joaoapps.com/code/*.java`), not from
  decompiled code.
- `data/autoInputSchema.json` documents observable bundle keys from the
  published plugin wire format; the APK itself is not committed.
