# n8n-gitops

n8n (+ ffmpeg sidecar + browser-automation-sidecar) deployed to k3s by ArgoCD.
Push to `main` → Argo syncs `deploy/n8n` → a PostSync Job upserts every workflow in `deploy/n8n/workflows/` into n8n via its Public API.

## Layout
| Path | What |
|---|---|
| `argocd/n8n-app.yaml` | ArgoCD Application (apply once) |
| `deploy/n8n/` | Kustomize manifests (deployment, service, PVC, configmaps, sidecar, sync Job) |
| `deploy/n8n/workflows/*.json` | Workflows managed from git |
| `deploy/n8n/scripts/sync-workflows.sh` | Upsert script run by the PostSync Job |
| `apps/browser-automation-sidecar/` | Source for the browser sidecar image |

## Secrets (never committed – create by hand)
| Secret (ns `n8n`) | Keys |
|---|---|
| `n8n-encryption-key-secret-v2` | `N8N_ENCRYPTION_KEY` (already exists – back it up!) |
| `questionhut-admin-creds` | `username`, `password` (already exists) |
| `n8n-api-key` | `N8N_API_KEY` – create in n8n UI → Settings → n8n API |

```bash
kubectl create secret generic n8n-api-key -n n8n --from-literal=N8N_API_KEY=<key>
```

## Bootstrap
```bash
# 1. ArgoCD repo access (deploy key, read-only)
ssh-keygen -t ed25519 -f ~/n8n-gitops-deploy -N ""      # add .pub to GitHub repo → Settings → Deploy keys
kubectl create secret generic repo-n8n-gitops -n argocd \
  --from-literal=type=git --from-literal=url=git@github.com:Kibria7533/n8n-gitops.git \
  --from-file=sshPrivateKey=$HOME/n8n-gitops-deploy
kubectl label secret repo-n8n-gitops -n argocd argocd.argoproj.io/secret-type=repository

# 2. Register the app
kubectl apply -f argocd/n8n-app.yaml

# 3. Once Synced/Healthy, detach the old Helm release (do NOT helm uninstall)
kubectl delete secret sh.helm.release.v1.n8n.v1 -n n8n
```

## Adding / updating a workflow
1. Export from the n8n UI (⋯ → Download) into `deploy/n8n/workflows/<name>.json` (lowercase, dashes).
2. Add the file under `configMapGenerator → n8n-workflows → files` in `deploy/n8n/kustomization.yaml`.
3. Set `"active": true` in the JSON if it should be activated.
4. `git commit && git push` → check `kubectl logs -n n8n job/n8n-workflow-sync`.

Workflows are matched **by name**. Git wins: UI edits to a git-managed workflow are overwritten on the next sync.
Removing a file does not delete the workflow from n8n. Credentials stay in n8n and are referenced by ID.

Export all existing workflows:
```bash
POD=$(kubectl get pod -n n8n -l app.kubernetes.io/name=n8n -o name | cut -d/ -f2)
kubectl exec -n n8n $POD -c n8n-main -- n8n export:workflow --all --separate --output=/tmp/wf/
kubectl cp n8n/$POD:/tmp/wf ./deploy/n8n/workflows -c n8n-main
```

## Updating images (built locally, `imagePullPolicy: Never`)
```bash
docker build -t browser-automation-sidecar:v11 apps/browser-automation-sidecar
docker save browser-automation-sidecar:v11 | sudo k3s ctr images import -
# then bump newTag in deploy/n8n/kustomization.yaml and push
```

## Check before pushing
```bash
kubectl kustomize deploy/n8n
```
