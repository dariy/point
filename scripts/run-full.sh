#!/bin/bash
export ENABLE_REMARK42=true
exec "$(dirname "$0")/run.sh" "$@"
