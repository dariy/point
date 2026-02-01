# Deployment Pipeline Fix - Old Image Issue

**Date**: 2026-02-01
**Issue**: Deployment pipeline was deploying old Docker images instead of newly built ones
**Status**: ✅ Fixed

## Problem Summary

The deployment pipeline was deploying outdated Docker images, causing old files to appear in the running container even after successful builds and deployments.

## Root Causes

### 0. CPU Resource Limits Too High (Discovered during deployment)
**Location**: `docker-compose.prod.yml` lines 59-66
**Issue**: The production compose file had CPU limits set to `2` CPUs, but the production server only has 1 CPU available. This caused docker-compose to fail with "range of CPUs is from 0.01 to 1.00, as there are only 1 CPUs available". Since the container failed to recreate, the old container kept running.

**Fix**: Adjusted CPU limits to work with single-core servers:
```yaml
resources:
  limits:
    cpus: '0.95'  # Changed from '2'
    memory: 2G
  reservations:
    cpus: '0.25'  # Changed from '0.5'
    memory: 512M
```

### 1. Environment Variable Precedence (Discovered during deployment)
**Location**: `.github/workflows/deploy.yml` line 141
**Issue**: The SSH action exports `IMAGE_TAG` as an environment variable with the full commit SHA. When `docker-compose` runs, environment variables take precedence over `.env` file values. So even though we wrote the truncated SHA to `.env`, docker-compose used the full SHA from the environment, causing a "manifest unknown" error because that tag doesn't exist.

**Fix**: Export the truncated IMAGE_TAG to override the environment variable before running docker-compose:
```bash
export IMAGE_TAG=${IMAGE_TAG:0:7}
```

### 2. Missing Job Output Declaration
**Location**: `.github/workflows/deploy.yml` line 49-106
**Issue**: The `build` job generated a `version` output in the `steps.version.outputs.version` variable, but this was never declared as a job-level output. When the `deploy` job tried to reference it, the variable was empty.

**Fix**: Added `outputs:` section to the `build` job:
```yaml
outputs:
  version: ${{ steps.version.outputs.version }}
  image_sha_tag: ${{ steps.meta.outputs.tags }}
```

### 3. Hard-coded Image Tag
**Location**: `.github/workflows/deploy.yml` line 158
**Issue**: The deployment script always pulled `ghcr.io/dariy/point:latest` regardless of what was actually built. This meant:
- If the `:latest` tag wasn't updated in the registry, old images would be pulled
- No guarantee the deployed image matched the current commit
- No way to track which specific version was deployed

**Fix**: Changed to pull specific SHA-based tag:
```bash
docker pull ghcr.io/dariy/point:${IMAGE_TAG:0:7}
```

### 4. Missing IMAGE_TAG Environment Variable
**Location**: `.github/workflows/deploy.yml` line 131-141
**Issue**: The `docker-compose.prod.yml` file expects an `IMAGE_TAG` environment variable (line 6), but this was never set during deployment, causing it to fall back to `:latest`.

**Fix**: Added `IMAGE_TAG` to environment variables:
```yaml
env:
  BUILD_VERSION: ${{ needs.build.outputs.version }}
  IMAGE_TAG: ${{ github.sha }}
```

### 5. Ineffective sed Commands
**Location**: `.github/workflows/deploy.yml` lines 161-162
**Issue**: The sed commands tried to replace image names containing "photo-blog", but the actual image name is "point", so they never matched anything.

**Fix**: Removed these ineffective commands and instead:
- Set `IMAGE_TAG` in the `.env` file
- Use `docker-compose.prod.yml` which already has proper variable substitution
- Explicitly specify the compose file: `docker compose -f docker-compose.prod.yml up -d blog`

### 6. No Deployment Verification
**Issue**: There was no verification that the correct image was actually deployed and running.

**Fix**: Added verification step:
```bash
# Verify correct image is running
DEPLOYED_IMAGE=$(docker inspect photo-blog-prod --format='{{.Config.Image}}')
if [[ ! "${DEPLOYED_IMAGE}" =~ ${IMAGE_TAG:0:7} ]]; then
  echo "ERROR: Deployed image tag does not match expected tag!"
  exit 1
fi
```

## Changes Made

### 1. `.github/workflows/deploy.yml`
- ✅ Added job-level outputs to `build` job (lines 55-57)
- ✅ Changed deploy job to use `needs.build.outputs.version` (line 134)
- ✅ Added `IMAGE_TAG` environment variable (line 135)
- ✅ Updated `envs` to include both variables (line 141)
- ✅ Set `IMAGE_TAG` in `.env` file (lines 153, 155, 158)
- ✅ Changed to pull specific SHA tag instead of `latest` (line 166)
- ✅ Added local tagging of pulled image as `latest` (line 169)
- ✅ **Export truncated IMAGE_TAG to override environment** (lines 172-173) - Critical fix!
- ✅ Specified production compose file explicitly (line 183)
- ✅ Added deployment verification (lines 185-196)
- ✅ Updated deployment summary to include image tag (lines 231-232)

