#!/bin/sh
# 容器入口：仅当持久化卷 /www 为空时，把内置默认站点复制进去。
# 之后用户上传/修改的文件都在卷中，重启、重建容器、重拉镜像都不会丢失。
set -e

if [ -z "$(ls -A /www 2>/dev/null)" ]; then
  echo "[entrypoint] /www 为空，初始化默认站点…"
  cp -a /app/www_default/. /www/
fi

exec "$@"
