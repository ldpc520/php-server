@echo off
REM 构建并推送镜像到 Docker Hub (ken01982/php-server)
REM 使用前请先: docker login
set IMAGE=ken01982/php-server
set /p VER=<VERSION
if "%VER%"=="" set VER=dev

echo [1/2] 构建镜像 (版本 v%VER%)...
docker build --build-arg APP_VERSION=%VER% -t %IMAGE%:v%VER% -t %IMAGE%:latest .

echo [2/2] 推送到 Docker Hub...
docker push %IMAGE%:v%VER%
docker push %IMAGE%:latest

echo 完成。可运行: docker run -p 5000:5000 %IMAGE%:v%VER%
pause