### 2. `scripts/verify-deployment.sh` (New File)
- ✅ Created verification script for manual deployment checking
- Shows container name, image, version, and health status
- Can be run on the server to verify which version is deployed

### 3. `docker-compose.prod.yml`
- ✅ Reduced CPU limit from '2' to '0.95' for single-core servers (line 62)
- ✅ Reduced CPU reservation from '0.5' to '0.25' (line 65)

## How It Works Now

1. **Build Phase**:
   - Builds Docker image with multiple tags including SHA-based tag (`${sha:0:7}`)
   - Exports `version` and `image_sha_tag` as job outputs

2. **Deploy Phase**:
   - Receives build version and commit SHA from build job
   - Sets both `APP_VERSION` and `IMAGE_TAG` in `.env` file
   - Pulls specific image by SHA tag: `ghcr.io/dariy/point:${IMAGE_TAG:0:7}`
   - Tags pulled image as `latest` locally
   - **Exports truncated IMAGE_TAG to override environment variable** (critical!)
   - Uses `docker-compose.prod.yml` which respects `IMAGE_TAG` variable
   - Verifies the deployed container is running the correct image
   - Fails deployment if image mismatch detected

3. **Verification**:
   - Automatic: Pipeline verifies image tag matches expected SHA
   - Manual: Run `./scripts/verify-deployment.sh` on server

## Testing the Fix

### On Next Deployment
The pipeline will now:
1. Build image with tag matching commit SHA (first 7 chars)
2. Pull that specific tag during deployment
3. Verify the running container uses that exact image
4. Display full image information in deployment summary

### Manual Verification
On the production server:
```bash
cd /opt/photo-blog
./scripts/verify-deployment.sh
```

This will show:
- Container name and status
- Exact image being used
- APP_VERSION from environment
- IMAGE_TAG from `.env` file
- Health check status

### Checking Deployed Version
```bash
# Check running container image
docker inspect photo-blog-prod --format='{{.Config.Image}}'

# Check environment variables
docker exec photo-blog-prod printenv APP_VERSION
docker exec photo-blog-prod printenv IMAGE_TAG

# Check .env file
cat .env | grep -E "(APP_VERSION|IMAGE_TAG)"
```

## Prevention

To prevent this issue in the future:

1. **Always use specific tags**: Never rely solely on `:latest` tag in production
2. **Verify deployments**: Always check that deployed image matches expected version
3. **Use SHA tags**: Commit SHAs provide deterministic, immutable references
4. **Test pipelines**: Test deployment pipeline changes in staging environment first
5. **Monitor deployments**: Review deployment logs and summaries after each deployment

## Related Files

- `.github/workflows/deploy.yml` - Main deployment pipeline
- `docker-compose.prod.yml` - Production compose configuration
- `scripts/verify-deployment.sh` - Manual verification script

## Additional Notes

### Why SHA Tags?
Using the first 7 characters of the commit SHA as the image tag provides:
- **Determinism**: Same commit always uses same image
- **Traceability**: Easy to map running container to source code commit
- **Immutability**: SHA-based tags can't be accidentally overwritten
- **Debugging**: Can quickly identify which code version is running

### Image Tag Strategy
The pipeline now creates multiple tags for each build:
- `sha:7chars` - Primary deployment tag (e.g., `b0565bd`)
- `main` - Branch-based tag
- `latest` - Latest build on main branch

For deployment, we use the SHA tag for determinism, then locally tag it as `latest` for convenience.

### Docker Compose Environment Variable Precedence
**Important**: Docker Compose prioritizes environment variables over `.env` file values. In our deployment:
1. SSH action exports `IMAGE_TAG` with full SHA (e.g., `2325b3a56437c1afd927b74016776b56a8cce7cf`)
2. We write truncated SHA to `.env` file (e.g., `IMAGE_TAG=2325b3a`)
3. Without the `export`, docker-compose would use the full SHA from environment
4. Full SHA tag doesn't exist in registry → "manifest unknown" error
5. **Solution**: `export IMAGE_TAG=${IMAGE_TAG:0:7}` to override the environment variable

This is why the explicit export after pulling the image is critical for the deployment to work.

### Rollback Procedure
If you need to rollback to a previous version:
```bash
# Find previous commit SHA
git log --oneline

# Set IMAGE_TAG to previous commit
export IMAGE_TAG=<previous-commit-sha>
docker pull ghcr.io/dariy/point:${IMAGE_TAG:0:7}
docker tag ghcr.io/dariy/point:${IMAGE_TAG:0:7} ghcr.io/dariy/point:latest

# Update .env
echo "IMAGE_TAG=${IMAGE_TAG:0:7}" >> .env

# Redeploy
docker compose -f docker-compose.prod.yml up -d blog
```
