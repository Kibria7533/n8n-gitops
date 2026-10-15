# AGENTS.md — n8n workflows as code

Guide for coding agents (and humans) working in this repo.
**This repo is PUBLIC. Never commit secrets** (tokens, passwords, API keys, cookies, private URLs with keys).

## How it works (one paragraph)
ArgoCD app `n8n` (namespace `argocd`) auto-syncs `deploy/n8n/` from branch `main` into namespace `n8n` on a k3s cluster.
Kustomize packs every file listed under `configMapGenerator → n8n-workflows` in `deploy/n8n/kustomization.yaml` into a ConfigMap.
After each sync, the ArgoCD **PostSync** Job `n8n-workflow-sync` runs `deploy/n8n/scripts/sync-workflows.sh`, which calls the n8n Public API and, for every JSON file:
- finds an existing workflow with the **same `name`** → `PUT` (update), otherwise `POST` (create);
- then activates it if `"active": true`, else deactivates it.

So: **edit JSON → list it in kustomization.yaml → commit → push to `main`** = change is live (usually within ~3 min, or click *Sync* in ArgoCD).

## Workflow file format
Path: `deploy/n8n/workflows/<kebab-case-name>.json` (filename: lowercase `a-z0-9-` only, `.json`).
Only these top-level keys are used; keep files to just these:
```json
{
  "name": "Unique Workflow Name",
  "active": false,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { "executionOrder": "v1" }
}
```
- `name` is the **identity key**. It must be unique across all workflows in n8n.
- `active`: `true` = scheduled/triggers on; `false` = off. Git enforces this on every sync.
- `settings`: only these keys are sent: `executionOrder, timezone, errorWorkflow, executionTimeout, callerPolicy, saveExecutionProgress, saveManualExecutions, saveDataErrorExecution, saveDataSuccessExecution`.
- `connections` refer to nodes by **node `name`**, not id. If you rename a node, update `connections` too.
- Each node needs unique `name` and `id` (UUID), a valid `type` and `typeVersion`, and a `position: [x, y]`.
- Credentials are referenced as `"credentials": {"<credType>": {"id": "<id>", "name": "<name>"}}`. The credential must **already exist in n8n**. Credentials are never stored in git; copy the id and name from an existing workflow file that uses the same credential.
- Exported metadata (`id`, `versionId`, `createdAt`, `updatedAt`, `pinData`, `staticData`, `meta`, `shared`, `tags`, …) is ignored. Strip it to keep diffs clean.

## CRUD recipes

### Create
1. Add `deploy/n8n/workflows/<slug>.json` with a **new unique** `name`.
2. Add `- workflows/<slug>.json` under `n8n-workflows → files` in `deploy/n8n/kustomization.yaml`. **Required: kustomize has no globs. An unlisted file is silently ignored.**
3. Validate (see below), commit, push.

### Read / pull current state from n8n
Edits made in the n8n UI are **not** written back to git automatically. To capture them:
```bash
POD=$(kubectl get pod -n n8n -l app.kubernetes.io/name=n8n -o name | cut -d/ -f2)
kubectl exec -n n8n $POD -c n8n-main -- n8n export:workflow --all --separate --pretty --output=/tmp/wf/
kubectl cp -c n8n-main n8n/$POD:/tmp/wf ./wf-export      # then copy the needed file over its git version
kubectl exec -n n8n $POD -c n8n-main -- rm -rf /tmp/wf
```
Then reduce the file to the keys above, **scan it for hardcoded secrets**, and keep the same filename. `wf-export/` must not be committed. Delete it afterwards.

### Update
Edit the JSON file (nodes, parameters, `active`, …), keep `name` unchanged, commit, push.
**Git wins:** any UI edit to a git-managed workflow is overwritten on the next sync. Pull it into git first (see Read).

### Rename
Changing `name` makes the sync **create a new workflow**, and the old one stays in n8n. After pushing, delete or archive the old one in the n8n UI.

### Delete
Not automated (on purpose, to avoid accidental data loss).
1. Remove the file and its line in `kustomization.yaml`, commit, push.
2. Delete or archive the workflow in the n8n UI (or `DELETE /api/v1/workflows/<id>` with the API key).
To just stop it running, set `"active": false` instead.

## Validate before pushing
```bash
python3 -m json.tool deploy/n8n/workflows/<slug>.json >/dev/null    # valid JSON
kubectl kustomize deploy/n8n >/dev/null                             # kustomization renders
grep -rnE 'EAA[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|[Bb]earer [A-Za-z0-9._-]{20,}' deploy/ && echo "SECRET FOUND - do not commit"
```
Also check: every file in `deploy/n8n/workflows/` is listed in `kustomization.yaml`, and there are no duplicate `name` values.

## Verify after pushing
```bash
kubectl get application n8n -n argocd                  # expect Synced / Healthy
kubectl logs -n n8n job/n8n-workflow-sync              # CREATE / UPDATE / activated lines per workflow
```
If the log says `Secret n8n-api-key not set - skipping`, create the key (n8n UI → Settings → n8n API):
`kubectl create secret generic n8n-api-key -n n8n --from-literal=N8N_API_KEY=<key>`.
An API error (`400`, etc.) in the log names the failing workflow. Fix its JSON and push again.

## Secrets in workflows
Never hardcode tokens in Code/HTTP nodes. Use an n8n credential (e.g. `httpHeaderAuth`, `facebookGraphApi`) and reference it.
One workflow, **"Facebook Reel - BCS Quiz (3x Daily)"**, is intentionally **not** in git because its Code node contains a hardcoded Facebook token. Move the token to a credential before adding it.

## Don't touch without a reason
- `deploy/n8n/n8n-deployment.yaml`, `pvc.yaml`, `n8n-service.yaml`: live n8n. The PVC holds the SQLite DB and credentials and is protected (`Prune=false,Delete=false`). Never rename it.
- Secrets `n8n-encryption-key-secret-v2`, `questionhut-admin-creds` and `n8n-api-key` live only in the cluster. Never add them to git.
- Images are built locally (`imagePullPolicy: Never`). To change one, build and import it into k3s, then bump `newTag` in `kustomization.yaml` (see README).
- Do not use Helm for n8n. ArgoCD owns it.
