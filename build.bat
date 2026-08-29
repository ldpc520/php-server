@echo off
REM 构建并推送镜像到 Docker Hub (ken01982/php-server)
REM 使用前请先: docker login
set IMAGE=ken01982/php-server

echo [1/2] 构建镜像...
docker build -t %IMAGE%:latest .

echo [2/2] 推送到 Docker Hub...
docker push %IMAGE%:latest

echo 完成。可运行: docker run -p 5000:5000 %IMAGE%:latest
pause
