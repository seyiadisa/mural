# Session Handoff

## Last Completed Task
- Created root SETUP.md at the user's explicit request. It is a beginner guide for a fresh, private, single-owner web installation: tools/fork, Neon pooled and direct URLs, Google Auth Platform, Render Blueprint and seven required variables, authorized origin and first owner login, local SIWC sign-in/import, model/language selection, backups/updates, voice scope, and troubleshooting.
- Checked current repository configuration and official Render, Neon, Google, and OpenAI SIWC documentation. The guide uses placeholders only, requires matching owner/ChatGPT email, explains that laptop import writes encrypted credentials directly to Neon without SSH, and uses `pnpm run web-admin host-id` / `pnpm run web-admin import-siwc PATH` without the incorrect extra `--` in the older detailed guide.
- Documentation checks passed: all seven render.yaml sync:false inputs are covered; local document links exist; code fences are balanced; no instance-specific account, service, or host identifiers occur. No application tests were needed for this documentation-only change. No production settings, credentials, databases, or services were modified.

## Current State
- Branch main, HEAD/origin main 24406567fe90a213831c9ef616a082d5c400a098 after fetch. SETUP.md is new and uncommitted. Existing .agents docs-cache and QA evidence remain local; HANDOFF.md is updated. No new commits/pushes/deployments for this documentation task.
- The prior authorized release IS live: Render deployment dep-dbfl4i2jnfac73etp44g on 24406567fe90a213831c9ef616a082d5c400a098, service srv-dbee9d7b9u1s739e3vmg in Frankfurt at https://mural-ygi6.onrender.com . Public health/readiness, Google provider availability, CSP/HSTS, and the new hashed web asset /assets/index-CMivI4AJ.js passed live verification. The asset includes the new language-switch text. Signed-in browser/model loading and deployed inference verification were not completed; the user declined Computer Use and asked to end that task.
- Published code commits: f262d0b fixes SIWC missing Content-Type handling and model catalog parsing; 2440656 fixes web language selection/resume. Local API typecheck/build and six focused tests passed. Web typecheck/build and mocked browser language QA passed; evidence is in .agents/verification/language-switch-20261026/.
- Encrypted pre-release database and Render service/environment backup retained at C:/Users/oluwa/AppData/Local/Mural/Backups/render-20261026T131303Z . database.dump.dpapi and render-config.json.dpapi use Windows DPAPI CurrentUser, with verified decryption and a restricted directory ACL. Restore needs the same Windows user's DPAPI profile. Previous image dep-dbfk3ucs728c73dlbt50 on 749e9e0 is the rollback reference. Hosted voice remains disabled; release added no migrations or grants.

## Next Task
- The requested setup guide is ready for review. Commit/publish only if requested; avoid an unnecessary Render redeploy for documentation.
- Read SETUP.md first for new-operator setup; docs/web-app.md retains detailed Docker Compose/provider/voice instructions. Current task does not authorize creating new external accounts, spending, changing secrets, or re-running setup against production.

## Open Issues
- Older docs/web-app.md still shows `pnpm run web-admin -- ...`; the new guide documents the correct invocation. No unrelated documentation rewrite was made.
- Prior signed-in production browser and full deployed chat verification remain uncompleted. Only one tiny SIWC live inference was authorized and used during diagnosis; additional automated live provider calls require separate authorization.
- Temporary raw OAuth output remains at C:/Users/oluwa/AppData/Local/Temp/mural-siwc-01a17838/credentials.json. Never print or commit it; cleanup remains subject to the user's destructive-command approval rule.
