#!/bin/bash
export ENABLE_REMARK42=false
export DEPLOY_PORT=8015
exec "$(dirname "$0")/rebuild.sh" "$@"
