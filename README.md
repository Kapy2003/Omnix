# Omnix — 3-Tier Web Application with CI/CD

Minimal 3-tier task tracker designed for AWS deployment via GitHub Actions:

- **Tier 1 (Frontend):** `frontend/index.html` on private **S3** served via **CloudFront** (OAC)
- **Tier 2 (Backend):** `backend/server.js` (Node.js + Express) on **EC2** managed by `systemd`
- **Tier 3 (Database):** **AWS RDS PostgreSQL** inside the VPC, reachable only from EC2
- **CI/CD:** `.github/workflows/deploy.yml` runs tests against a real PostgreSQL container, syncs `frontend/` to S3 + invalidates CloudFront, and deploys `backend/` to EC2 via `rsync` + `ssh`

CloudFront routes `/*` to S3 and `/api/*` to EC2 port `3000`, so the browser stays same-origin over HTTPS with no mixed-content errors or EC2 SSL certs.

---

## Local Development & Tests

Run unit tests (no database required):
```bash
cd backend
npm install
npm test
```

Run full stack locally (with a local Postgres instance):
```bash
cd backend
cp .env.example .env   # edit DATABASE_URL
npm start
```
In a second terminal, serve the frontend:
```bash
python -m http.server 8080 -d frontend
```
Open `http://localhost:8080`.

---

## AWS Setup Checklist (One-Time)

### 1. Security Groups (same VPC)
1. **`omnix-ec2-sg`** (for EC2):
   - Inbound TCP `22` from `0.0.0.0/0` (key-only auth for GitHub Actions SSH deploy)
   - Inbound TCP `3000` from the CloudFront managed prefix list (`com.amazonaws.global.cloudfront.origin-facing`)
2. **`omnix-rds-sg`** (for RDS):
   - Inbound TCP `5432` **Source: `omnix-ec2-sg`** (never `0.0.0.0/0`)

### 2. Tier 3 — RDS PostgreSQL
1. Create a **PostgreSQL 16** database using the **Free tier** template (`db.t3.micro` or `db.t4g.micro`).
2. **Public access:** `No`.
3. **VPC security group:** `omnix-rds-sg`.
4. Under **Additional configuration**, set **Initial database name** to `omnix`.
5. Note the endpoint, master username, and password.

### 3. Tier 2 — EC2 Instance
1. Launch **Debian 12+ or Ubuntu 24.04 LTS** (`t2.micro` or `t3.micro`, Free Tier) with a `.pem` key pair and `omnix-ec2-sg`.
2. SSH in and run the bootstrap script once (paste or copy `infra/setup-ec2.sh`):
   ```bash
   sudo bash setup-ec2.sh
   ```
3. Edit `/opt/omnix/.env` with your RDS connection string:
   ```dotenv
   DATABASE_URL=postgres://<user>:<password>@<rds-endpoint>:5432/omnix
   ```

### 4. Tier 1 — Private S3 + CloudFront
1. Create an **S3 bucket** with **Block all public access = ON** (Static website hosting **OFF**).
2. Create a **CloudFront distribution**:
   - **Origin 1 (S3):** Select your bucket, choose **Origin access control (OAC)**, set **Default root object** to `index.html`, and apply the generated bucket policy to S3.
   - **Origin 2 (EC2):** Enter your EC2 **Public IPv4 DNS**, Protocol `HTTP only`, HTTP port `3000`.
   - **Behavior `/api/*`:** Origin = EC2, Viewer protocol = `Redirect HTTP to HTTPS`, Allowed HTTP methods = `GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE`, Cache policy = `CachingDisabled`, Origin request policy = `AllViewer`.
   - **Default Behavior (`*`):** Origin = S3, Viewer protocol = `Redirect HTTP to HTTPS`, Cache policy = `CachingOptimized`.

### 5. GitHub Actions Secrets
In your GitHub repo (`Settings -> Secrets and variables -> Actions`), add:

| Secret | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM deploy user access key (S3 + CloudFront permissions) |
| `AWS_SECRET_ACCESS_KEY` | IAM deploy user secret key |
| `AWS_REGION` | Optional; defaults to `us-east-1` |
| `S3_BUCKET_NAME` | Target S3 bucket name |
| `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront distribution ID (e.g. `E1234567890ABC`) |
| `EC2_HOST` | EC2 Public IPv4 DNS or Elastic IP |
| `EC2_USER` | Optional; defaults to `ubuntu` (`admin` for Debian, `ec2-user` for Amazon Linux) |
| `EC2_SSH_KEY` | Full contents of your EC2 `.pem` private key |

Push to `main` to trigger the full test + deploy pipeline.

