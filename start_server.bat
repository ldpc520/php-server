@echo off
cd /d "%~dp0"
REM 如需自定义 PHP，可修改下面这行（也可设置环境变量 PHP_CGI）
set PHP_CGI=C:\php-8.3.31-nts-Win32-vs16-x64\php-cgi.exe
REM 文档根目录可用 PHP_SERVER_DOCROOT 覆盖；端口用 PHP_SERVER_PORT
REM set PHP_SERVER_DOCROOT=D:\wwwroot
REM set PHP_SERVER_PORT=8080
.venv\Scripts\python.exe app.py
pause
