#!/bin/bash
export ENABLE_REMARK42=false
exec "$(dirname "$0")/run.sh" "$@"
