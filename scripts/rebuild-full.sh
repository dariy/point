#!/bin/bash
export ENABLE_REMARK42=true
export DEPLOY_PORT=8005
exec "$(dirname "$0")/rebuild.sh" "$@"
