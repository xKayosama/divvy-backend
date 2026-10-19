# Backend deployment

The Dockerfile packages Node 24, production npm dependencies and Poppler for PDF
receipts. It runs as the unprivileged `node` user. No environment files, tests,
design assets, or Git history are included in the build context. No cloud service
or database is created by this configuration.

## Prepare a staging environment

1. Provision a separate managed MongoDB database with a dedicated least-privilege
   database user, encrypted connections, restricted network access and backups.
   Verify restoration before accepting real data. Do not reuse the local database
   or its QA accounts. MongoDB must be reachable from the container; localhost
   inside a container refers to that container.
2. Copy `.env.production.example` to `.env.production` and restrict its file
   permissions (`chmod 600 .env.production`). Set MONGO_URI and a fresh JWT_SECRET
   generated with a password manager or `openssl rand -hex 48`. Keep the secret in
   your hosting provider's secret manager for cloud deployments; never use build
   arguments or commit secrets. JWT rotation signs everyone out.
3. Run `npm ci`, `npm test`, and `npm audit --omit=dev` before building. Build with
   `docker compose build --pull`, then start with `docker compose up -d`.
4. Check `docker compose ps`, `docker compose logs --tail=100 api`, and
   `curl --fail http://127.0.0.1:5002/api/ready`. The Compose port is deliberately
   separate from the existing local backend on 5001. Stop with
   `docker compose down`; this does not delete the external database.

Compose provides a single-host baseline. It binds only to loopback for an HTTPS
reverse proxy on the same host. Configure the proxy to forward to port 5002 and
use a publicly trusted TLS certificate. On managed container hosting, use the
Dockerfile directly, inject environment variables at runtime, route traffic to
the configured PORT, and set readiness to `/api/ready` and liveness to
`/api/health`. Allow at least 15 seconds for shutdown and 60 seconds for startup.
The Docker health check marks a container unhealthy; Docker Compose does not
automatically restart a still-running unhealthy process. Monitor and alert on it.

## Before opening access to testers

- Configure client IP handling for the chosen proxy topology. The app currently
  leaves Express proxy trust disabled. Behind a proxy, its authentication quota
  therefore applies to the proxy IP, not individual users. Add narrowly scoped
  trusted proxy configuration and verify spoofed forwarding headers cannot bypass
  limits, or enforce per-client authentication limits at the trusted gateway.
  Do not enable blanket `trust proxy=true`.
- Start with one always-on API instance. The recurring bill timer needs a running
  process; do not deploy this entry point as a request-only serverless function or
  enable idle scale-to-zero. Authentication and OCR limits are process-local;
  add a shared store or gateway limits before horizontal scaling.
- The Compose allocation is a starting budget of 2 CPUs and 3 GB memory. OCR allows
  four concurrent scans per process and has a 60-second deadline. Load-test real
  JPEG and PDF receipts, watch memory/CPU, and tune capacity before inviting users.
  `/tmp` is transient and bounded; uploads are not durable attachments. The mobile
  API timeout is currently 15 seconds, so test its behavior on slow OCR requests.
- Verify database indexes, including unique recurring occurrences and settlement
  claims, exist in the target database. For legacy data, back up and follow the
  README's group migration dry run/apply procedure before exposing traffic.
- Verify sign-in/logout, expense creation, repayment, recurring bill generation,
  PDF receipt scanning, restart persistence, and database outage readiness against
  staging. Configure centralized logs and uptime/error alerts.
- Set the mobile EXPO_PUBLIC_API_URL to the HTTPS endpoint including `/api` and
  create a new build/update as appropriate for the release process.

## Releases and rollback

Build and publish immutable image tags (for example a Git commit SHA), and retain
the previous successful tag. Rebuild regularly with `--pull` for base-image and
OS patches; commit npm lockfile updates separately. Record the deployed tag and
database migration state. Roll back by redeploying the prior image with the same
runtime secrets; restore databases only through a reviewed recovery procedure.

References: [Docker Node guide](https://docs.docker.com/guides/nodejs/),
[Express health and shutdown](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown/).
