# VORTEX — File Upload Service

A file upload/download service with a 3D game-style frontend, built for practising
Docker, Kubernetes storage (emptyDir vs PersistentVolumeClaim vs MinIO), Jenkins and GitHub.

```
frontend/   3D page (Three.js) — served by the backend
backend/    Flask API: accounts, per-user files, health
Dockerfile  one image with both (plus a "test" stage that runs the tests)
k8s/        Kubernetes manifests: emptydir/, pvc/, minio/
Jenkinsfile CI/CD: test -> build -> push -> deploy -> verify
```

## The flow

```
git push ──► GitHub ──webhook──► Jenkins
                                   │ Checkout
                                   │ Test          docker build --target test
                                   │ Build image   docker build
                                   │ Push image    docker push  ──► Docker Hub
                                   │ Deploy        kubectl apply ──► Kubernetes ◄── pulls image
                                   ▼ Verify        rollout status + /health
                         Browser ──► Service :30080 ──► Pod ──► emptyDir | PVC | MinIO
```

## Run it locally

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
DATA_DIR=./data .venv/bin/gunicorn --bind 0.0.0.0:8080 --threads 8 wsgi:app
```

Open http://localhost:8080. Without a backend (opening `frontend/` on its own) the page runs in
demo mode and keeps everything in the browser.

## Run the tests

```bash
cd backend && .venv/bin/python -m pytest
```

## Docker

```bash
docker build -t vortex-file-upload .

# Like emptyDir: files and accounts are lost when the container is removed
docker run --rm -p 8080:8080 -e SECRET_KEY=change-me -e STORAGE_VOLUME=emptyDir vortex-file-upload

# Like a PVC: a named volume keeps them
docker run --rm -p 8080:8080 -e SECRET_KEY=change-me -e STORAGE_VOLUME=pvc -v vortex-data:/data vortex-file-upload
```

The container runs as a non-root user (uid 10001) and stores everything under `/data`.

## Kubernetes

Three ways to store the files. They all use the same Deployment name (`vortex`), so applying
another mode replaces the app in place.

| Folder | Storage | Delete the pod and… |
|---|---|---|
| `k8s/emptydir/` | `emptyDir`, created and deleted with the pod | files **and accounts are lost** |
| `k8s/pvc/` | `PersistentVolumeClaim` (1Gi) | everything stays |
| `k8s/minio/` | MinIO pod with its own PVC; the app keeps nothing locally | everything stays |

By hand on minikube (no Jenkins):

```bash
docker build -t vortex-file-upload:latest .
minikube image load vortex-file-upload:latest   # copy the image into the cluster
kubectl apply -f k8s/namespace.yaml
cp k8s/secret.example.yaml k8s/secret.yaml   # then edit the values
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/pvc/                # or k8s/emptydir/ or k8s/minio/
minikube service vortex -n vortex --url  # the address to open
```

The experiment from the slide:

```bash
kubectl -n vortex delete pod -l app=vortex   # the game shows the pod wipe
kubectl -n vortex get pods                   # a new pod with a new name
```

On `emptydir` the game then says "ACCOUNT LOST"; on `pvc` and `minio` your files are still there.
MinIO's web console: `kubectl -n vortex port-forward svc/minio 9001`, then http://localhost:9001.

Switching mode leaves the old mode's things running (for example the MinIO pod or a PVC).
Remove them with `kubectl delete -f k8s/minio/1-minio.yaml` or `kubectl -n vortex delete pvc vortex-data`.
Start over completely with `kubectl delete namespace vortex`.

## Jenkins

The [Jenkinsfile](Jenkinsfile) has six stages: **Checkout → Test → Build image → Push image → Deploy → Verify**.

1. The Jenkins machine needs Docker and kubectl, and the plugins *Pipeline*, *Git*,
   *GitHub* and *Credentials Binding* (all in Jenkins' suggested plugins).
2. In the Jenkinsfile, set `IMAGE` to your Docker Hub repository.
3. Add the credentials (Manage Jenkins → Credentials), with exactly these IDs:

   | ID | Kind | Value |
   |---|---|---|
   | `dockerhub` | Username with password | Docker Hub user and access token |
   | `kubeconfig` | Secret file | kubeconfig for your cluster |
   | `vortex-secret-key` | Secret text | a long random string (`openssl rand -hex 32`) |
   | `minio-root` | Username with password | MinIO admin user and a password of 8+ characters |

   Jenkins makes the Kubernetes Secret from these, so no password is ever stored in Git.
4. New Item → **Pipeline** → *Pipeline script from SCM* → Git → your GitHub repository URL,
   and tick **GitHub hook trigger for GITScm polling**.
5. In GitHub: repository Settings → Webhooks → add `http://<jenkins-address>/github-webhook/`,
   content type `application/json`, event "Just the push event".
