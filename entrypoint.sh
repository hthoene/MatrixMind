#!/bin/sh
# Fix ownership of the mounted workspaces volume so uid 1001 can write to it,
# then drop privileges and exec the actual process.
chown -R matrixmind:matrixmind /app/workspaces
exec su-exec matrixmind "$@"
