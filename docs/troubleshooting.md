# Troubleshooting

## Database Issues

### "failed to create session" / "attempt to write a readonly database"

**Problem:**
When attempting to log in or perform actions that require writing to the database (like session creation), the API returns a `500 Internal Server Error` with the message `failed to create session`. Logs show `attempt to write a readonly database (8)`.

**Root Cause:**
This is typically a file permission issue where the application process (running as `appuser` with UID 1000 inside the container) does not have write access to the SQLite database file or the directory containing it (`/data`). This often happens after a fresh deployment or when volumes are mounted with `root` ownership.

**Solution:**
Ensure the `/data` directory and all files within it are owned by the user running the application.

Execute the following command on the host (where `point-container` is the container name):

```bash
podman exec -u root point-container chown -R appuser:appuser /data
```

After fixing permissions, it is recommended to restart the container:

```bash
podman restart point-container
```

**Prevention:**
Ensure the deployment scripts or Dockerfile set the correct permissions during the build or initialization phase, especially when using rootless Podman where UID mapping can sometimes lead to unexpected ownership on the host vs container.