6. Run it once by hand with **Build with Parameters**. After that every `git push` deploys,
   using the default mode, `pvc`. Choose `emptydir` or `minio` in **Build with Parameters**.

Each build tags the image with its build number (`IMAGE:42`) and deploys that exact tag, so
an older build can be rolled back with `kubectl -n vortex rollout undo deployment/vortex`.

The webhook needs an address GitHub can reach. If Jenkins runs on your own laptop, either use a
tunnel (for example ngrok) or press **Build Now** after each push.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `STORAGE` | `local` | `local` (folder at `DATA_DIR`) or `minio` |
| `DATA_DIR` | `/data` | Where local storage keeps files and accounts — mount the emptyDir/PVC here |
| `STORAGE_VOLUME` | — | `emptyDir` or `pvc`; only reported to the game so it can show the armour badge |
| `SECRET_KEY` | generated | Signs login tokens. **Set it from a Kubernetes Secret**; if unset with local storage a key is saved in `DATA_DIR` |
| `MAX_UPLOAD_MB` | `200` | Largest upload |
| `TOKEN_MAX_AGE` | `604800` | Seconds a login stays valid (7 days) |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` / `MINIO_SECURE` | `minio:9000` / — / — / `uploads` / `false` | MinIO connection when `STORAGE=minio` |
| `POD_NAME` | hostname | Shown in the game; the pod name in Kubernetes |

## API

All file routes need `Authorization: Bearer <token>` and only ever touch the signed-in user's files.

| Method | Path | Body / result |
|---|---|---|
| GET | `/health` | `{status, pod, storage, volume}` |
| POST | `/auth/register` | `{username, password}` → `201 {username, token}`, `409` if the name is taken |
| POST | `/auth/login` | `{username, password}` → `{username, token}`, `401` if wrong |
| GET | `/auth/me` | `{username}` |
| GET | `/files` | `[{name, size}]` |
| POST | `/upload` | multipart field `file` → `201 {uploaded, size}`, `413` if too big |
| GET | `/download/<name>` | the file, as an attachment |
| DELETE | `/files/<name>` | `204`, or `404` |

Errors are JSON: `{"error": "message"}`.

## How data is stored

- Local: `DATA_DIR/files/<user>/<file>` and `DATA_DIR/users.json` (passwords hashed with scrypt).
- MinIO: objects `files/<user>/<file>` and `_system/users.json` in the bucket.

Accounts are stored next to the files on purpose: on an **emptyDir** volume, deleting the pod
loses the accounts too, and the game shows "ACCOUNT LOST". On a **PVC** or **MinIO** they survive.

## Notes

- Runs one gunicorn worker with 8 threads, so the in-process locks cover every request.
  With several replicas on MinIO, two sign-ups at the same instant could race — a real database would fix that.
- Use HTTPS (an Ingress with TLS) anywhere other than your own machine: passwords are sent in the login request.
- A ReadWriteOnce PVC needs `replicas: 1` and `strategy: Recreate` (the manifests use both).
- The official `minio/minio` images are no longer published, so `k8s/minio/` uses
  `pgsty/minio`, the community-maintained build of the same server.
