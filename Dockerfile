# 简易 PHP 服务器 / 文件管理器
# 基于 Debian 的 python:3.11-slim，通过 apt 安装 php-cgi 及常用扩展
FROM python:3.11-slim

LABEL org.opencontainers.image.title="php-server" \
      org.opencontainers.image.description="Flask + php-cgi 的简易 PHP 服务器 / 文件管理器 (宝塔风格 UI)" \
      org.opencontainers.image.source="https://github.com/ken01982/php-server" \
      maintainer="ken01982"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

# 通过 Sury 源(deb.sury.org)安装多版本 PHP-CGI
# Debian 主仓库只含单一默认版本(Bookworm=8.2 / Trixie=8.4)，无法多版本共存
# Sury 维护 7.4 ~ 8.4 全系列；默认 php-cgi 指向 8.4
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates apt-transport-https lsb-release gnupg curl; \
    curl -fsSLo /tmp/debsuryorg-archive-keyring.deb \
        https://packages.sury.org/debsuryorg-archive-keyring.deb; \
    dpkg -i /tmp/debsuryorg-archive-keyring.deb; \
    echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" \
        > /etc/apt/sources.list.d/php.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        php8.4-cgi php8.4-curl php8.4-mbstring php8.4-xml php8.4-zip php8.4-gd \
        php8.4-sqlite3 php8.4-mysql php8.4-intl php8.4-bcmath \
        php7.4-cgi php7.4-curl php7.4-mbstring php7.4-xml php7.4-zip php7.4-gd \
        php7.4-sqlite3 php7.4-mysql php7.4-intl php7.4-bcmath; \
    update-alternatives --set php-cgi /usr/bin/php-cgi8.4 || true; \
    rm -rf /var/lib/apt/lists/* /tmp/debsuryorg-archive-keyring.deb

# 关闭 php-cgi 启动期错误输出，避免污染 CGI 响应头
RUN mkdir -p /etc/php \
    && for v in /etc/php/*/cgi; do \
         mkdir -p "$v/conf.d"; \
         printf 'display_errors=Off\nlog_errors=On\n' > "$v/conf.d/zz-phpserver.ini"; \
       done

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 保留一份“出厂默认站点”，供持久化卷首次为空时初始化（entrypoint 使用）
RUN cp -a /app/www /app/www_default

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 运行时环境变量（可用 -e 覆盖）
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION \
    PHP_SERVER_DOCROOT=/www \
    PHP_CGI=/usr/bin/php-cgi \
    PHP_SERVER_HOST=0.0.0.0 \
    PHP_SERVER_PORT=5000

EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "app.py"]
