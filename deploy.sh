#!/usr/bin/env bash
# 服务器一键部署: 拉最新代码 -> 构建并双 tag 推送 -> 按原挂载/端口重建容器
# 用法:  bash deploy.sh [仓库目录]   (默认当前目录)
# 依赖: 已 docker login；已 git remote 配置好 origin
set -e

IMAGE=ken01982/php-server
NAME=php-server
REPO_DIR="${1:-.}"
cd "$REPO_DIR"

echo "[1/4] git pull origin main"
git pull origin main

VER="$(cat VERSION 2>/dev/null | tr -d '[:space:]')"
: "${VER:=dev}"
echo "[2/4] 构建并推送镜像 v$VER"
docker build --build-arg "APP_VERSION=$VER" -t "$IMAGE:v$VER" -t "$IMAGE:latest" .
docker push "$IMAGE:v$VER"
docker push "$IMAGE:latest"

echo "[3/4] 重建容器 $NAME (保留原挂载与端口)"
if docker inspect "$NAME" >/dev/null 2>&1; then
  # 提取已有 bind 挂载: --volume <源>:<目标>
  MOUNTS=$(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}--volume {{.Source}}:{{.Destination}} {{end}}{{end}}' "$NAME")
  # 提取容器端口与宿主机映射端口 (取第一个 tcp 映射)
  PORT=$(docker inspect -f '{{range $p,$c := .NetworkSettings.Ports}}{{if $c}}{{$p}}{{end}}{{end}}' "$NAME" | head -1 | cut -d/ -f1)
  HOSTPORT=$(docker inspect -f '{{range $p,$c := .NetworkSettings.Ports}}{{if $c}}{{(index $c 0).HostPort}}{{end}}{{end}}' "$NAME" | head -1)
  docker stop "$NAME" >/dev/null
  docker rm "$NAME" >/dev/null
  docker run -d --name "$NAME" --restart unless-stopped ${MOUNTS} -p "${HOSTPORT}:${PORT}" "$IMAGE:v$VER"
else
  echo "容器 $NAME 不存在，请手动启动:"
  echo "  docker run -d --name $NAME --restart unless-stopped -p 5000:5000 -v /你的/www:/www -v /你的/data:/data $IMAGE:v$VER"
fi

echo "[4/4] 完成。容器版本应显示 v$VER (VERSION 文件优先, 不再 vdev)"
docker ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
