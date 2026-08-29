# php-server · 简易 PHP 服务器 / 文件管理器

基于 **Python + Flask** 的轻量级 PHP 运行环境与文件管理器，界面仿 **宝塔面板** 风格（绿色主题）。
通过 `php-cgi` 以 CGI 模式真实执行 PHP（兼容 PHP 7.0+），并提供完整的文件管理（新建 / 上传 / 下载 / 编辑 / 删除 / 重命名 / 复制 / 移动）。

> 已打包为 Docker 镜像，可一键部署：`ken01982/php-server`

---

## 功能

- **文件管理**：新建文件/文件夹、上传（文件+文件夹）、下载（多选打包 zip）、在线代码编辑、删除、重命名、复制、剪切、粘贴、移动；列表/网格双视图、面包屑、多选、右键菜单。
- **PHP 执行**：CGI 模式调用 `php-cgi` 真实运行 `.php`，正确解析 `Status` / `Set-Cookie` / `Content-Type` 等响应头。
- **静态部署**：HTML/CSS/JS/图片等直接服务；目录默认首页优先级为 `index.html` → `index.php` → `index.htm`。
- **宝塔风格 UI**：绿色主调、左侧目录树、顶层「重启」按钮、下拉式工具栏（新建 / 上传下载）。
- **跨平台**：Windows（php-cgi.exe）、Linux、Docker（容器内 `/usr/bin/php-cgi`）均自动探测。
- **登录验证**：首次打开需创建管理员账号，之后所有页面与接口均需登录；账号数据持久化，重启不丢失。
- **数据持久化**：文档根 `/www` 通过 Docker 卷持久化，上传/修改的文件在重启、重建容器、重拉镜像后都不丢失。

---

## 目录结构

```
php-server/
├── app.py                 # Flask 主程序（路由 + PHP 执行引擎）
├── config.py              # 配置与 php-cgi 自动探测（跨平台）
├── requirements.txt       # Python 依赖（Flask）
├── start_server.bat       # Windows 一键启动
├── entrypoint.sh          # 容器入口：首次空卷时初始化默认站点
├── templates/             # 页面模板
├── static/                # 前端 CSS / JS
├── www/                   # 文档根（部署的站点文件，含宝塔风格默认 index.html）
├── Dockerfile             # Docker 镜像构建
├── docker-compose.yml     # 本地编排（命名卷持久化）
├── .github/workflows/     # 推送 GitHub 后自动构建并推送 Docker Hub
└── build.bat / build.sh   # 本地手动构建推送脚本
```

---

## 快速开始（Docker）

```bash
# 方式一：docker run（命名卷 php_www 持久化 /www）
docker run -d -p 5000:5000 -v php_www:/www --name php-server ken01982/php-server:latest

# 方式二：docker compose（已内置命名卷 php_www）
docker compose up -d
```

访问：
- 文件管理器界面：`http://localhost:5000/`
- 站点根目录（默认显示宝塔风格 `index.html`）：`http://localhost:5000/`
- 运行 PHP（如 `www/央视频.php`）：`http://localhost:5000/央视频.php?id=cctv1`

> **首次访问需初始化账号**：打开 `http://localhost:5000/` 会跳转到创建账号页，设置用户名/密码（密码 ≥ 6 位）后进入；之后每次访问需登录。账号保存在 `data/auth.json`（Docker 中为卷 `php_data`），重启服务不丢失。

### 数据持久化说明（重要）
- 上传/编辑的文件保存在卷 `php_www` 中，**容器重启（`docker restart`）、重建（`docker compose up`）、重拉镜像都不会丢失**。
- 只有显式删除卷才会清空数据：
  ```bash
  docker compose down -v      # 删除容器并删除卷（数据清空）
  # 或仅删卷：
  docker volume rm php_www
  ```
- 首次启动卷为空时，容器会自动把内置默认站点（含 `index.html`）复制进卷；之后以卷内文件为准。

---

## 本地运行（Windows）

1. 安装 PHP（需含 `php-cgi.exe`），例如 `C:\php-8.3.31-nts-Win32-vs16-x64`
2. 创建虚拟环境并安装依赖：
   ```bat
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   ```
3. 启动（指定 php-cgi 路径，默认会自动探测常见位置）：
   ```bat
   set PHP_CGI=C:\php-8.3.31-nts-Win32-vs16-x64\php-cgi.exe
   .venv\Scripts\python.exe app.py
   ```
   或直接双击 `start_server.bat`。

---

## 构建并推送到 Docker Hub

镜像名：`ken01982/php-server`

### 方式一：GitHub Actions 自动构建（推荐）

把本仓库推送到 GitHub（`ken01982/php-server`）后，每次 push 到 `main`/`master` 会自动构建并推送到 Docker Hub。

在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 中添加：

| Name | Value |
|------|-------|
| `DOCKERHUB_USERNAME` | `ken01982` |
| `DOCKERHUB_TOKEN` | 你的 Docker Hub **访问令牌**（Account Settings → Security → Access Tokens，不要用密码） |

> 推送标签 `v1.0.0` 时还会生成对应版本标签镜像；默认分支推送生成 `latest`。

### 方式二：本地手动构建推送

```bat
# Windows：先 docker login，再
build.bat

# Linux / macOS：
chmod +x build.sh
./build.sh
```

---
### 方式三：以ComPose构建，以飞牛为例
```
version: "3.8"

services:
  php-server:
    image: ken01982/php-server:latest
    container_name: php-server
    ports:
      - "5000:5000"
    volumes:
      - /vol1/1000/docker/php-server/www:/www
    restart: unless-stopped
```


---
## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PHP_CGI` | 自动探测 | php-cgi 可执行文件路径 |
| `PHP_SERVER_DOCROOT` | `./www` | 文档根目录 |
| `PHP_SERVER_HOST` | `0.0.0.0` | 监听地址 |
| `PHP_SERVER_PORT` | `5000` | 监听端口 |
| `AUTH_DIR` | `./data` | 账号数据目录（存 `auth.json` / `secret.key`）；Docker 建议挂卷到 `/data` |

---

## 说明

- `www/` 内已附带宝塔风格默认 `index.html`、`index.php`、`phpinfo.php`；你可放置自己的站点文件（如 `央视频.php`）。
- 根目录默认优先显示 `index.html`（宝塔风格默认页）；若存在 `index.php` 仍可通过 `/index.php` 访问，部署 PHP 站点时建议把入口命名为 `index.php`。
- Docker 镜像基于 `python:3.11-slim`，通过 `apt` 安装 `php-cgi`（Debian 自带 PHP 8.2，兼容 PHP 7.0+ 写法）。
