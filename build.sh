#!/usr/bin/env bash
# 构建并推送镜像到 Docker Hub (ken01982/php-server)
# 使用前请先: docker login
set -e
IMAGE=ken01982/php-server
VER="$(cat VERSION 2>/dev/null | tr -d '[:space:]')"
: "${VER:=dev}"

echo "[1/2] 构建镜像 (版本 v$VER)..."
docker build --build-arg "APP_VERSION=$VER" -t "$IMAGE:v$VER" -t "$IMAGE:latest" .

echo "[2/2] 推送到 Docker Hub..."
docker push "$IMAGE:v$VER"
docker push "$IMAGE:latest"

echo "完成。可运行: docker run -p 5000:5000 $IMAGE:v$VER"
